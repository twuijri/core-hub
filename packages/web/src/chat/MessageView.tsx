/**
 * One message, on its side of the conversation.
 *
 * Owner decision, 2026-09-22 (docs/clients/DESIGN.md §The conversation): **the person is
 * always on the right, the agent always on the left, in every locale.** The side is
 * physical and is fixed in styles/chat.css; nothing here reads the language to decide it.
 * Each message's *content* still decides its own direction with `dir="auto"`, so an
 * Arabic sentence reads right-to-left inside a bubble that is itself on the right.
 *
 * Consecutive messages from the same speaker are grouped (`turns.ts`): the name and the
 * avatar are drawn once, and the gap above a grouped message is the tighter one. That
 * difference in spacing is what makes a turn read as one thing.
 */
import { useI18n } from '../i18n/context.js';
import type { Message, Run } from '../types.js';
import { Avatar } from '../ui/Avatar.js';
import { Badge } from '../ui/Badge.js';
import { agentMark } from '../ui/brand/marks.js';
import { MessageActions } from './MessageActions.js';
import { Markdown } from './Markdown.js';
import { Reasoning } from './Reasoning.js';
import { ToolCallCard } from './ToolCallCard.js';
import { textOf } from './transcript.js';
import { sideOf, thoughtSeconds, type Turn } from './turns.js';

/**
 * What the turn cost, in words a person can read — or nothing at all.
 *
 * The hub sends micro-USD as a six-decimal string and `null` when the model carries no
 * price (`modules/models/service.ts` §costOf). Three cases, and none of them is a lie:
 * no price is no line, a free model says so, and anything else is rounded to where the
 * digits stop being noise. It is an estimate either way, and the caller says so.
 */
export function costLabel(cost: { amount: string; currency: string } | null): string | null {
  if (!cost) return null;
  const value = Number(cost.amount);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return `0 ${cost.currency}`;
  const digits = value < 0.01 ? 4 : 2;
  return `${value.toFixed(digits)} ${cost.currency}`;
}

function Attachments({ message }: { message: Message }) {
  const { t } = useI18n();
  const blocks = message.content.filter((b) => b.type !== 'text');
  if (blocks.length === 0) return null;
  return (
    <ul className="msg-attachments">
      {blocks.map((block, i) => (
        <li key={i}>
          <Badge>
            {block.type === 'location'
              ? `${t('chat.location')} ${block.latitude.toFixed(4)}, ${block.longitude.toFixed(4)}`
              : (block.name ?? block.type)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function MessageView({
  message,
  grouped = false,
  showReasoning,
  showCost = false,
  runs = {},
  markSlug,
  onReply,
  onFork,
}: {
  message: Message;
  /** Continues the turn above it: no name, no avatar, the tighter gap. */
  grouped?: boolean;
  showReasoning: boolean;
  /** `preferences.show_cost`: the estimate is off by default and says it is an estimate. */
  showCost?: boolean;
  /** The session's runs, so a finished turn can say how long it thought. */
  runs?: Record<string, Run>;
  /**
   * The catalog slug of the agent that wrote this, so the reply can wear its mark.
   * Resolved by the caller from the registry: `Author` carries an id, not a slug, and a
   * message must stay a thing that can be drawn without a hub behind it.
   */
  markSlug?: string | undefined;
  onReply?: ((message: Message) => void) | undefined;
  onFork?: ((message: Message) => void) | undefined;
}) {
  const { t } = useI18n();
  const side = sideOf(message);
  const text = textOf(message);

  if (side === 'system') {
    return (
      <article className="msg-system" data-testid="message-system">
        <span dir="auto">{text}</span>
      </article>
    );
  }

  if (side === 'user') {
    return (
      <article
        className="msg"
        data-side="user"
        data-grouped={grouped ? 'true' : 'false'}
        data-testid="message-user"
        data-role={message.role}
      >
        <div className="msg-stack">
          {!grouped && (
            <header className="msg-head">
              <span className="msg-name">{t('chat.you')}</span>
            </header>
          )}
          <div className="msg-bubble msg-user" data-role={message.role}>
            <p dir="auto">{text}</p>
            <Attachments message={message} />
          </div>
          <MessageActions message={message} onFork={onFork} />
        </div>
      </article>
    );
  }

  const streaming = message.status === 'streaming';
  const name = message.author.name || t('chat.assistant');
  const seconds = thoughtSeconds(message, runs);
  return (
    <article
      className="msg"
      data-side="agent"
      data-grouped={grouped ? 'true' : 'false'}
      data-testid="message-assistant"
      data-status={message.status}
    >
      {grouped ? (
        <span className="msg-gutter" aria-hidden />
      ) : (
        <Avatar
          name={name}
          src={message.author.avatar?.url ?? null}
          size="sm"
          mark={agentMark(markSlug ?? '', 16)}
        />
      )}
      <div className="msg-stack">
        {!grouped && (
          <header className="msg-head">
            <span className="msg-name" dir="auto">
              {name}
            </span>
            {streaming && <Badge tone="info">{t('chat.streaming')}</Badge>}
            {message.status === 'failed' && <Badge tone="danger">{t('chat.failed')}</Badge>}
            {message.status === 'interrupted' && (
              <Badge tone="warning">{t('chat.interrupted')}</Badge>
            )}
          </header>
        )}
        <div className="msg-agent-body">
          {/* The reasoning of a *finished* turn only: while the run is alive it is the
              status line above the composer, not a fold in the transcript. */}
          {showReasoning && !streaming && message.reasoning?.text && (
            <Reasoning text={message.reasoning.text} seconds={seconds} />
          )}
          {message.tool_calls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
          {text ? <Markdown text={text} /> : null}
        </div>
        {message.usage && !streaming && (
          <p className="msg-usage" dir="auto">
            {t('chat.usage', {
              input: message.usage.input_tokens,
              output: message.usage.output_tokens,
            })}
            {showCost && costLabel(message.usage.cost) !== null
              ? ` · ${t('chat.estimated', { amount: costLabel(message.usage.cost) as string })}`
              : ''}
          </p>
        )}
        {!streaming && <MessageActions message={message} onReply={onReply} onFork={onFork} />}
      </div>
    </article>
  );
}

/** The transcript: the turns of `turns.ts`, each drawn on its own side. */
export function Transcript({
  turns,
  showReasoning,
  showCost = false,
  runs,
  slugOf,
  onReply,
  onFork,
}: {
  turns: readonly Turn[];
  showReasoning: boolean;
  showCost?: boolean;
  runs: Record<string, Run>;
  /** The registry's answer for an author id; the transcript itself asks no questions. */
  slugOf?: ((authorId: string | null) => string | undefined) | undefined;
  onReply?: ((message: Message) => void) | undefined;
  onFork?: ((message: Message) => void) | undefined;
}) {
  return (
    <>
      {turns.map((turn) => (
        <MessageView
          key={turn.message.id}
          message={turn.message}
          grouped={turn.grouped}
          showReasoning={showReasoning}
          showCost={showCost}
          runs={runs}
          markSlug={slugOf?.(turn.message.author.id ?? null)}
          onReply={onReply}
          onFork={onFork}
        />
      ))}
    </>
  );
}
