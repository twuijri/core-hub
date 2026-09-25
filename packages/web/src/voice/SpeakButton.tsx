/**
 * The speaker under a reply (contract decision §54): reads it aloud through the hub's TTS,
 * or stops it. While the audio is being prepared the button says so; a reply that could not
 * be read says why beside it — with the way to Models when no voice is set up. Where the
 * profile has no TTS provider and the browser has a voice of its own, that voice is used and
 * the tooltip says so.
 */
import { Link } from 'react-router';
import { useI18n } from '../i18n/context.js';
import type { Message } from '../types.js';
import { Button } from '../ui/Button.js';
import { IconSpeak, IconStop } from '../ui/icons.js';
import { usePlayerSnapshot, useVoice } from './context.js';
import { TTS_SETUP } from './DictationControls.js';

export function SpeakButton({ message }: { message: Message }) {
  const { t } = useI18n();
  const voice = useVoice();
  const player = usePlayerSnapshot(voice?.player);
  if (!voice) return null;
  const mine = player.id === message.id;
  const phase = mine ? player.phase : 'idle';
  const failure = player.error?.id === message.id ? player.error : null;
  const label =
    phase === 'loading'
      ? t('voice.loading_audio')
      : phase === 'playing'
        ? t('voice.stop_speaking')
        : voice.source === 'browser'
          ? t('voice.browser_voice')
          : t('voice.speak');
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        tooltip={label}
        aria-label={label}
        aria-pressed={mine}
        data-phase={phase}
        icon={mine ? <IconStop size={14} /> : <IconSpeak size={14} />}
        onClick={() => voice.toggle(message)}
        data-testid="message-speak"
      />
      {failure && (
        <span className="msg-speak-error" role="alert" data-testid="message-speak-error">
          {failure.message}
          {failure.missingVoice && (
            <>
              {' '}
              <Link className="link underline" to={TTS_SETUP()}>
                {t('voice.open_models')}
              </Link>
            </>
          )}
        </span>
      )}
    </>
  );
}
