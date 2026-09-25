/**
 * The composer's voice controls (contract decision §54): the microphone, its options menu,
 * and the one line that says what dictation is doing or why it could not.
 *
 * - The mic records while pressed once and transcribes when pressed again; the words land in
 *   the composer for the person to read before sending. Nothing is sent by dictating.
 * - The menu holds the dictation language (auto, Arabic, English), «اقرأ الردود تلقائيًا»,
 *   and voice mode where the screen offers it.
 * - With no speech-to-text provider on the hub the browser's own recognizer is used and the
 *   line says so; with neither, the line says what is missing and links to Models.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { IconChevron, IconClose, IconMic, IconStop } from '../ui/icons.js';
import { Menu, MenuChoice, MenuItem, MenuNote, MenuSeparator } from '../ui/Menu.js';
import { Notice } from '../ui/Notice.js';
import { Tooltip } from '../ui/Tooltip.js';
import { useVoicePreferences, type DictationLanguage } from './context.js';
import { isLive, pressStarts, type RecorderState } from './recorder.js';
import type { Dictation } from './useDictation.js';

/** Seconds since a take started, ticking while it records. */
export function useElapsedSeconds(state: RecorderState): number {
  const [now, setNow] = useState(() => Date.now());
  const recording = state.phase === 'recording';
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [recording]);
  return recording ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0;
}

export function MicButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  const { t } = useI18n();
  const { state } = dictation;
  const label =
    state.phase === 'recording'
      ? t('voice.stop_dictation')
      : state.phase === 'transcribing'
        ? t('voice.transcribing')
        : state.phase === 'requesting'
          ? t('voice.requesting')
          : t('voice.dictate');
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="composer-btn composer-btn-mic"
        data-phase={state.phase}
        aria-label={label}
        aria-pressed={state.phase === 'recording'}
        disabled={disabled || state.phase === 'transcribing' || state.phase === 'requesting'}
        onClick={() => (pressStarts(state) ? dictation.start() : dictation.stop())}
        data-testid="composer-mic"
      >
        {state.phase === 'recording' ? <IconStop /> : <IconMic />}
      </button>
    </Tooltip>
  );
}

const LANGUAGES: DictationLanguage[] = ['auto', 'ar', 'en'];

export function VoiceMenu({
  disabled,
  onVoiceMode,
}: {
  disabled: boolean;
  onVoiceMode?: (() => void) | undefined;
}) {
  const { t, language: ui } = useI18n();
  const preferences = useVoicePreferences();
  const current = preferences.dictationLanguage === 'app' ? ui : preferences.dictationLanguage;
  return (
    <Menu
      testId="composer-voice-menu"
      tooltip={t('voice.menu')}
      align="end"
      trigger={
        <button
          type="button"
          className="composer-btn composer-btn-narrow"
          aria-label={t('voice.menu')}
          disabled={disabled}
          data-testid="composer-voice"
        >
          <IconChevron size={14} />
        </button>
      }
    >
      <MenuNote>{t('voice.language')}</MenuNote>
      {LANGUAGES.map((value) => (
        <MenuChoice
          key={value}
          checked={current === value}
          onSelect={() => preferences.setDictationLanguage(value)}
        >
          {t(`voice.language_${value}`)}
        </MenuChoice>
      ))}
      <MenuSeparator />
      <MenuChoice
        checked={preferences.autoSpeak}
        onSelect={() => preferences.setAutoSpeak(!preferences.autoSpeak)}
      >
        {t('voice.auto_read')}
      </MenuChoice>
      {onVoiceMode && (
        <>
          <MenuSeparator />
          <MenuItem icon={<IconMic size={16} />} onSelect={onVoiceMode}>
            {t('voice.mode')}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/** Where to set up speech to text: Models, on its tab. */
export const STT_SETUP = () => `${routeOf('models')}?tab=stt_providers`;
export const TTS_SETUP = () => `${routeOf('models')}?tab=tts_providers`;

/** What dictation is doing, or why it stopped — one line above the text, never silent. */
export function DictationNotice({ dictation }: { dictation: Dictation }) {
  const { t } = useI18n();
  const { state } = dictation;
  const seconds = useElapsedSeconds(state);
  if (state.phase === 'error') {
    return (
      <Notice
        tone={state.error === 'no_speech' ? 'info' : 'danger'}
        className="composer-voice-note mb-2"
      >
        <span className="flex flex-wrap items-center gap-2" data-testid="dictation-error">
          <span>
            {state.error === 'failed'
              ? t('voice.error.failed', { detail: state.detail ?? '' })
              : t(`voice.error.${state.error}`)}
          </span>
          {state.error === 'no_provider' && (
            <Link className="link underline" to={STT_SETUP()} data-testid="dictation-setup">
              {t('voice.open_models')}
            </Link>
          )}
          <button
            type="button"
            className="ms-auto"
            aria-label={t('ui.close')}
            onClick={dictation.dismiss}
          >
            <IconClose size={12} />
          </button>
        </span>
      </Notice>
    );
  }
  if (!isLive(state)) return null;
  return (
    <p className="composer-voice-status" role="status" data-testid="dictation-status">
      <span className="composer-voice-dot" data-phase={state.phase} aria-hidden />
      <span>
        {state.phase === 'recording'
          ? t('voice.listening', { seconds })
          : state.phase === 'transcribing'
            ? t('voice.transcribing')
            : t('voice.requesting')}
      </span>
      {'engine' in state && state.engine === 'browser' && (
        <span className="text-faint" data-testid="dictation-browser">
          {t('voice.browser_engine')}
        </span>
      )}
      {state.phase === 'recording' && (
        <button type="button" className="link ms-auto underline" onClick={dictation.cancel}>
          {t('voice.cancel')}
        </button>
      )}
    </p>
  );
}
