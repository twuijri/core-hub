/**
 * ElevenLabs (text to speech): `xi-api-key`, `GET /v1/voices` for the voice list and
 * `POST /v1/text-to-speech/{voice_id}` for the audio
 * (<https://elevenlabs.io/docs/api-reference/text-to-speech/convert>).
 *
 * This is the one provider in the catalogue that really does answer `models.listVoices`
 * with a list, which is why the contract allows the operation to come back empty
 * elsewhere rather than pretending.
 */
import { detailOf, joinUrl, reasonOf, requestBytes, requestJson } from './http.js';
import type {
  DiscoveredVoice,
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SynthesizeRequest,
  SynthesizeResult,
} from './types.js';

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

export const elevenLabsAdapter: ProviderAdapter = {
  protocol: 'elevenlabs',

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

  listModels(): Promise<ListModelsResult> {
    // The hub shows voices for a TTS provider, not models; `models.listVoices` is the
    // operation that means something here.
    return Promise.resolve({
      supported: false,
      reason: 'a speech provider is configured by voice, not by model list',
    });
  },

  async listVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'voices'),
      headers: headers(ctx),
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
    const body = answer.body as {
      voices?: { voice_id?: unknown; name?: unknown; labels?: unknown; fine_tuning?: unknown }[];
    } | null;
    if (!Array.isArray(body?.voices)) {
      return { supported: false, reason: 'the provider did not answer with a voice list' };
    }
    const voices: DiscoveredVoice[] = [];
    for (const item of body.voices) {
      const id = typeof item?.voice_id === 'string' ? item.voice_id : null;
      if (!id) continue;
      const language = (item.labels as { language?: unknown } | null)?.language;
      voices.push({
        id,
        name: typeof item.name === 'string' && item.name ? item.name : id,
        language: typeof language === 'string' ? language : null,
        gender: genderOf(item.labels),
      });
    }
    return { supported: true, voices };
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
        model_id: ctx.settings.model ?? 'eleven_multilingual_v2',
        ...(request.language ?? ctx.settings.language
          ? { language_code: request.language ?? ctx.settings.language }
          : {}),
      },
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok || !answer.bytes) {
      return {
        supported: false,
        reason: answer.error ? 'unreachable' : 'http_error',
        detail: answer.detail ?? answer.error,
      };
    }
    return {
      supported: true,
      audio: answer.bytes,
      contentType: answer.contentType ?? 'audio/mpeg',
    };
  },
};
