/**
 * The two speech operations the web calls (contract decision §63), through the generated
 * client — never a hand-typed path.
 *
 * - `models.transcribe`: the take as the `audio` part of a `FormData`, with the language
 *   hint and the length recorded. The client sends `FormData` untouched, so the browser
 *   writes the boundary.
 * - `models.synthesize`: the text in, the audio bytes out (`responseKind: 'bytes'`), typed
 *   by the `Content-Type` the hub answered with.
 */
import { HubApiError, type HubClient } from '@corehub/contracts';
import type { DictationError } from './recorder.js';

export interface Transcript {
  text: string;
  language: string | null;
  duration_ms: number;
  provider_id: string;
  model: string | null;
}

export async function transcribe(
  client: HubClient,
  take: { audio: Blob; language: string | null; durationMs: number },
): Promise<Transcript> {
  const form = new FormData();
  const extension = take.audio.type.includes('ogg')
    ? 'ogg'
    : take.audio.type.includes('mp4')
      ? 'mp4'
      : take.audio.type.includes('wav')
        ? 'wav'
        : 'webm';
  form.append('audio', take.audio, `dictation.${extension}`);
  if (take.language) form.append('language', take.language);
  form.append('duration_ms', String(Math.max(0, Math.round(take.durationMs))));
  const response = await client.raw('post', '/models/speech/transcriptions', { body: form });
  return response.data as Transcript;
}

export async function synthesize(
  client: HubClient,
  request: {
    text: string;
    language: string | null;
    /** A preview names what it previews (DECISIONS §94); a reply uses the saved choice. */
    providerId?: string | null;
    model?: string | null;
    voice?: string | null;
  },
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await client.raw('post', '/models/speech/speech', {
    body: {
      text: request.text,
      language: request.language,
      ...(request.providerId ? { provider_id: request.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.voice ? { voice: request.voice } : {}),
    },
    responseKind: 'bytes',
    ...(signal ? { signal } : {}),
  });
  const type = response.headers.get('content-type') ?? 'audio/mpeg';
  return new Blob([response.data as ArrayBuffer], { type });
}

/** What a failed transcription means for the person: the hub's reason, as a named error. */
export function dictationErrorOf(error: unknown): DictationError {
  if (!(error instanceof HubApiError)) return 'failed';
  const reason = (error.body as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (reason === 'no_speech') return 'no_speech';
  if (reason === 'no_stt_provider' || reason === 'provider_disabled') return 'no_provider';
  return 'failed';
}

/** Whether a failed synthesis is "no voice is set up" rather than a voice that failed. */
export function isMissingVoice(error: unknown): boolean {
  if (!(error instanceof HubApiError)) return false;
  const reason = (error.body as { details?: { reason?: unknown } } | null)?.details?.reason;
  return reason === 'no_tts_provider' || reason === 'provider_disabled';
}
