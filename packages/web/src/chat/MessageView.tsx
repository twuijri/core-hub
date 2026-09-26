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
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDownloadAttachment } from '../attachments/queries.js';
import { useAuth } from '../auth/context.js';
import { hideRunPaths } from '../files/run-paths.js';
import { useI18n } from '../i18n/context.js';
import type { Message, Run, RunChanges } from '../types.js';
import { highlightParts, matchRanges } from '../ui/combobox-filter.js';
import { Avatar } from '../ui/Avatar.js';
import { Badge } from '../ui/Badge.js';
import { agentMark } from '../ui/brand/marks.js';
import { MessageActions } from './MessageActions.js';
import { useOpenFile, useSessionFilesOptional } from '../files/context.js';
import { lastReplyOfRuns } from '../files/changes.js';
import { RunChangesCard } from '../files/RunChangesCard.js';
import { InlineMedia, isPlayable } from './InlineMedia.js';
import { Markdown } from './Markdown.js';
import { Reasoning } from './Reasoning.js';
import { AnsweredQuestions } from './AnsweredQuestions.js';
import { HIT_CLASS } from './anchor.js';
import { ToolCalls } from './ToolCallCard.js';
import { textOf } from './transcript.js';
import { reasoningWorthShowing, sideOf, thoughtSeconds, type Turn } from './turns.js';
import { failedNames, failureReasons, fallbackOf } from './fallback.js';

/**
 * The turn moved down the fallback chain (contract decision §54): which model answered, which
 * failed before it, and why — under the reply, where its words are, never hidden in a menu.
 */
function FallbackNote({ run }: { run: Run | undefined }) {
  const { t, language } = useI18n();
  const note = fallbackOf(run);
  if (!note) return null;
  const reasons = failureReasons(note.fallback);
  return (
    <p className="msg-usage" dir="auto" data-testid="fallback-note" role="note">
      {t('chat.fallback_note', {
        failed: failedNames(note.fallback, language),
        model: note.answered,
      })}
      {reasons ? ` — ${t('chat.fallback_reason', { reason: reasons })}` : ''}
    </p>
  );
}

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

/** The keys (`attachment:<id>`) of the files a message carries. */
function ownKeysOf(message: Message): string[] {
  return message.content.flatMap((block) =>
    'attachment_id' in block && block.attachment_id ? [`attachment:${block.attachment_id}`] : [],
  );
}

/**
 * A picture on a message, drawn in it. The bytes are fetched with the bearer header and shown
 * through an object URL — a plain `<img src>` could not send the token (the contract keeps it
 * out of URLs). Until they arrive, or if they cannot, the picture is its name like any file.
 */
function InlineImage({
  attachmentId,
  name,
  mime,
  fallback,
  onOpen,
}: {
  attachmentId: string;
  name: string;
  mime: string | undefined;
  fallback: ReactNode;
  onOpen: (() => void) | null;
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const download = useDownloadAttachment();
  const bytes = useQuery({
    queryKey: ['attachment-bytes', profile, attachmentId],
    queryFn: ({ signal }) =>
      download.blob({ attachment_id: attachmentId, name, ...(mime ? { mime } : {}) }, signal),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes.data) return;
    const url = URL.createObjectURL(bytes.data);
    setSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setSrc(null);
    };
  }, [bytes.data]);
  if (!src) return <>{fallback}</>;
  const picture = <img className="msg-image" src={src} alt={name} data-testid="message-image" />;
  return onOpen ? (
    <button
      type="button"
      className="msg-image-open"
      aria-label={t('files.open', { name })}
      onClick={onOpen}
    >
      {picture}
    </button>
  ) : (
    picture
  );
}

/**
 * What a message carries besides its words: a picture drawn in place, anything else as its
 * name. Both open beside the chat, like any other file of the conversation (decision §48) —
 * on the person's messages and on the agent's replies alike.
 */
function Attachments({ message }: { message: Message }) {
  const { t } = useI18n();
  const files = useSessionFilesOptional();
  const open = useOpenFile();
  const blocks = message.content.filter((b) => b.type !== 'text');
  if (blocks.length === 0) return null;
  return (
    <ul className="msg-attachments" data-testid="message-attachments">
      {blocks.map((block, i) => {
        const label =
          block.type === 'location'
            ? `${t('chat.location')} ${block.latitude.toFixed(4)}, ${block.longitude.toFixed(4)}`
            : (block.name ?? block.type);
        // An attachment opens beside the chat, like any other file of it (decision §48).
        const key = 'attachment_id' in block ? `attachment:${block.attachment_id}` : null;
        const file = key && files ? files.fileOf(key) : undefined;
        if (block.type === 'image' && block.attachment_id) {
          return (
            <li key={i} className="msg-attachment-image">
              <InlineImage
                attachmentId={block.attachment_id}
                name={block.name ?? file?.name ?? 'image'}
                mime={block.mime ?? file?.mime}
                fallback={<Badge>{label}</Badge>}
                onOpen={file && open ? () => open(file.key) : null}
              />
            </li>
          );
        }
        const mime = 'mime' in block ? (block.mime ?? file?.mime) : file?.mime;
        // Any video or sound the browser may play, by its type or its name (§92); one it cannot
        // play falls back to the name under it.
        const playable =
          'attachment_id' in block && block.attachment_id
            ? isPlayable(mime, ('name' in block ? block.name : null) ?? file?.name)
            : null;
        const chip =
          file && open ? (
            <button
              type="button"
              className="msg-attachment-open"
              aria-label={t('files.open', { name: file.name })}
              onClick={() => open(file.key)}
              data-testid="attachment-open"
            >
              <Badge>{label}</Badge>
            </button>
          ) : (
            <Badge>{label}</Badge>
          );
        if (playable && 'attachment_id' in block && block.attachment_id) {
          // A video (a render a program made, say) plays in the reply; its name stays under it.
          return (
            <li key={i} className="msg-attachment-media">
              <InlineMedia
                attachmentId={block.attachment_id}
                name={block.name ?? file?.name ?? playable}
                kind={playable}
                fallback={null}
              />
              {chip}
            </li>
          );
        }
        return (
          <li key={i}>
            {file && open ? (
              <button
                type="button"
                className="msg-attachment-open"
                aria-label={t('files.open', { name: file.name })}
                onClick={() => open(file.key)}
                data-testid="attachment-open"
              >
                <Badge>{label}</Badge>
              </button>
            ) : (
              <Badge>{label}</Badge>
            )}
          </li>
        );
      })}
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
  notice = null,
  changes,
  onReply,
  onFork,
}: {
  message: Message;
  /** The files this reply's run changed, when it is the run's last reply (decision §49). */
  changes?: RunChanges | undefined;
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
  /** Drawn under this message, inside its turn: the failure of the run it belongs to. */
  notice?: ReactNode;
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
  const own = useMemo(() => ownKeysOf(message), [message]);

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
          {notice}
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
            {/* The run folder's path is drawn as the file's name (`files/run-paths.ts`). */}
            {text ? <Markdown text={hideRunPaths(text)} mark={mark} own={own} /> : null}
          </div>
        )}
        {/* The files the reply carries: what the agent left in the run's output folder. */}
        {!streaming && <Attachments message={message} />}
        {changes && !streaming && <RunChangesCard changes={changes} />}
        {!streaming && <FallbackNote run={message.run_id ? runs[message.run_id] : undefined} />}
        {message.usage && !streaming && (
          <p className="msg-usage" dir="auto">
            {message.run_id && runs[message.run_id]?.model
              ? `${t('chat.answered_by', { model: runs[message.run_id]?.model ?? '' })} · `
              : ''}
            {t('chat.usage', {
              input: message.usage.input_tokens,
              output: message.usage.output_tokens,
            })}
            {showCost && costLabel(message.usage.cost) !== null
              ? ` · ${t('chat.estimated', { amount: costLabel(message.usage.cost) as string })}`
              : ''}
          </p>
        )}
        {notice}
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
  noticeFor,
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
  /** What hangs under a message: a failed run's notice, on the turn that failed. */
  noticeFor?: ((message: Message) => ReactNode) | undefined;
  onReply?: ((message: Message) => void) | undefined;
  onFork?: ((message: Message) => void) | undefined;
}) {
  const files = useSessionFilesOptional();
  // A run's "files changed" card goes under its last reply only.
  const lastReply = useMemo(() => lastReplyOfRuns(turns.map((turn) => turn.message)), [turns]);
  const changesOf = (message: Message): RunChanges | undefined =>
    message.run_id && lastReply.get(message.run_id) === message.id
      ? files?.changes.get(message.run_id)
      : undefined;
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
          notice={noticeFor?.(turn.message) ?? null}
          changes={changesOf(turn.message)}
          onReply={onReply}
          onFork={onFork}
        />
      ))}
    </>
  );
}
