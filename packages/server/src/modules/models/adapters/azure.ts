/**
 * Azure AI Speech with a resource key, from Microsoft's public REST docs
 * (text to speech REST, `voices/list`; fast transcription `transcriptions:transcribe`):
 *
 * - The key goes in `Ocp-Apim-Subscription-Key`, and belongs to one region. The row's address
 *   is the resource's endpoint — `https://<region>.api.cognitive.microsoft.com` (or a custom
 *   `…cognitiveservices.azure.com` domain); the dialog asks for it, because a wrong guess of the
 *   region is a key that "does not work".
 * - **Text to speech** lives on the region's TTS host, `https://<region>.tts.speech.microsoft.com`:
 *   `GET /cognitiveservices/voices/list` is the whole voice list (every locale, `ar-SA-HamedNeural`
 *   and `ar-SA-ZariyahNeural` among them), and `POST /cognitiveservices/v1` takes SSML and answers
 *   the audio in the format `X-Microsoft-OutputFormat` names.
 * - **Speech to text** is fast transcription on the resource endpoint,
 *   `POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15`, multipart with the
 *   `audio` and a `definition` (`{"locales":["ar-SA"]}`, or none to let it detect). It accepts
 *   WebM, Ogg/Opus, WAV, MP3 and AAC — what browsers and phones record.
 * - Neither side has a model to choose: the voice names its model.
 *
 * An address that is not one of Azure's regional hosts (a custom domain, or a test's loopback
 * server) is used as it is for both.
 */
import {
  detailOf,
  joinUrl,
  reasonOf,
  requestForm,
  requestJson,
  requestTextForBytes,
  synthesisFailure,
} from './http.js';
import { chatUnsupported } from './types.js';
import type {
  ChatEvent,
  DiscoveredVoice,
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SpeechFormat,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
} from './types.js';

export const AZURE_STT_API_VERSION = '2025-10-15';
const REGIONAL = /^([a-z0-9]+)\.(api\.cognitive|tts\.speech|stt\.speech)\.microsoft\.com$/i;

/** Where speech synthesis lives for the row's address. */
export function azureTtsBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  const region = REGIONAL.exec(url.hostname)?.[1];
  return region ? `https://${region}.tts.speech.microsoft.com` : baseUrl.replace(/\/+$/, '');
}

/** Where fast transcription lives for the row's address. */
export function azureSttBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  const region = REGIONAL.exec(url.hostname)?.[1];
  return region ? `https://${region}.api.cognitive.microsoft.com` : baseUrl.replace(/\/+$/, '');
}

/**
 * Azure wants a locale (`ar-SA`), where the hub's hint is often a bare language (`ar`). The
 * common ones map to the locale most people mean; anything else is passed as it is.
 */
const DEFAULT_LOCALE: Record<string, string> = {
  ar: 'ar-SA',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-BR',
  ru: 'ru-RU',
  tr: 'tr-TR',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  hi: 'hi-IN',
  ur: 'ur-PK',
  fa: 'fa-IR',
  id: 'id-ID',
  ms: 'ms-MY',
  nl: 'nl-NL',
  pl: 'pl-PL',
  sv: 'sv-SE',
  he: 'he-IL',
  bn: 'bn-IN',
  th: 'th-TH',
  vi: 'vi-VN',
  uk: 'uk-UA',
};

export function azureLocale(language: string | null): string | null {
  if (!language) return null;
  const trimmed = language.trim();
  if (!trimmed) return null;
  if (trimmed.includes('-')) return trimmed;
  return DEFAULT_LOCALE[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * `SpeechFormat` as Azure's `X-Microsoft-OutputFormat` (DECISIONS §91). Azure has no AAC
 * output, so a client asking for AAC gets MP3, which every phone plays, and the type says so.
 */
const AZURE_OUTPUT: Record<SpeechFormat, { name: string; mime: string }> = {
  mp3: { name: 'audio-24khz-48kbitrate-mono-mp3', mime: 'audio/mpeg' },
  aac: { name: 'audio-24khz-48kbitrate-mono-mp3', mime: 'audio/mpeg' },
  ogg: { name: 'ogg-24khz-16bit-mono-opus', mime: 'audio/ogg' },
  wav: { name: 'riff-24khz-16bit-mono-pcm', mime: 'audio/wav' },
};

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { 'Ocp-Apim-Subscription-Key': ctx.apiKey } : {}),
    ...ctx.headers,
  };
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `ar-SA-HamedNeural` -> `ar-SA`. */
function localeOfVoice(voice: string): string | null {
  const match = /^([a-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]{2,4})?)-/.exec(voice);
  return match?.[1] ?? null;
}

async function voiceList(ctx: ProviderContext) {
  return requestJson({
    url: joinUrl(azureTtsBase(ctx.baseUrl), 'cognitiveservices/voices/list'),
    headers: headers(ctx),
    fetchImpl: ctx.fetchImpl,
    timeoutMs: ctx.timeoutMs ?? 15_000,
  });
}

export const azureAdapter: ProviderAdapter = {
  protocol: 'azure',

  chat(): AsyncIterable<ChatEvent> {
    return chatUnsupported('this provider transcribes and speaks; it does not answer');
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!ctx.apiKey) {
      return { ok: false, reason: 'no_key', detail: null, status: null, durationMs: 0 };
    }
    const answer = await voiceList(ctx);
    return {
      ok: answer.ok,
      reason: reasonOf(answer),
      detail: answer.ok ? null : detailOf(answer),
      status: answer.status,
      durationMs: answer.durationMs,
    };
  },

  listModels(): Promise<ListModelsResult> {
    return Promise.resolve({
      supported: false,
      reason: 'Azure Speech has no model to choose: the voice names it',
    });
  },

  async listVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const answer = await voiceList(ctx);
    if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
    if (!Array.isArray(answer.body)) {
      return { supported: false, reason: 'the provider did not answer with a voice list' };
    }
    const voices: DiscoveredVoice[] = [];
    for (const item of answer.body as Record<string, unknown>[]) {
      const id = typeof item?.ShortName === 'string' ? item.ShortName : null;
      if (!id) continue;
      const display = typeof item.DisplayName === 'string' ? item.DisplayName : id;
      const local = typeof item.LocalName === 'string' ? item.LocalName : null;
      const gender = typeof item.Gender === 'string' ? item.Gender.toLowerCase() : '';
      const localeName = typeof item.LocaleName === 'string' ? item.LocaleName : null;
      voices.push({
        id,
        name: local && local !== display ? `${display} (${local})` : display,
        language: typeof item.Locale === 'string' ? item.Locale : localeOfVoice(id),
        gender: gender === 'female' || gender === 'male' || gender === 'neutral' ? gender : null,
        description: localeName,
      });
    }
    return { supported: true, voices, source: 'provider' };
  },

  async synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const voice = request.voice ?? ctx.settings.voice ?? null;
    if (!voice) return { supported: false, reason: 'no_voice' };
    const locale =
      localeOfVoice(voice) ??
      azureLocale(request.language ?? ctx.settings.language ?? null) ??
      'en-US';
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(locale)}">` +
      `<voice name="${xml(voice)}">${xml(request.text)}</voice></speak>`;
    const answer = await requestTextForBytes({
      url: joinUrl(azureTtsBase(ctx.baseUrl), 'cognitiveservices/v1'),
      headers: {
        ...headers(ctx),
        'X-Microsoft-OutputFormat': AZURE_OUTPUT[request.format ?? 'mp3'].name,
        'User-Agent': 'core-hub',
      },
      body: ssml,
      contentType: 'application/ssml+xml',
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok || !answer.bytes) return synthesisFailure(answer);
    return {
      supported: true,
      audio: answer.bytes,
      contentType: AZURE_OUTPUT[request.format ?? 'mp3'].mime,
    };
  },

  async transcribe(ctx: ProviderContext, request: TranscribeRequest): Promise<TranscribeResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const locale = azureLocale(request.language ?? ctx.settings.language ?? null);
    const form = new FormData();
    form.append(
      'audio',
      new Blob([new Uint8Array(request.audio)], { type: request.mime }),
      request.filename,
    );
    // No locale: the service's multi-lingual model detects it.
    form.append('definition', JSON.stringify(locale ? { locales: [locale] } : {}));
    const answer = await requestForm({
      url: `${joinUrl(azureSttBase(ctx.baseUrl), 'speechtotext/transcriptions:transcribe')}?api-version=${AZURE_STT_API_VERSION}`,
      headers: headers(ctx),
      form,
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok) return { supported: false, reason: reasonOf(answer), detail: detailOf(answer) };
    const body = answer.body as {
      durationMilliseconds?: unknown;
      combinedPhrases?: { text?: unknown }[];
      phrases?: { locale?: unknown }[];
    } | null;
    if (!body || !Array.isArray(body.combinedPhrases)) {
      return {
        supported: false,
        reason: 'http_error',
        detail: 'the provider did not answer with a transcript',
      };
    }
    const words = body.combinedPhrases
      .map((phrase) => (typeof phrase?.text === 'string' ? phrase.text : ''))
      .join(' ')
      .trim();
    const detected = body.phrases?.find((phrase) => typeof phrase?.locale === 'string')?.locale;
    const ms = typeof body.durationMilliseconds === 'number' ? body.durationMilliseconds : NaN;
    return {
      supported: true,
      text: words,
      language: typeof detected === 'string' ? detected : locale,
      durationMs: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null,
    };
  },
};
