/**
 * Deepgram (speech to text and Aura text to speech), from its public API reference
 * (<https://developers.deepgram.com/reference/manage/models/list>, `/v1/listen`, `/v1/speak`):
 *
 * - Every request carries `Authorization: Token <key>` — Deepgram's word, not `Bearer`.
 * - `GET {base}/models` is the catalogue **and** the voice list: `stt[]` are the transcription
 *   models (`canonical_name`, `languages`), `tts[]` the Aura voices, each a model of its own
 *   (`canonical_name` `aura-2-thalia-en`) with its `architecture` (`aura-2`), `languages` and
 *   `metadata` (`accent`, `tags` such as `feminine` / `masculine`). So a TTS row's "model" is
 *   the architecture, and its voice is the canonical name that `/speak?model=` takes.
 * - Speech to text is `POST {base}/listen?model=…` with the recording itself as the body,
 *   typed by `content-type`; the words are `results.channels[0].alternatives[0].transcript`.
 *   With no language hint Deepgram is asked to detect one (`detect_language=true`).
 * - Text to speech is `POST {base}/speak?model=<voice>` with `{ "text": … }`; the answer is
 *   MP3 by default. A request takes at most 2 000 characters (the catalogue says so).
 */
import {
  detailOf,
  joinUrl,
  reasonOf,
  requestBytes,
  requestJson,
  requestUpload,
  synthesisFailure,
} from './http.js';
import { chatUnsupported } from './types.js';
import type {
  ChatEvent,
  DiscoveredModel,
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

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { authorization: `Token ${ctx.apiKey}` } : {}),
    ...ctx.headers,
  };
}

interface DeepgramModel {
  name?: unknown;
  canonical_name?: unknown;
  architecture?: unknown;
  languages?: unknown;
  metadata?: { accent?: unknown; tags?: unknown } | null;
}

async function catalogue(
  ctx: ProviderContext,
): Promise<{ stt: DeepgramModel[]; tts: DeepgramModel[] } | { error: string }> {
  const answer = await requestJson({
    url: joinUrl(ctx.baseUrl, 'models'),
    headers: headers(ctx),
    fetchImpl: ctx.fetchImpl,
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  if (!answer.ok) return { error: detailOf(answer) ?? reasonOf(answer) };
  const body = answer.body as { stt?: unknown; tts?: unknown } | null;
  if (!body || (!Array.isArray(body.stt) && !Array.isArray(body.tts))) {
    return { error: 'the provider did not answer with a model list' };
  }
  return {
    stt: Array.isArray(body.stt) ? (body.stt as DeepgramModel[]) : [],
    tts: Array.isArray(body.tts) ? (body.tts as DeepgramModel[]) : [],
  };
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function languagesOf(model: DeepgramModel): string[] {
  return Array.isArray(model.languages)
    ? model.languages.filter((item): item is string => typeof item === 'string')
    : [];
}

function genderOf(tags: unknown): DiscoveredVoice['gender'] {
  if (!Array.isArray(tags)) return null;
  const lower = tags.map((tag) => String(tag).toLowerCase());
  if (lower.includes('feminine') || lower.includes('female')) return 'female';
  if (lower.includes('masculine') || lower.includes('male')) return 'male';
  return null;
}

/** `thalia` -> `Thalia`: Deepgram's `name` is the lower-case persona. */
function titled(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const deepgramAdapter: ProviderAdapter = {
  protocol: 'deepgram',

  chat(): AsyncIterable<ChatEvent> {
    return chatUnsupported('this provider transcribes and speaks; it does not answer');
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!ctx.apiKey) {
      return { ok: false, reason: 'no_key', detail: null, status: null, durationMs: 0 };
    }
    // `/projects` needs the key (the model list is public), so it is the honest check.
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'projects'),
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
    const listed = await catalogue(ctx);
    if ('error' in listed) return { supported: false, reason: listed.error };
    const models: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const item of listed.stt) {
      const key = text(item.canonical_name) ?? text(item.name);
      if (!key || seen.has(`stt:${key}`)) continue;
      seen.add(`stt:${key}`);
      models.push({ key, label: key, kind: 'stt' });
    }
    // The Aura voices are models of their own; the row's model is their architecture.
    for (const item of listed.tts) {
      const key = text(item.architecture);
      if (!key || seen.has(`tts:${key}`)) continue;
      seen.add(`tts:${key}`);
      models.push({ key, label: key, kind: 'tts' });
    }
    return { supported: true, models };
  },

  async listVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    const listed = await catalogue(ctx);
    if ('error' in listed) return { supported: false, reason: listed.error };
    const voices: DiscoveredVoice[] = [];
    const seen = new Set<string>();
    for (const item of listed.tts) {
      const id = text(item.canonical_name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const languages = languagesOf(item);
      const architecture = text(item.architecture);
      voices.push({
        id,
        name: titled(text(item.name) ?? id),
        // The most specific tag the provider gives (`en-US` over `en`).
        language: languages.find((tag) => tag.includes('-')) ?? languages[0] ?? null,
        gender: genderOf(item.metadata?.tags),
        description: text(item.metadata?.accent),
        ...(architecture ? { models: [architecture] } : {}),
      });
    }
    return { supported: true, voices, source: 'provider' };
  },

  async synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const voice = request.voice ?? ctx.settings.voice ?? null;
    if (!voice) return { supported: false, reason: 'no_voice' };
    const url = `${joinUrl(ctx.baseUrl, 'speak')}?model=${encodeURIComponent(voice)}`;
    const answer = await requestBytes({
      url,
      method: 'POST',
      headers: { ...headers(ctx), accept: 'audio/mpeg' },
      body: { text: request.text },
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
    const query = new URLSearchParams({
      model: ctx.settings.model ?? 'nova-3',
      smart_format: 'true',
    });
    const hint = request.language ?? ctx.settings.language ?? null;
    if (hint) query.set('language', hint);
    else query.set('detect_language', 'true');
    const answer = await requestUpload({
      url: `${joinUrl(ctx.baseUrl, 'listen')}?${query.toString()}`,
      headers: headers(ctx),
      body: request.audio,
      // Deepgram reads the container from the bytes; the type only has to be audio.
      contentType: request.mime.split(';')[0] || 'application/octet-stream',
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok) return { supported: false, reason: reasonOf(answer), detail: detailOf(answer) };
    const body = answer.body as {
      metadata?: { duration?: unknown };
      results?: {
        channels?: {
          detected_language?: unknown;
          alternatives?: { transcript?: unknown }[];
        }[];
      };
    } | null;
    const channel = body?.results?.channels?.[0];
    const transcript = channel?.alternatives?.[0]?.transcript;
    if (typeof transcript !== 'string') {
      return {
        supported: false,
        reason: 'http_error',
        detail: 'the provider did not answer with a transcript',
      };
    }
    const seconds = typeof body?.metadata?.duration === 'number' ? body.metadata.duration : NaN;
    return {
      supported: true,
      text: transcript.trim(),
      language: text(channel?.detected_language) ?? hint,
      durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
    };
  },
};
