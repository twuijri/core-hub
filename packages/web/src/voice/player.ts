/**
 * The one voice of a chat screen: whatever is being read aloud, one thing at a time.
 *
 * A reply is read as chunks (`chunking.ts`); each chunk is one `models.synthesize` request,
 * and the next chunk's audio is fetched while the current one plays, so a long reply has no
 * gap longer than one request. A reply still arriving (voice mode) is read the same way: the
 * caller opens a reading and pushes chunks as they become safe to say, then ends it.
 *
 * Starting a reading stops the one before; `stop()` stops everything at once. The screen
 * subscribes to `snapshot()` (via `useSyncExternalStore`) to draw which message is loading or
 * playing, and says any failure next to it.
 *
 * Framework-free and injected: the tests hand it a fake synthesizer and a fake audio element.
 */

export type VoiceSource = 'hub' | 'browser';

export interface PlayerSnapshot {
  /** What is being read (a message id, or `voice-mode`); null when silent. */
  id: string | null;
  phase: 'idle' | 'loading' | 'playing';
  source: VoiceSource | null;
  /** The last reading that failed, and why, until another starts. */
  error: { id: string; message: string; missingVoice: boolean } | null;
}

export interface PlayerDeps {
  /** One chunk through the hub's TTS. */
  synthesize(text: string, language: string | null, signal: AbortSignal): Promise<Blob>;
  /** Plays audio to its end; resolves early (without error) when `signal` aborts. */
  playAudio(audio: Blob, signal: AbortSignal): Promise<void>;
  /** The browser's own voice, for the fallback; absent where the browser has none. */
  speakLocally?:
    ((text: string, language: string | null, signal: AbortSignal) => Promise<void>) | undefined;
  /** How a failure reads on screen, and whether it is "no voice set up". */
  describe(error: unknown): { message: string; missingVoice: boolean };
}

export interface Reading {
  push(chunk: string): void;
  /** No more chunks will come; the reading ends once the last one has been said. */
  end(): void;
  /** Resolves when the reading ended — said to the end, stopped, or failed. */
  done: Promise<void>;
}

const SILENT: PlayerSnapshot = { id: null, phase: 'idle', source: null, error: null };

export class SpeechPlayer {
  private state: PlayerSnapshot = SILENT;
  private readonly listeners = new Set<() => void>();
  private current: AbortController | null = null;

  constructor(private readonly deps: PlayerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): PlayerSnapshot => this.state;

  private set(next: Partial<PlayerSnapshot>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Reads a whole text that is already here. */
  play(id: string, chunks: string[], options: { language: string | null; source: VoiceSource }) {
    const reading = this.open(id, options);
    for (const chunk of chunks) reading.push(chunk);
    reading.end();
    return reading.done;
  }

  stop() {
    this.current?.abort();
    this.current = null;
    if (this.state.id !== null || this.state.phase !== 'idle')
      this.set({ ...SILENT, error: this.state.error });
  }

  /** Reads chunks as they are pushed; the reading before this one stops. */
  open(id: string, options: { language: string | null; source: VoiceSource }): Reading {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const { signal } = controller;
    const chunks: string[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const nudge = () => {
      wake?.();
      wake = null;
    };
    const audio: Promise<Blob>[] = [];
    const fetchAudio = (index: number) =>
      (audio[index] ??= this.deps.synthesize(chunks[index]!, options.language, signal));

    this.set({ id, phase: 'loading', source: options.source, error: null });

    const run = async () => {
      for (let index = 0; ; index += 1) {
        while (chunks[index] === undefined && !ended && !signal.aborted) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        if (signal.aborted || chunks[index] === undefined) return;
        if (options.source === 'browser') {
          if (!this.deps.speakLocally) throw new Error('this browser has no voice of its own');
          this.set({ phase: 'playing' });
          await this.deps.speakLocally(chunks[index]!, options.language, signal);
          continue;
        }
        const blob = await fetchAudio(index);
        if (signal.aborted) return;
        // The next chunk's audio is on its way while this one plays.
        if (chunks[index + 1] !== undefined) void fetchAudio(index + 1).catch(() => {});
        this.set({ phase: 'playing' });
        await this.deps.playAudio(blob, signal);
      }
    };

    const done = run()
      .catch((error: unknown) => {
        if (signal.aborted) return;
        this.set({ error: { id, ...this.deps.describe(error) } });
      })
      .finally(() => {
        if (this.current === controller) {
          this.current = null;
          this.set({ id: null, phase: 'idle', source: null });
        }
      });

    signal.addEventListener('abort', nudge);
    return {
      push: (chunk: string) => {
        if (ended || signal.aborted || chunk.trim() === '') return;
        chunks.push(chunk);
        nudge();
      },
      end: () => {
        ended = true;
        nudge();
      },
      done,
    };
  }
}

/** Plays a blob through an `<audio>` element; the browser's own implementation of `playAudio`. */
export function playThroughAudioElement(audio: Blob, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(audio);
    const element = new Audio(url);
    const finish = (error?: unknown) => {
      element.pause();
      URL.revokeObjectURL(url);
      signal.removeEventListener('abort', onAbort);
      if (error)
        reject(error instanceof Error ? error : new Error('the audio could not be played'));
      else resolve();
    };
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort);
    element.addEventListener('ended', () => finish());
    element.addEventListener('error', () => finish(new Error('the audio could not be played')));
    element.play().catch((error: unknown) => finish(error));
  });
}

/** The browser's own voice (`speechSynthesis`), for the fallback. */
export function speakWithBrowser(
  text: string,
  language: string | null,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
    if (!synth || signal.aborted) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    if (language)
      utterance.lang = language === 'ar' ? 'ar-SA' : language === 'en' ? 'en-US' : language;
    const onAbort = () => {
      synth.cancel();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    utterance.onend = () => resolve();
    utterance.onerror = (event) =>
      event.error === 'interrupted' || event.error === 'canceled'
        ? resolve()
        : reject(new Error(event.error));
    synth.speak(utterance);
  });
}

export function browserCanSpeak(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}
