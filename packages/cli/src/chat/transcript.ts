// A pure reducer from `/rt/sessions` envelopes to terminal output for one session. Nothing
// here touches a socket or a stream, so the rendering is unit-tested on its own.
import type { Translator } from '../i18n/index.js';
import type { Style } from '../output.js';
import type { Envelope } from '../realtime.js';
import type { Approval, Message, Run, Session, ToolCall, Usage } from '../types.js';

export type Chunk =
  | { kind: 'text'; text: string }
  | { kind: 'line'; text: string }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'run'; status: 'succeeded' | 'failed' | 'cancelled'; run: Run }
  | { kind: 'deleted' };

export interface TranscriptState {
  /** Highest `seq` seen; sent back as `after_seq` when resubscribing. */
  lastSeq: number;
  /** The assistant message currently streaming, once its prefix was printed. */
  streamingMessageId: string | null;
  /** True while the cursor sits at the end of streamed text (a line needs a newline first). */
  textOpen: boolean;
  reasoningOpen: boolean;
  runs: Record<string, Run['status']>;
}

export interface TranscriptOptions {
  sessionId: string;
  t: Translator;
  style: Style;
  showReasoning: boolean;
  /** Message ids this client sent itself; not echoed back. */
  ownMessageIds: ReadonlySet<string>;
  /** Texts this client sent whose ids are not known yet (the event can beat the HTTP answer). */
  ownTexts: ReadonlySet<string>;
}

export function initialState(): TranscriptState {
  return { lastSeq: 0, streamingMessageId: null, textOpen: false, reasoningOpen: false, runs: {} };
}

export function belongsToSession(envelope: Envelope, sessionId: string): boolean {
  const p = envelope.payload as Record<string, unknown>;
  if (typeof p.session_id === 'string') return p.session_id === sessionId;
  for (const key of ['message', 'run', 'approval'] as const) {
    const entity = p[key] as { session_id?: unknown } | undefined;
    if (entity && typeof entity === 'object') return entity.session_id === sessionId;
  }
  const session = p.session as { id?: unknown } | undefined;
  if (session && typeof session === 'object') return session.id === sessionId;
  return false;
}

export function reduce(
  state: TranscriptState,
  envelope: Envelope,
  options: TranscriptOptions,
): { state: TranscriptState; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  let next: TranscriptState = { ...state, lastSeq: Math.max(state.lastSeq, envelope.seq) };
  if (!belongsToSession(envelope, options.sessionId)) return { state: next, chunks };
  const { t, style } = options;
  const p = envelope.payload as Record<string, unknown>;

  const closeText = () => {
    if (next.textOpen || next.reasoningOpen) {
      chunks.push({ kind: 'text', text: '\n' });
      next = { ...next, textOpen: false, reasoningOpen: false };
    }
  };
  const line = (text: string) => {
    closeText();
    chunks.push({ kind: 'line', text });
  };

  switch (envelope.event) {
    case 'message.created': {
      const message = p.message as Message;
      if (options.ownMessageIds.has(message.id)) break;
      if (message.role !== 'assistant' && options.ownTexts.has(textOf(message))) break;
      if (message.role === 'assistant' && message.status === 'streaming') {
        closeText();
        chunks.push({ kind: 'text', text: `${style.bold(message.author.name)}: ` });
        next = { ...next, streamingMessageId: message.id, textOpen: true };
        break;
      }
      const text = textOf(message);
      const who = message.role === 'system' ? message.author.name : t('chat.you');
      line(`${style.bold(who)}: ${text}`);
      break;
    }
    case 'message.delta': {
      const messageId = p.message_id as string;
      if (next.reasoningOpen) {
        chunks.push({ kind: 'text', text: '\n' });
        next = { ...next, reasoningOpen: false };
      }
      if (next.streamingMessageId !== messageId) {
        closeText();
        next = { ...next, streamingMessageId: messageId };
      }
      chunks.push({ kind: 'text', text: p.delta as string });
      next = { ...next, textOpen: true };
      break;
    }
    case 'reasoning.delta': {
      if (!options.showReasoning) break;
      if (!next.reasoningOpen) {
        closeText();
        chunks.push({ kind: 'text', text: style.dim('~ ') });
      }
      chunks.push({ kind: 'text', text: style.dim(p.delta as string) });
      next = { ...next, reasoningOpen: true };
      break;
    }
    case 'tool.started': {
      const call = p.tool_call as ToolCall;
      line(
        style.cyan(
          `  * ${t('chat.tool_started', { name: call.name, preview: call.preview ?? '' }).trimEnd()}`,
        ),
      );
      break;
    }
    case 'tool.completed': {
      const call = p.tool_call as ToolCall;
      const duration = call.duration_ms === null ? '' : ` (${formatDuration(call.duration_ms)})`;
      line(style.dim(`  = ${t('chat.tool_done', { name: call.name, duration })}`));
      const output = firstLine(call.output);
      if (output) line(style.dim(`    ${output}`));
      break;
    }
    case 'tool.failed': {
      const call = p.tool_call as ToolCall;
      line(style.red(`  ! ${t('chat.tool_failed', { name: call.name })}`));
      const output = firstLine(call.output);
      if (output) line(style.red(`    ${output}`));
      break;
    }
    case 'run.queued': {
      const run = p.run as Run;
      next = { ...next, runs: { ...next.runs, [run.id]: run.status } };
      if (run.queue_position !== null && run.queue_position > 1)
        line(style.dim(t('chat.queued', { position: run.queue_position })));
      break;
    }
    case 'run.started': {
      const run = p.run as Run;
      next = { ...next, runs: { ...next.runs, [run.id]: run.status } };
      break;
    }
    case 'run.completed': {
      const run = p.run as Run;
      closeText();
      next = { ...next, runs: { ...next.runs, [run.id]: run.status }, streamingMessageId: null };
      chunks.push({ kind: 'line', text: style.dim(formatUsage(run.usage, t)) });
      chunks.push({ kind: 'run', status: 'succeeded', run });
      break;
    }
    case 'run.failed': {
      const run = p.run as Run;
      closeText();
      next = { ...next, runs: { ...next.runs, [run.id]: run.status }, streamingMessageId: null };
      chunks.push({
        kind: 'line',
        text: style.red(
          t('chat.run_failed', { error: run.error?.error ?? '?', code: run.error?.code ?? '?' }),
        ),
      });
      chunks.push({ kind: 'run', status: 'failed', run });
      break;
    }
    case 'run.cancelled': {
      const run = p.run as Run;
      closeText();
      next = { ...next, runs: { ...next.runs, [run.id]: run.status }, streamingMessageId: null };
      chunks.push({ kind: 'line', text: style.yellow(t('chat.run_cancelled')) });
      chunks.push({ kind: 'run', status: 'cancelled', run });
      break;
    }
    case 'approval.requested': {
      const approval = p.approval as Approval;
      closeText();
      chunks.push({ kind: 'approval', approval });
      break;
    }
    case 'approval.resolved': {
      const approval = p.approval as Approval;
      line(style.dim(t('chat.approval_resolved', { status: approval.status })));
      break;
    }
    case 'session.deleted': {
      closeText();
      chunks.push({ kind: 'line', text: style.yellow(t('chat.session_deleted')) });
      chunks.push({ kind: 'deleted' });
      break;
    }
    default:
      // session.created / session.updated / context.updated carry nothing to print.
      break;
  }
  return { state: next, chunks };
}

export function textOf(message: Pick<Message, 'content'>): string {
  return message.content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'location':
          return `[location ${block.latitude},${block.longitude}]`;
        default:
          return `[${block.type} ${block.name}]`;
      }
    })
    .join('\n');
}

export function firstLine(output: string | null | undefined, max = 160): string {
  if (!output) return '';
  const line = output.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatUsage(usage: Usage | null, t: Translator): string {
  if (!usage) return t('chat.usage', { input: 0, output: 0, cost: '' });
  const cost = usage.cost ? ` · ${usage.cost.amount} ${usage.cost.currency}` : '';
  return t('chat.usage', { input: usage.input_tokens, output: usage.output_tokens, cost });
}

export function sessionTitle(session: Pick<Session, 'title'>, t: Translator): string {
  return session.title ?? t('sessions.untitled');
}
