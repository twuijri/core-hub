/**
 * What you typed while the agent was still working.
 *
 * Owner decision, 2026-09-22: «لو ارسلت رساله والايجنت للحين يفكر ابيه يصير مثل كودكس،
 * يصير بالطابور وفيه زر اجبار ارسال… وزر Steer». So a message sent during a live run does
 * not vanish into the hub's queue where nothing can be done with it any more: it waits
 * **here**, in the browser, where it can still be changed its mind about.
 *
 * Each waiting message offers the three things the contract's `RunCreate.when` already
 * names, and nothing it does not:
 *
 * - **send now** → `next`: jump the hub's queue, run after the live turn ends;
 * - **steer** → `interrupt`: stop the live turn and take this instead — the agent keeps
 *   the conversation, so it reads as a correction rather than a new topic;
 * - **remove**: it was never sent, so there is nothing to cancel.
 *
 * When the run ends the queue drains itself in order. It lives in this tab only: a reload
 * loses what was never sent, which is the truth and is what Codex does too.
 */
import { useI18n } from '../i18n/context.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { IconClose, IconSend, IconSteer } from '../ui/icons.js';
import type { QueuedMessage } from './outbox.js';

export function MessageQueue({
  items,
  onSendNow,
  onSteer,
  onRemove,
}: {
  items: readonly QueuedMessage[];
  onSendNow(item: QueuedMessage): void;
  onSteer(item: QueuedMessage): void;
  onRemove(item: QueuedMessage): void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <section className="msg-queue" aria-label={t('queue.title')} data-testid="message-queue">
      <header className="msg-queue-head">
        <Badge tone="info" dot>
          {t('queue.title')}
        </Badge>
        <span className="ms-auto text-xs text-muted" data-testid="queue-count">
          {items.length}
        </span>
      </header>
      <ul className="msg-queue-list">
        {items.map((item, index) => (
          <li key={item.key} className="msg-queue-item" data-testid="queue-item">
            <span className="msg-queue-index" aria-hidden>
              {index + 1}
            </span>
            <span className="msg-queue-text truncate" dir="auto">
              {item.preview}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tooltip={t('queue.send_now')}
              aria-label={t('queue.send_now')}
              icon={<IconSend size={14} />}
              onClick={() => onSendNow(item)}
              data-testid="queue-send-now"
            />
            <Button
              variant="ghost"
              size="sm"
              tooltip={t('queue.steer_hint')}
              icon={<IconSteer size={14} />}
              onClick={() => onSteer(item)}
              data-testid="queue-steer"
            >
              {t('queue.steer')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tooltip={t('queue.remove')}
              aria-label={t('queue.remove')}
              icon={<IconClose size={14} />}
              onClick={() => onRemove(item)}
              data-testid="queue-remove"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
