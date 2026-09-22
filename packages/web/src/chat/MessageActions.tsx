/**
 * What a person can do with one message, under it, and only when they are near it.
 *
 * Owner decision, 2026-09-22: the row is invisible until the pointer approaches — «اذا ما
 * قربت تختفي واذا قربت تطلع» — so a long transcript reads as text and not as a wall of
 * buttons. It stays visible while anything inside it has keyboard focus, because a row
 * that only exists for the mouse does not exist at all.
 *
 * Four things and a fifth that is coming: the time it was said, copy, reply to it, fork
 * the conversation from it, and speak it — which is disabled and says why, because
 * `models.transcribe` and its voice are a later phase and a button that lies is worse
 * than a button that waits.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import type { Message } from '../types.js';
import { Button } from '../ui/Button.js';
import { IconCheck, IconCopy, IconFork, IconReply, IconSpeak } from '../ui/icons.js';
import { Tooltip } from '../ui/Tooltip.js';
import { textOf } from './transcript.js';

/** The clock time of a message, in the reading language. */
export function messageTime(message: Message, language: string): string {
  const stamp = Date.parse(message.created_at);
  if (Number.isNaN(stamp)) return '';
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(stamp);
}

export function MessageActions({
  message,
  onReply,
  onFork,
}: {
  message: Message;
  onReply?: ((message: Message) => void) | undefined;
  onFork?: ((message: Message) => void) | undefined;
}) {
  const { t, language } = useI18n();
  const [copied, setCopied] = useState(false);
  const text = textOf(message);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // A browser that refuses the clipboard is not an error worth a dialog; the tick
      // simply does not appear.
    }
  };

  return (
    <div className="msg-actions" data-testid="message-actions">
      <span className="msg-time">{messageTime(message, language)}</span>
      <Tooltip label={t('chat.speak_later')}>
        {/* Disabled controls take no pointer events, so the reason hangs off a focusable
            wrapper — otherwise nobody would ever read it. */}
        <span tabIndex={0} data-testid="message-speak-wrap">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            disabled
            aria-label={t('chat.speak')}
            icon={<IconSpeak size={14} />}
          />
        </span>
      </Tooltip>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        tooltip={copied ? t('chat.copied') : t('chat.copy')}
        aria-label={t('chat.copy')}
        icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        onClick={() => void copy()}
        data-testid="message-copy"
      />
      {onReply && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          tooltip={t('chat.reply')}
          aria-label={t('chat.reply')}
          icon={<IconReply size={14} />}
          onClick={() => onReply(message)}
          data-testid="message-reply"
        />
      )}
      {onFork && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          tooltip={t('chat.fork_here')}
          aria-label={t('chat.fork_here')}
          icon={<IconFork size={14} />}
          onClick={() => onFork(message)}
          data-testid="message-fork"
        />
      )}
    </div>
  );
}
