/**
 * What a person can do with one message, under it, and only when they are near it.
 *
 * Owner decision, 2026-09-22: the row is invisible until the pointer approaches — «اذا ما
 * قربت تختفي واذا قربت تطلع» — so a long transcript reads as text and not as a wall of
 * buttons. It stays visible while anything inside it has keyboard focus, because a row
 * that only exists for the mouse does not exist at all.
 *
 * Five things: the time it was said, read it aloud (a reply only, through the hub's TTS —
 * `voice/SpeakButton.tsx`), copy, reply to it, and fork the conversation from it.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import type { Message } from '../types.js';
import { Button } from '../ui/Button.js';
import { IconCheck, IconCopy, IconFork, IconReply } from '../ui/icons.js';
import { SpeakButton } from '../voice/SpeakButton.js';
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
  speak = false,
}: {
  message: Message;
  /** Offer reading it aloud (a reply of the agent). */
  speak?: boolean;
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
      {speak && <SpeakButton message={message} />}
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
