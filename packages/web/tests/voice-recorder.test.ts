// Dictation's state machine and the reading player (DECISIONS §63): src/voice/recorder.ts and
// src/voice/player.ts, with no browser — the player gets a fake synthesizer and a fake speaker.
import { describe, expect, it } from 'vitest';
import {
  IDLE,
  browserLanguage,
  chooseEngine,
  dictationHint,
  isLive,
  pressStarts,
  recorderReducer,
  recordingMime,
  type RecorderEvent,
  type RecorderState,
} from '../src/voice/recorder.js';
import { SpeechPlayer, type PlayerDeps } from '../src/voice/player.js';

const run = (events: RecorderEvent[], from: RecorderState = IDLE) =>
  events.reduce(recorderReducer, from);

describe('recorderReducer', () => {
  it('walks a whole take: start, granted, stop, transcribed', () => {
    let state = run([{ type: 'start', engine: 'hub' }]);
    expect(state).toEqual({ phase: 'requesting', engine: 'hub' });
    expect(pressStarts(state)).toBe(false);
    state = recorderReducer(state, { type: 'granted', at: 1000 });
    expect(state).toEqual({ phase: 'recording', engine: 'hub', startedAt: 1000 });
    expect(isLive(state)).toBe(true);
    state = recorderReducer(state, { type: 'stop', at: 3500 });
    expect(state).toEqual({ phase: 'transcribing', engine: 'hub', durationMs: 2500 });
    state = recorderReducer(state, { type: 'transcribed' });
    expect(state).toBe(IDLE);
    expect(pressStarts(state)).toBe(true);
  });

  it('names every way a take stops short, and a new press starts over from an error', () => {
    expect(run([{ type: 'unavailable' }])).toEqual({
      phase: 'error',
      error: 'no_provider',
      detail: null,
    });
    const denied = run([
      { type: 'start', engine: 'hub' },
      { type: 'denied', error: 'mic_denied', detail: 'Permission denied' },
    ]);
    expect(denied).toEqual({ phase: 'error', error: 'mic_denied', detail: 'Permission denied' });
    expect(pressStarts(denied)).toBe(true);
    expect(recorderReducer(denied, { type: 'start', engine: 'hub' }).phase).toBe('requesting');
    const silent = run([
      { type: 'start', engine: 'hub' },
      { type: 'granted', at: 0 },
      { type: 'stop', at: 10 },
      { type: 'failed', error: 'no_speech' },
    ]);
    expect(silent).toEqual({ phase: 'error', error: 'no_speech', detail: null });
    expect(recorderReducer(silent, { type: 'dismiss' })).toBe(IDLE);
  });

  it('ignores events that make no sense where it is', () => {
    // No stop before a take, no second start while recording, no "transcribed" from idle.
    expect(recorderReducer(IDLE, { type: 'stop', at: 5 })).toBe(IDLE);
    expect(recorderReducer(IDLE, { type: 'transcribed' })).toBe(IDLE);
    expect(recorderReducer(IDLE, { type: 'failed', error: 'failed' })).toBe(IDLE);
    const recording = run([
      { type: 'start', engine: 'browser' },
      { type: 'granted', at: 0 },
    ]);
    expect(recorderReducer(recording, { type: 'start', engine: 'hub' })).toBe(recording);
    expect(recorderReducer(recording, { type: 'dismiss' })).toBe(recording);
    // Cancel always goes home.
    expect(recorderReducer(recording, { type: 'cancel' })).toBe(IDLE);
  });
});

describe('choosing how to listen', () => {
  it('prefers the hub, falls back to the browser, and admits when nothing can listen', () => {
    expect(chooseEngine({ hubReady: true, browserSupported: true })).toBe('hub');
    expect(chooseEngine({ hubReady: false, browserSupported: true })).toBe('browser');
    expect(chooseEngine({ hubReady: false, browserSupported: false })).toBeNull();
  });

  it('turns the dictation preference into a hint', () => {
    expect(dictationHint('auto', 'ar')).toBeNull();
    expect(dictationHint(undefined, 'ar')).toBeNull();
    expect(dictationHint('app', 'en')).toBe('en');
    expect(dictationHint('ar', 'en')).toBe('ar');
    expect(browserLanguage(null, 'ar')).toBe('ar-SA');
    expect(browserLanguage('en', 'ar')).toBe('en-US');
    expect(browserLanguage('fr-CA', 'ar')).toBe('fr-CA');
  });

  it('records in the first container the browser supports', () => {
    expect(recordingMime((mime) => mime === 'audio/mp4')).toBe('audio/mp4');
    expect(recordingMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(recordingMime(() => false)).toBeUndefined();
  });
});

/** A synthesizer that answers when told to, and a speaker that "plays" until released. */
function fakes() {
  const asked: string[] = [];
  const played: string[] = [];
  const pendingAudio = new Map<string, (blob: Blob) => void>();
  let finishPlaying: (() => void) | null = null;
  const deps: PlayerDeps = {
    synthesize: (text) => {
      asked.push(text);
      return new Promise<Blob>((resolve) => pendingAudio.set(text, resolve));
    },
    playAudio: async (blob, signal) => {
      played.push(await blob.text());
      await new Promise<void>((resolve) => {
        finishPlaying = resolve;
        signal.addEventListener('abort', () => resolve());
      });
    },
    describe: (error) => ({ message: String(error), missingVoice: false }),
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    deps,
    asked,
    played,
    tick,
    answer: (text: string) => pendingAudio.get(text)?.(new Blob([text])),
    finish: () => (finishPlaying as (() => void) | null)?.(),
  };
}

describe('SpeechPlayer', () => {
  it('reads chunks in order and fetches the next while the current one plays', async () => {
    const f = fakes();
    const player = new SpeechPlayer(f.deps);
    const done = player.play('m1', ['one.', 'two.', 'three.'], { language: 'en', source: 'hub' });
    expect(player.snapshot()).toMatchObject({ id: 'm1', phase: 'loading' });
    await f.tick();
    expect(f.asked).toEqual(['one.']);
    f.answer('one.');
    await f.tick();
    await f.tick();
    expect(player.snapshot().phase).toBe('playing');
    expect(f.played).toEqual(['one.']);
    // While "one." plays, "two." is already being synthesized.
    expect(f.asked).toEqual(['one.', 'two.']);
    f.answer('two.');
    f.finish();
    await f.tick();
    await f.tick();
    expect(f.played).toEqual(['one.', 'two.']);
    f.answer('three.');
    f.finish();
    await f.tick();
    await f.tick();
    f.finish();
    await done;
    expect(f.played).toEqual(['one.', 'two.', 'three.']);
    expect(player.snapshot()).toMatchObject({ id: null, phase: 'idle', error: null });
  });

  it('stops at once, and a new reading replaces the one before', async () => {
    const f = fakes();
    const player = new SpeechPlayer(f.deps);
    const first = player.play('m1', ['a.', 'b.'], { language: null, source: 'hub' });
    await f.tick();
    player.play('m2', ['c.'], { language: null, source: 'hub' });
    expect(player.snapshot().id).toBe('m2');
    f.answer('a.');
    await first;
    expect(f.played).toEqual([]);
    player.stop();
    expect(player.snapshot()).toMatchObject({ id: null, phase: 'idle' });
  });

  it('reads chunks pushed while a reply streams, and ends after the last', async () => {
    const f = fakes();
    const player = new SpeechPlayer(f.deps);
    const reading = player.open('voice-mode', { language: 'ar', source: 'hub' });
    await f.tick();
    expect(f.asked).toEqual([]);
    reading.push('أولًا.');
    await f.tick();
    expect(f.asked).toEqual(['أولًا.']);
    f.answer('أولًا.');
    await f.tick();
    await f.tick();
    reading.push('ثانيًا.');
    reading.end();
    f.finish();
    await f.tick();
    f.answer('ثانيًا.');
    await f.tick();
    await f.tick();
    f.finish();
    await reading.done;
    expect(f.played).toEqual(['أولًا.', 'ثانيًا.']);
  });

  it('says why a reading failed, next to what failed', async () => {
    const player = new SpeechPlayer({
      synthesize: () => Promise.reject(new Error('no voice')),
      playAudio: async () => {},
      describe: () => ({ message: 'No text-to-speech provider is ready.', missingVoice: true }),
    });
    await player.play('m9', ['hello.'], { language: 'en', source: 'hub' });
    expect(player.snapshot()).toMatchObject({
      id: null,
      phase: 'idle',
      error: { id: 'm9', message: 'No text-to-speech provider is ready.', missingVoice: true },
    });
  });
});
