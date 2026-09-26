/**
 * Groq's speech (groq.com, the inference company — not xAI's Grok), from its public docs
 * (<https://console.groq.com/docs/speech-to-text>, <https://console.groq.com/docs/text-to-speech>):
 *
 * - **Speech to text** is OpenAI's shape at `{base}/audio/transcriptions` with Groq's Whisper
 *   models, so it is the OpenAI adapter's `transcribe` unchanged.
 * - **Text to speech** is `POST {base}/audio/speech` with `model`, `input`, `voice` and
 *   `response_format`, where **`wav` is the only format** Groq accepts — asking for `mp3`,
 *   as the OpenAI adapter does, is refused. Each request takes at most 200 characters; the
 *   service splits longer text (`speech/split.ts`) and joins the WAVs (`speech/audio.ts`).
 * - **Voices** have no list endpoint: they are named per model on the Orpheus page (English:
 *   autumn, diana, hannah, austin, daniel, troy; Arabic, Saudi dialect: abdullah, fahad,
 *   sultan, lulwa, noura, aisha), so the documented list answers (`speech/documented.ts`).
 * - The model list is Groq's own `GET {base}/models`, the OpenAI adapter's.
 */
import { joinUrl, requestBytes, synthesisFailure } from './http.js';
import { openAiAdapter } from './openai.js';
import type {
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  SynthesizeRequest,
  SynthesizeResult,
} from './types.js';
import { documentedVoices } from '../speech/documented.js';

function authHeaders(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
    ...ctx.headers,
  };
}

export const groqAdapter: ProviderAdapter = {
  protocol: 'groq',
  test: (ctx) => openAiAdapter.test(ctx),
  listModels: (ctx) => openAiAdapter.listModels(ctx),
  chat: (ctx, request) => openAiAdapter.chat(ctx, request),
  transcribe: (ctx, request) => openAiAdapter.transcribe!(ctx, request),

  listVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    return Promise.resolve(
      documentedVoices(ctx.slug) ??
        documentedVoices('groq-tts') ?? {
          supported: false,
          reason: 'this provider has no voice list endpoint; type the voice id',
        },
    );
  },

  async synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult> {
    if (!ctx.apiKey && ctx.requiresKey !== false) return { supported: false, reason: 'no_key' };
    const model = request.model ?? ctx.settings.model ?? null;
    if (!model) return { supported: false, reason: 'no_model' };
    const voice = request.voice ?? ctx.settings.voice ?? null;
    if (!voice) return { supported: false, reason: 'no_voice' };
    const answer = await requestBytes({
      url: joinUrl(ctx.baseUrl, 'audio/speech'),
      method: 'POST',
      headers: { ...authHeaders(ctx), accept: 'audio/wav' },
      body: { model, input: request.text, voice, response_format: 'wav' },
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok || !answer.bytes) return synthesisFailure(answer);
    return { supported: true, audio: answer.bytes, contentType: 'audio/wav' };
  },
};
