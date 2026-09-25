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
import type { ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';
import type { Message, Run } from '../types.js';
import { highlightParts, matchRanges } from '../ui/combobox-filter.js';
import { Avatar } from '../ui/Avatar.js';
import { Badge } from '../ui/Badge.js';
import { agentMark } from '../ui/brand/marks.js';
import { MessageActions } from './MessageActions.js';
import { Markdown } from './Markdown.js';
import { Reasoning } from './Reasoning.js';
import { AnsweredQuestions } from './AnsweredQuestions.js';
import { HIT_CLASS } from './anchor.js';
import { ToolCalls } from './ToolCallCard.js';
import { textOf } from './transcript.js';
import { reasoningWorthShowing, sideOf, thoughtSeconds, type Turn } from './turns.js';

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

/** Plain text with each occurrence of `query` in `<mark>` (a searched word, anchor.ts). */
function Marked({ text, query }: { text: string; query: string | null | undefined }): ReactNode {
  const ranges = query ? matchRanges(text, query) : [];
  if (ranges.length === 0) return text;
  return highlightParts(text, ranges).map((part, index) =>
    part.hit ? (
      <mark key={index} className={HIT_CLASS}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
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
  anchored = false,
  mark = null,
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
  /** The message a search result opened the conversation at (anchor.ts): flashed once. */
  anchored?: boolean;
  /** The searched words, marked inside this message's text. */
  mark?: string | null;
  onReply?: ((message: Message) => void) | undefined;
  onFork?: ((message: Message) => void) | undefined;
}) {
  const { t } = useI18n();
  // Every message says which it is, so an anchored open can find it in the page.
  const place = {
    'data-message-id': message.id,
    ...(anchored ? { 'data-anchored': 'true' } : {}),
  };
  const side = sideOf(message);
  const text = textOf(message);

  if (side === 'system') {
    return (
      <article className="msg-system" data-testid="message-system" {...place}>
        <span dir="auto">
          <Marked text={text} query={mark} />
        </span>
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
        {...place}
      >
        <div className="msg-stack">
          {!grouped && (
            <header className="msg-head">
              <span className="msg-name">{t('chat.you')}</span>
            </header>
          )}
          <div className="msg-bubble msg-user" data-role={message.role}>
            <p dir="auto">
              <Marked text={text} query={mark} />
            </p>
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
  const reasoning =
    showReasoning && !streaming && reasoningWorthShowing(message) ? message.reasoning!.text : null;
  return (
    <article
      className="msg"
      data-side="agent"
      data-grouped={grouped ? 'true' : 'false'}
      data-testid="message-assistant"
      data-status={message.status}
      {...place}
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
        {/* Machinery beside the reply, not inside it (owner decision, 2026-09-23). */}
        <ToolCalls calls={message.tool_calls} live={streaming} />
        {/* What the agent asked and what was answered, outside the fold (owner, 2026-09-23). */}
        <AnsweredQuestions calls={message.tool_calls} />
        {(reasoning || text) && (
          <div className="msg-agent-body">
            {/* The reasoning of a *finished* turn only: while the run is alive it is the
                status line above the composer, not a fold in the transcript. */}
            {reasoning && <Reasoning text={reasoning} seconds={seconds} />}
            {text ? <Markdown text={text} mark={mark} /> : null}
          </div>
        )}
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
        {!streaming && <MessageActions message={message} onReply={onReply} onFork={onFork} speak />}
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
  anchor = null,
  onReply,
  onFork,
}: {
  turns: readonly Turn[];
  showReasoning: boolean;
  showCost?: boolean;
  runs: Record<string, Run>;
  /** The registry's answer for an author id; the transcript itself asks no questions. */
  slugOf?: ((authorId: string | null) => string | undefined) | undefined;
  /** The message a search opened the conversation at, and the words to mark in it. */
  anchor?: { messageId: string; query: string } | null;
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
          anchored={turn.message.id === anchor?.messageId}
          mark={turn.message.id === anchor?.messageId ? anchor.query : null}
          onReply={onReply}
          onFork={onFork}
        />
      ))}
    </>
  );
}
