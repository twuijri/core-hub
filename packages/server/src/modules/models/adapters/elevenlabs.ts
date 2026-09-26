/**
 * ElevenLabs (text to speech and Scribe speech to text), from its public API reference:
 *
 * - every request carries `xi-api-key`;
 * - `GET /v2/voices` (pages of up to 100, `next_page_token`) is the account's voice list —
 *   its own and the ones it added from the library — with `labels` (gender, accent,
 *   language) and `verified_languages`; `GET /v1/voices` answers where `/v2` does not;
 * - `GET /v1/models` lists the text-to-speech models (`can_do_text_to_speech`, `languages`);
 * - `POST /v1/text-to-speech/{voice_id}` answers the audio;
 * - `POST /v1/speech-to-text` takes the recording as `file` with `model_id` (Scribe) and an
 *   optional `language_code`, and answers `text`, `language_code`, `audio_duration_secs`.
 *   Scribe has no model list endpoint, so its documented list answers (decision §87).
 */
import {
  detailOf,
  joinUrl,
  reasonOf,
  requestBytes,
  requestForm,
  requestJson,
  synthesisFailure,
} from './http.js';
import { documentedModels } from '../speech/documented.js';
import { chatUnsupported } from './types.js';
import type {
  ChatEvent,
  DiscoveredVoice,
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
} from './types.js';

/** The pages of `/v2/voices` asked at most: 1 000 voices is past any account's list. */
const MAX_VOICE_PAGES = 10;

interface ElevenVoice {
  voice_id?: unknown;
  name?: unknown;
  labels?: unknown;
  description?: unknown;
  verified_languages?: { language?: unknown; locale?: unknown }[] | null;
}

function voiceOf(item: ElevenVoice): DiscoveredVoice | null {
  const id = typeof item?.voice_id === 'string' ? item.voice_id : null;
  if (!id) return null;
  const labels = (item.labels ?? {}) as { language?: unknown; accent?: unknown };
  const verified = Array.isArray(item.verified_languages) ? item.verified_languages : [];
  const firstVerified = verified.find((entry) => typeof entry?.locale === 'string')?.locale;
  const language =
    typeof labels.language === 'string'
      ? labels.language
      : typeof firstVerified === 'string'
        ? firstVerified
        : null;
  return {
    id,
    name: typeof item.name === 'string' && item.name ? item.name : id,
    language,
    gender: genderOf(item.labels),
    ...(typeof labels.accent === 'string' ? { description: labels.accent } : {}),
  };
}

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { 'xi-api-key': ctx.apiKey } : {}),
    ...ctx.headers,
  };
}

function genderOf(labels: unknown): DiscoveredVoice['gender'] {
  const value = (labels as { gender?: unknown } | null)?.gender;
  if (value === 'female' || value === 'male' || value === 'neutral') return value;
  return null;
}

export const elevenLabsAdapter: ElevenLabsAdapter = {
  protocol: 'elevenlabs',

  // A speech provider has no chat surface; the `direct` agent says so rather than
  // posting a turn to an endpoint that was never going to answer with words.
  chat(): AsyncIterable<ChatEvent> {
    return chatUnsupported('this provider speaks; it does not answer');
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!ctx.apiKey) {
      return { ok: false, reason: 'no_key', detail: null, status: null, durationMs: 0 };
    }
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'voices'),
      headers: headers(ctx),
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    return {
      ok: answer.ok,
      reason: reasonOf(answer),
      detail: answer.ok ? null : detailOf(answer),
      status: answer.status,
      durationMs: answer.durationMs,
    };
  },

  async listModels(ctx: ProviderContext): Promise<ListModelsResult> {
    // Scribe (speech to text) has no model endpoint: its documented list (decision §87).
    const documented = documentedModels(ctx.slug);
    if (documented) return documented;
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'models'),
      headers: headers(ctx),
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
    if (!Array.isArray(answer.body)) {
      return { supported: false, reason: 'the provider did not answer with a model list' };
    }
    const models = (
      answer.body as { model_id?: unknown; name?: unknown; can_do_text_to_speech?: unknown }[]
    )
      .filter((item) => typeof item?.model_id === 'string' && item.can_do_text_to_speech !== false)
      .map((item) => ({
        key: item.model_id as string,
        label: typeof item.name === 'string' && item.name ? item.name : (item.model_id as string),
        kind: 'tts' as const,
      }));
    return { supported: true, models };
  },

  async listVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const v2 = joinUrl(ctx.baseUrl.replace(/\/v1\/?$/, '/v2'), 'voices');
    const voices: DiscoveredVoice[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_VOICE_PAGES; page += 1) {
      const query = new URLSearchParams({ page_size: '100' });
      if (token) query.set('next_page_token', token);
      const answer = await requestJson({
        url: `${v2}?${query.toString()}`,
        headers: headers(ctx),
        fetchImpl: ctx.fetchImpl,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      });
      // An account or a proxy without `/v2` still has the older list.
      if (page === 0 && answer.status === 404) return elevenLabsAdapter.legacyVoices(ctx);
      if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
      const body = answer.body as {
        voices?: ElevenVoice[];
        has_more?: unknown;
        next_page_token?: unknown;
      } | null;
      if (!Array.isArray(body?.voices)) {
        return { supported: false, reason: 'the provider did not answer with a voice list' };
      }
      for (const item of body.voices) {
        const voice = voiceOf(item);
        if (voice) voices.push(voice);
      }
      token =
        body.has_more === true && typeof body.next_page_token === 'string'
          ? body.next_page_token
          : null;
      if (!token) break;
    }
    return { supported: true, voices, source: 'provider' };
  },

  async legacyVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'voices'),
      headers: headers(ctx),
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
    const body = answer.body as { voices?: ElevenVoice[] } | null;
    if (!Array.isArray(body?.voices)) {
      return { supported: false, reason: 'the provider did not answer with a voice list' };
    }
    const voices = body.voices.map(voiceOf).filter((voice): voice is DiscoveredVoice => !!voice);
    return { supported: true, voices, source: 'provider' };
  },

  async synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const voice = request.voice ?? ctx.settings.voice ?? null;
    if (!voice) return { supported: false, reason: 'no_voice' };
    const answer = await requestBytes({
      url: joinUrl(ctx.baseUrl, `text-to-speech/${encodeURIComponent(voice)}`),
      method: 'POST',
      headers: { ...headers(ctx), accept: 'audio/mpeg' },
      body: {
        text: request.text,
        model_id: request.model ?? ctx.settings.model ?? 'eleven_multilingual_v2',
        ...((request.language ?? ctx.settings.language)
          ? { language_code: request.language ?? ctx.settings.language }
          : {}),
      },
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok || !answer.bytes) return synthesisFailure(answer);
    return {
      supported: true,
      audio: answer.bytes,
      contentType: answer.contentType ?? 'audio/mpeg',
    };
  },

  async transcribe(ctx: ProviderContext, request: TranscribeRequest): Promise<TranscribeResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const form = new FormData();
    form.append('model_id', ctx.settings.model ?? 'scribe_v2');
    form.append(
      'file',
      new Blob([new Uint8Array(request.audio)], { type: request.mime }),
      request.filename,
    );
    const hint = request.language ?? ctx.settings.language ?? null;
    if (hint) form.append('language_code', hint.split('-')[0]!.toLowerCase());
    const answer = await requestForm({
      url: joinUrl(ctx.baseUrl, 'speech-to-text'),
      headers: headers(ctx),
      form,
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok) return { supported: false, reason: reasonOf(answer), detail: detailOf(answer) };
    const body = answer.body as {
      text?: unknown;
      language_code?: unknown;
      audio_duration_secs?: unknown;
    } | null;
    if (typeof body?.text !== 'string') {
      return {
        supported: false,
        reason: 'http_error',
        detail: 'the provider did not answer with a transcript',
      };
    }
    const seconds = typeof body.audio_duration_secs === 'number' ? body.audio_duration_secs : NaN;
    return {
      supported: true,
      text: body.text.trim(),
      language: typeof body.language_code === 'string' ? body.language_code : hint,
      durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
    };
  },
};

/** The ElevenLabs adapter with the `/v1/voices` fallback its `listVoices` calls. */
interface ElevenLabsAdapter extends ProviderAdapter {
  legacyVoices(ctx: ProviderContext): Promise<ListVoicesResult>;
}
