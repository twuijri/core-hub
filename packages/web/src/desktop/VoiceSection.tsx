/**
 * Voice, inside This device (B11): a folded part, not a page of its own.
 *
 * In the desktop app dictation and reading aloud go through the hub exactly as in a browser
 * (`voice/`): the microphone records here and the hub's speech-to-text writes it out; the hub's
 * text-to-speech speaks a reply. What belongs to this computer is the microphone itself, so this
 * part says what the OS answered for the app (macOS and Windows keep a switch; Linux has none),
 * offers the OS's own question or its settings, and has two tests: record a few seconds and have
 * the hub write them out, and have the hub read a sentence aloud.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { useSpeechSettings } from '../models/queries.js';
import { Badge, Button, Notice } from '../ui/index.js';
import { playThroughAudioElement } from '../voice/player.js';
import { recordingMime } from '../voice/recorder.js';
import { canRecord } from '../voice/useDictation.js';
import { dictationErrorOf, synthesize, transcribe } from '../voice/speech-api.js';
import { STT_SETUP, TTS_SETUP } from '../voice/DictationControls.js';
import type { DesktopBridge, DesktopMicState } from './bridge-types.js';
import { Fold } from './HelperSection.js';

/** How long the microphone test records. */
export const TEST_SECONDS = 4;

type MicTest =
  | { phase: 'idle' }
  | { phase: 'recording'; level: number }
  | { phase: 'transcribing' }
  | { phase: 'done'; text: string | null; heard: boolean }
  | { phase: 'error'; key: string; detail?: string };

/** Records `seconds` of sound, following its loudness (0–1) while it does. */
async function recordSample(
  seconds: number,
  onLevel: (level: number) => void,
): Promise<{ audio: Blob; peak: number; durationMs: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const mime = recordingMime((type) => MediaRecorder.isTypeSupported?.(type) ?? false);
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    let peak = 0;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        peak = Math.max(peak, level);
        onLevel(level);
      }, 100);
    } catch {
      // No level meter: the recording still goes to the hub.
    }
    const startedAt = Date.now();
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    recorder.stop();
    await stopped;
    if (timer) clearInterval(timer);
    void context?.close();
    return {
      audio: new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' }),
      peak,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function VoiceSection({ bridge }: { bridge: DesktopBridge }) {
  const { t, language } = useI18n();
  const { client } = useAuth();
  const speech = useSpeechSettings();
  const [mic, setMic] = useState<DesktopMicState | null>(null);
  const [test, setTest] = useState<MicTest>({ phase: 'idle' });
  const [speaking, setSpeaking] = useState<'idle' | 'loading' | 'playing' | 'failed'>('idle');
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void bridge.voice
      ?.mic()
      .then((next) => live.current && setMic(next))
      .catch(() => {});
    return () => {
      live.current = false;
    };
  }, [bridge]);

  const sttReady = speech.data?.stt?.ready === true;
  const ttsReady = speech.data?.tts?.ready === true;
  const status = mic?.status ?? 'unknown';
  const micKey = status.replace('-', '_');
  const badge = (
    <Badge tone={status === 'granted' ? 'success' : status === 'unknown' ? 'neutral' : 'warning'}>
      {t(`desktop_voice.mic_${micKey}`)}
    </Badge>
  );

  const runTest = async () => {
    if (!canRecord()) {
      setTest({ phase: 'error', key: 'mic_unavailable' });
      return;
    }
    setTest({ phase: 'recording', level: 0 });
    let sample: Awaited<ReturnType<typeof recordSample>>;
    try {
      sample = await recordSample(TEST_SECONDS, (level) => {
        if (live.current) setTest({ phase: 'recording', level });
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (live.current)
        setTest({
          phase: 'error',
          key:
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'mic_denied'
              : 'mic_unavailable',
        });
      void bridge.voice?.mic().then((next) => live.current && setMic(next));
      return;
    }
    const heard = sample.peak > 0.02;
    if (!sttReady) {
      if (live.current) setTest({ phase: 'done', text: null, heard });
      return;
    }
    setTest({ phase: 'transcribing' });
    try {
      const result = await transcribe(client, {
        audio: sample.audio,
        language: null,
        durationMs: sample.durationMs,
      });
      if (live.current) setTest({ phase: 'done', text: result.text, heard: true });
    } catch (error) {
      if (!live.current) return;
      const reason = dictationErrorOf(error);
      setTest(
        reason === 'no_speech'
          ? { phase: 'done', text: null, heard: false }
          : { phase: 'error', key: reason, detail: error instanceof Error ? error.message : '' },
      );
    }
  };

  const runSpeak = async () => {
    setSpeaking('loading');
    try {
      const audio = await synthesize(client, { text: t('desktop_voice.sample'), language });
      setSpeaking('playing');
      await playThroughAudioElement(audio, new AbortController().signal);
      if (live.current) setSpeaking('idle');
    } catch {
      if (live.current) setSpeaking('failed');
    }
  };

  return (
    <Fold title={t('this_device.voice')} badge={badge} testId="desktop-voice">
      <p className="text-sm text-muted">{t('desktop_voice.intro')}</p>
      <p className="text-sm" data-testid="desktop-voice-mic">
        {t('desktop_voice.mic_label')} {t(`desktop_voice.mic_${micKey}_hint`)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {status === 'not-determined' && bridge.voice && (
          <Button
            variant="secondary"
            data-testid="desktop-voice-ask"
            onClick={() => void bridge.voice?.askMic().then((next) => live.current && setMic(next))}
          >
            {t('desktop_voice.ask')}
          </Button>
        )}
        {(status === 'denied' || status === 'restricted') && mic?.canOpenSettings && (
          <Button
            variant="secondary"
            data-testid="desktop-voice-settings"
            onClick={() => void bridge.voice?.openMicSettings()}
          >
            {t('desktop_voice.open_settings')}
          </Button>
        )}
      </div>

      {!speech.isPending && (!sttReady || !ttsReady) && (
        <Notice>
          {t(
            !sttReady && !ttsReady
              ? 'desktop_voice.no_providers'
              : !sttReady
                ? 'desktop_voice.no_stt'
                : 'desktop_voice.no_tts',
          )}{' '}
          <Link to={!sttReady ? STT_SETUP() : TTS_SETUP()} className="text-link">
            {t('voice.open_models')}
          </Link>
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          data-testid="desktop-voice-test"
          disabled={test.phase === 'recording' || test.phase === 'transcribing'}
          onClick={() => void runTest()}
        >
          {test.phase === 'recording'
            ? t('desktop_voice.testing', { seconds: String(TEST_SECONDS) })
            : test.phase === 'transcribing'
              ? t('voice.transcribing')
              : t('desktop_voice.test')}
        </Button>
        {ttsReady && (
          <Button
            variant="secondary"
            data-testid="desktop-voice-speak"
            disabled={speaking === 'loading' || speaking === 'playing'}
            onClick={() => void runSpeak()}
          >
            {speaking === 'loading' ? t('voice.loading_audio') : t('desktop_voice.speak_test')}
          </Button>
        )}
      </div>
      {test.phase === 'recording' && (
        <div
          className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface-2"
          role="meter"
          aria-label={t('desktop_voice.level')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(test.level * 100)}
        >
          <div className="h-full bg-accent" style={{ width: `${Math.round(test.level * 100)}%` }} />
        </div>
      )}
      {test.phase === 'done' && (
        <Notice tone={test.heard ? 'success' : 'warning'} testId="desktop-voice-result">
          {test.text
            ? t('desktop_voice.heard_text', { text: test.text })
            : test.heard
              ? t('desktop_voice.heard_sound')
              : t('desktop_voice.heard_nothing')}
        </Notice>
      )}
      {test.phase === 'error' && (
        <Notice tone="danger" testId="desktop-voice-result">
          {t(`voice.error.${test.key}`, { detail: test.detail ?? '' })}
        </Notice>
      )}
      {speaking === 'failed' && <Notice tone="danger">{t('desktop_voice.speak_failed')}</Notice>}
    </Fold>
  );
}
