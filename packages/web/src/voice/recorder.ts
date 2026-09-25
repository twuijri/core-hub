/**
 * Dictation as a state machine (contract decision §55). Pure: the hook that drives the
 * microphone (`useDictation.ts`) dispatches these events and draws `phase`; the rules of
 * what may follow what live here, so they are tested without a browser.
 *
 *   idle ──start──▶ requesting ──granted──▶ recording ──stop──▶ transcribing ──transcribed──▶ idle
 *     │                 │ denied                │ failed              │ failed
 *     └─unavailable─▶ error ◀───────────────────┴─────────────────────┘
 *   error ──dismiss / start──▶ …         any ──cancel──▶ idle
 *
 * Two engines: `hub` records with `MediaRecorder` and sends the take to `models.transcribe`;
 * `browser` is the browser's own recognizer (Web Speech API), used only when the profile has
 * no speech-to-text provider ready — and marked as such on screen.
 */

export type Engine = 'hub' | 'browser';

/** Why a dictation stopped short, each with its own sentence on screen. */
export type DictationError =
  /** No STT provider on the hub and no recognizer in this browser: the link to Models. */
  | 'no_provider'
  | 'mic_denied'
  | 'mic_unavailable'
  /** Heard nothing (`400 no_speech`, or the recognizer's own "no-speech"). */
  | 'no_speech'
  | 'failed';

export type RecorderState =
  | { phase: 'idle' }
  | { phase: 'requesting'; engine: Engine }
  | { phase: 'recording'; engine: Engine; startedAt: number }
  | { phase: 'transcribing'; engine: Engine; durationMs: number }
  | { phase: 'error'; error: DictationError; detail: string | null };

export type RecorderEvent =
  | { type: 'start'; engine: Engine }
  | { type: 'unavailable' }
  | { type: 'granted'; at: number }
  | { type: 'denied'; error: 'mic_denied' | 'mic_unavailable'; detail?: string | null }
  | { type: 'stop'; at: number }
  | { type: 'transcribed' }
  | { type: 'failed'; error: DictationError; detail?: string | null }
  | { type: 'cancel' }
  | { type: 'dismiss' };

export const IDLE: RecorderState = { phase: 'idle' };

/** The longest take the hub is sent: two minutes of speech is far under Whisper's 25 MB. */
export const MAX_RECORDING_MS = 120_000;

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case 'start':
      return state.phase === 'idle' || state.phase === 'error'
        ? { phase: 'requesting', engine: event.engine }
        : state;
    case 'unavailable':
      return state.phase === 'idle' || state.phase === 'error'
        ? { phase: 'error', error: 'no_provider', detail: null }
        : state;
    case 'granted':
      return state.phase === 'requesting'
        ? { phase: 'recording', engine: state.engine, startedAt: event.at }
        : state;
    case 'denied':
      return state.phase === 'requesting'
        ? { phase: 'error', error: event.error, detail: event.detail ?? null }
        : state;
    case 'stop':
      return state.phase === 'recording'
        ? {
            phase: 'transcribing',
            engine: state.engine,
            durationMs: Math.max(0, event.at - state.startedAt),
          }
        : state;
    case 'transcribed':
      return state.phase === 'transcribing' ? IDLE : state;
    case 'failed':
      return state.phase === 'requesting' ||
        state.phase === 'recording' ||
        state.phase === 'transcribing'
        ? { phase: 'error', error: event.error, detail: event.detail ?? null }
        : state;
    case 'cancel':
      return IDLE;
    case 'dismiss':
      return state.phase === 'error' ? IDLE : state;
  }
}

/** Whether a press of the mic starts a take (true) or ends the one running (false). */
export function pressStarts(state: RecorderState): boolean {
  return state.phase === 'idle' || state.phase === 'error';
}

/** Whether the mic is doing something the person should wait for or can stop. */
export function isLive(state: RecorderState): boolean {
  return (
    state.phase === 'requesting' || state.phase === 'recording' || state.phase === 'transcribing'
  );
}

/**
 * Which engine a take uses: the hub whenever the profile's STT provider is ready; the
 * browser's recognizer only as the fallback; none when neither can listen.
 */
export function chooseEngine(input: {
  hubReady: boolean;
  browserSupported: boolean;
}): Engine | null {
  if (input.hubReady) return 'hub';
  if (input.browserSupported) return 'browser';
  return null;
}

/**
 * The language hint sent with a take, from `Preferences.voice.dictation_language`:
 * `auto` sends none (the provider detects it), `app` follows the UI language.
 */
export function dictationHint(preference: string | undefined, uiLanguage: string): string | null {
  if (!preference || preference === 'auto') return null;
  if (preference === 'app') return uiLanguage;
  return preference;
}

/** The recognizer needs a full tag and cannot auto-detect: `auto` means the UI's language. */
export function browserLanguage(hint: string | null, uiLanguage: string): string {
  const base = hint ?? uiLanguage;
  if (base.includes('-')) return base;
  return base === 'ar' ? 'ar-SA' : base === 'en' ? 'en-US' : base;
}

/** The first container this browser records in, in the order providers read best. */
export function recordingMime(isSupported: (mime: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
    (mime) => isSupported(mime),
  );
}
