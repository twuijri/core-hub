/**
 * Voice on a chat screen (contract decision §63): the one player every speaker button and
 * voice mode share, where its sound comes from, and the person's voice preferences.
 *
 * - The sound is the hub's TTS (`models.synthesize`) whenever the profile's provider is
 *   ready. Only when it is not, and the browser has a voice of its own, is that used — and
 *   the button says so. With neither, pressing a speaker says there is no voice and links
 *   to Models.
 * - The preferences are the person's own, on the hub: `Preferences.voice`
 *   (`dictation_language`, `auto_speak`). The web leaves `input_mode` / `output_mode` to the
 *   phones (DECISIONS §63).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { usePreferences, useSavePreferences } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { useSpeechSettings } from '../models/queries.js';
import type { Message, Preferences } from '../types.js';
import { textOf } from '../chat/transcript.js';
import { languageOf, speakableChunks } from './chunking.js';
import {
  SpeechPlayer,
  browserCanSpeak,
  playThroughAudioElement,
  speakWithBrowser,
  type PlayerSnapshot,
  type VoiceSource,
} from './player.js';
import { isMissingVoice, synthesize } from './speech-api.js';

export type DictationLanguage = 'auto' | 'ar' | 'en';

export interface VoicePreferences {
  /** `auto`, `ar` or `en`; `app` (the UI's language) is shown as the UI's own. */
  dictationLanguage: string;
  autoSpeak: boolean;
  setDictationLanguage(value: DictationLanguage): void;
  setAutoSpeak(value: boolean): void;
  saving: boolean;
}

/** The person's voice preferences, written back whole (`auth.setPreferences` is a PUT). */
export function useVoicePreferences(): VoicePreferences {
  const preferences = usePreferences();
  const save = useSavePreferences();
  const data = preferences.data as Preferences | undefined;
  const write = useCallback(
    (voice: Partial<Preferences['voice']>) => {
      if (!data) return;
      save.mutate({ ...data, voice: { ...data.voice, ...voice } });
    },
    [data, save],
  );
  return {
    dictationLanguage: data?.voice?.dictation_language ?? 'auto',
    autoSpeak: data?.voice?.auto_speak ?? false,
    setDictationLanguage: (value) => write({ dictation_language: value }),
    setAutoSpeak: (value) => write({ auto_speak: value }),
    saving: save.isPending,
  };
}

interface VoiceValue {
  player: SpeechPlayer;
  /** Where a reply's sound comes from now; null when nothing can speak. */
  source: VoiceSource | null;
  /** Reads a message aloud, or stops it when it is the one being read. */
  toggle(message: Message): void;
}

const VoiceContext = createContext<VoiceValue | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth();
  const { t } = useI18n();
  const speech = useSpeechSettings();
  const clientRef = useRef(client);
  clientRef.current = client;
  const tRef = useRef(t);
  tRef.current = t;

  const player = useMemo(
    () =>
      new SpeechPlayer({
        synthesize: (text, language, signal) =>
          synthesize(clientRef.current, { text, language }, signal),
        playAudio: playThroughAudioElement,
        speakLocally: browserCanSpeak() ? speakWithBrowser : undefined,
        describe: (error) => ({
          message: isMissingVoice(error)
            ? tRef.current('voice.no_tts')
            : describeError(error, tRef.current),
          missingVoice: isMissingVoice(error),
        }),
      }),
    [],
  );
  useEffect(() => () => player.stop(), [player]);

  const source: VoiceSource | null =
    speech.data?.tts?.ready === true ? 'hub' : browserCanSpeak() ? 'browser' : null;

  const toggle = useCallback(
    (message: Message) => {
      if (player.snapshot().id === message.id) {
        player.stop();
        return;
      }
      const text = textOf(message);
      const language = languageOf(text);
      // With no voice anywhere the hub is still asked: its `422` names what is missing,
      // and the button says it with the way to Models.
      void player.play(message.id, speakableChunks(text), { language, source: source ?? 'hub' });
    },
    [player, source],
  );

  const value = useMemo(() => ({ player, source, toggle }), [player, source, toggle]);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

/** The chat screen's voice, or null where there is none (a composer outside a chat). */
export function useVoice(): VoiceValue | null {
  return useContext(VoiceContext);
}

const NO_PLAYER: PlayerSnapshot = { id: null, phase: 'idle', source: null, error: null };
const noSubscribe = () => () => {};

export function usePlayerSnapshot(player: SpeechPlayer | null | undefined): PlayerSnapshot {
  return useSyncExternalStore(
    player?.subscribe ?? noSubscribe,
    player?.snapshot ?? (() => NO_PLAYER),
    player?.snapshot ?? (() => NO_PLAYER),
  );
}

/**
 * «اقرأ الردود تلقائيًا» / "Read replies aloud": the reply that finishes at the end of the
 * conversation while it is open is read once. What was there when it opened is not, and
 * neither is an older page joining at the top.
 */
export function useAutoRead(messages: readonly Message[], enabled: boolean, ready: boolean) {
  const voice = useVoice();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (seen.current === null) {
      seen.current = new Set(messages.map((message) => message.id));
      return;
    }
    const last = messages.at(-1);
    if (!last || last.role !== 'assistant' || last.status !== 'complete') return;
    if (seen.current.has(last.id)) return;
    seen.current.add(last.id);
    if (enabled && voice && textOf(last).trim()) voice.toggle(last);
  }, [messages, enabled, ready, voice]);
}
