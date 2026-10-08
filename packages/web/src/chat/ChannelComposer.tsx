// Writing into a Telegram or WhatsApp conversation from the hub (contract decision §153): an
// admin types here, the hub posts the words on the channel as «من كور هب (<name>): …» and then
// hands them to the agent, which answers on the channel. The conversation stays the channel's:
// this is the chat composer's look without what only a hub chat has (attachments, models,
// voice). A refusal is said in plain words and the text stays in the box.
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { HubApiError } from '@corehub/contracts';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Translator } from '../i18n/index.js';
import { useSendChannelMessage, type ChannelSendUnavailable } from '../sessions/channels.js';
import { IconSend } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { Tooltip } from '../ui/Tooltip.js';

/** Why a channel conversation cannot be written into, in the reader's words. */
export function sendUnavailableText(
  reason: ChannelSendUnavailable,
  channel: string,
  t: Translator,
): string {
  return t(`sessions.channels.send.unavailable.${reason}`, { channel });
}

/** A refused send, in plain words: the channel's own refusal, or why the hub would not. */
export function sendErrorText(error: unknown, channel: string, t: Translator): string {
  if (error instanceof HubApiError) {
    const details = (
      error.body as { details?: { reason?: unknown; message?: unknown } } | undefined
    )?.details;
    if (details?.reason === 'channel_send_failed') {
      return t('sessions.channels.send.error_channel', {
        channel,
        message: typeof details.message === 'string' ? details.message : '',
      });
    }
    const reasons: readonly string[] = [
      'not_admin',
      'platform_unsupported',
      'hermes_not_managed',
      'bridge_offline',
      'not_current',
      'no_route',
    ];
    if (typeof details?.reason === 'string' && reasons.includes(details.reason)) {
      return sendUnavailableText(details.reason as ChannelSendUnavailable, channel, t);
    }
  }
  return describeError(error, t);
}

let counter = 0;

export function ChannelComposer({
  id,
  channel,
  peer,
  onSending,
}: {
  id: string;
  channel: string;
  peer: string;
  /** The words on their way (shown at once in the transcript), then `null`. */
  onSending(words: { key: string; text: string } | null): void;
}) {
  const { t } = useI18n();
  const send = useSendChannelMessage(id);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const words = text.trim();
  const busy = send.isPending;

  const submit = () => {
    if (!words || busy) return;
    counter += 1;
    const key = `c-${Date.now().toString(36)}-${String(counter)}`;
    setError(null);
    setText('');
    onSending({ key, text: words });
    send.mutate(
      { text: words, client_message_id: key },
      {
        onSuccess: () => onSending(null),
        onError: (failure) => {
          onSending(null);
          // Nothing reached the agent: the words go back where they were typed.
          setText(words);
          setError(sendErrorText(failure, channel, t));
          box.current?.focus();
        },
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const placeholder = t('sessions.channels.send.placeholder', { channel, peer });
  return (
    <>
      <form
        className="composer glass"
        data-state={busy ? 'sending' : error ? 'error' : words ? 'typing' : 'empty'}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        aria-label={t('sessions.channels.send.label', { channel })}
        aria-describedby={hintId}
        data-testid="channel-composer"
      >
        {error && (
          <Notice tone="danger" className="mb-2" testId="channel-send-error">
            {error}
          </Notice>
        )}
        <div className="composer-grow" data-value={text}>
          <textarea
            ref={box}
            rows={1}
            placeholder={placeholder}
            aria-label={placeholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={4000}
            dir="auto"
            data-testid="channel-composer-input"
          />
        </div>
        <div className="composer-tools">
          <span className="composer-spacer" />
          <Tooltip label={t('sessions.channels.send.send', { channel })}>
            <button
              type="submit"
              className="composer-btn composer-btn-send"
              aria-label={t('sessions.channels.send.send', { channel })}
              disabled={!words || busy}
              data-busy={busy ? 'true' : undefined}
              data-testid="channel-send"
            >
              <IconSend />
            </button>
          </Tooltip>
        </div>
      </form>
      <p id={hintId} className="composer-reason" data-testid="channel-send-hint">
        {t('sessions.channels.send.hint', { channel })}
      </p>
    </>
  );
}
