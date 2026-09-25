/**
 * The microphone, driven by the state machine in `recorder.ts` (contract decision §55).
 *
 * Engine `hub`: `getUserMedia` → `MediaRecorder` → one Blob → `models.transcribe` with the
 * dictation language (`Preferences.voice.dictation_language`) and the length recorded.
 * Engine `browser`: the browser's own recognizer, only when the profile has no STT provider
 * ready. The words go to `onText`; nothing is sent by this hook.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useSpeechSettings } from '../models/queries.js';
import {
  IDLE,
  MAX_RECORDING_MS,
  browserLanguage,
  chooseEngine,
  recorderReducer,
  recordingMime,
  type Engine,
  type RecorderState,
} from './recorder.js';
import { dictationErrorOf, transcribe } from './speech-api.js';

/** The part of the Web Speech API this client uses (not in TypeScript's DOM library). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

export function browserRecognizer(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export interface Dictation {
  state: RecorderState;
  /** The engine the next take would use; null when nothing can listen. */
  engine: Engine | null;
  /** Whether the speech settings are still being read (the engine is not known yet). */
  loading: boolean;
  start(): void;
  stop(): void;
  cancel(): void;
  dismiss(): void;
}

export function useDictation({
  language,
  onText,
}: {
  /** The hint sent to the hub; null lets it detect the language. */
  language: string | null;
  onText(text: string): void;
}): Dictation {
  const { client } = useAuth();
  const { t, language: ui } = useI18n();
  const speech = useSpeechSettings();
  const [state, dispatch] = useReducer(recorderReducer, IDLE);
  const hubReady = speech.data?.stt?.ready === true;
  const engine = chooseEngine({
    hubReady: hubReady && canRecord(),
    browserSupported: browserRecognizer() !== null,
  });

  const live = useRef<{
    recorder?: MediaRecorder;
    stream?: MediaStream;
    recognition?: Recognition;
    timer?: ReturnType<typeof setTimeout>;
    cancelled: boolean;
  }>({ cancelled: false });
  const textRef = useRef(onText);
  textRef.current = onText;

  const release = useCallback(() => {
    const current = live.current;
    if (current.timer) clearTimeout(current.timer);
    current.stream?.getTracks().forEach((track) => track.stop());
    live.current = { cancelled: current.cancelled };
  }, []);

  useEffect(
    () => () => {
      live.current.cancelled = true;
      if (live.current.recorder?.state === 'recording') live.current.recorder.stop();
      live.current.recognition?.abort();
      release();
    },
    [release],
  );

  const startHub = useCallback(async () => {
    dispatch({ type: 'start', engine: 'hub' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      dispatch({
        type: 'denied',
        error:
          name === 'NotAllowedError' || name === 'SecurityError' ? 'mic_denied' : 'mic_unavailable',
        detail: error instanceof Error ? error.message : null,
      });
      return;
    }
    const mime = recordingMime((type) => MediaRecorder.isTypeSupported?.(type) ?? false);
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    recorder.onstop = () => {
      const stoppedAt = Date.now();
      release();
      if (live.current.cancelled) return;
      dispatch({ type: 'stop', at: stoppedAt });
      const audio = new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' });
      transcribe(client, { audio, language, durationMs: stoppedAt - startedAt })
        .then((result) => {
          if (live.current.cancelled) return;
          textRef.current(result.text);
          dispatch({ type: 'transcribed' });
        })
        .catch((error: unknown) => {
          if (live.current.cancelled) return;
          dispatch({
            type: 'failed',
            error: dictationErrorOf(error),
            detail: describeError(error, t),
          });
        });
    };
    live.current = {
      recorder,
      stream,
      cancelled: false,
      timer: setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, MAX_RECORDING_MS),
    };
    recorder.start();
    dispatch({ type: 'granted', at: startedAt });
  }, [client, language, release, t]);

  const startBrowser = useCallback(() => {
    const Recognizer = browserRecognizer();
    if (!Recognizer) return dispatch({ type: 'unavailable' });
    dispatch({ type: 'start', engine: 'browser' });
    const recognition = new Recognizer();
    recognition.lang = browserLanguage(language, ui);
    recognition.continuous = true;
    recognition.interimResults = false;
    const heard: string[] = [];
    let failed = false;
    recognition.onstart = () => dispatch({ type: 'granted', at: Date.now() });
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal && result[0]) heard.push(result[0].transcript.trim());
      }
    };
    recognition.onerror = (event) => {
      failed = true;
      if (event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        dispatch({ type: 'denied', error: 'mic_denied', detail: event.error });
        dispatch({ type: 'failed', error: 'mic_denied', detail: event.error });
      } else if (event.error === 'no-speech') {
        dispatch({ type: 'failed', error: 'no_speech', detail: null });
      } else {
        dispatch({ type: 'failed', error: 'failed', detail: event.error });
      }
    };
    recognition.onend = () => {
      delete live.current.recognition;
      if (failed || live.current.cancelled) return;
      const text = heard.join(' ').trim();
      dispatch({ type: 'stop', at: Date.now() });
      if (text) {
        textRef.current(text);
        dispatch({ type: 'transcribed' });
      } else {
        dispatch({ type: 'failed', error: 'no_speech', detail: null });
      }
    };
    live.current = { recognition, cancelled: false };
    recognition.start();
  }, [language, ui]);

  const start = useCallback(() => {
    if (engine === 'hub') void startHub();
    else if (engine === 'browser') startBrowser();
    else dispatch({ type: 'unavailable' });
  }, [engine, startHub, startBrowser]);

  const stop = useCallback(() => {
    const current = live.current;
    if (current.recorder?.state === 'recording') current.recorder.stop();
    else if (current.recognition) {
      // The recognizer delivers its last words on `end`; the phase moves there.
      current.recognition.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    live.current.cancelled = true;
    if (live.current.recorder?.state === 'recording') live.current.recorder.stop();
    live.current.recognition?.abort();
    release();
    dispatch({ type: 'cancel' });
  }, [release]);

  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), []);

  return { state, engine, loading: speech.isPending, start, stop, cancel, dismiss };
}
