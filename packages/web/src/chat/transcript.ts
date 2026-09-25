// A pure reducer from `/rt/sessions` envelopes to the state of one open session. Nothing here
// touches a socket or React, so streaming, tool folding, approvals and resume are unit-tested
// on their own (tests/transcript.test.ts).
import type { Envelope } from '../realtime/envelope.js';
import type { Approval, Message, Run, Session, SessionDetail, ToolCall } from '../types.js';

export interface ChatState {
  /** Highest `seq` seen; sent back as `after_seq` when resubscribing. */
  lastSeq: number;
  session: Session | null;
  messages: Message[];
  runs: Record<string, Run>;
  /** Pending approvals by id. */
  approvals: Record<string, Approval>;
  context: Session['context'];
  /**
   * The agent compressing this conversation's context (`context.compression`, decision §52):
   * `running` between `started` and its end, then the last outcome until the next one.
   */
  compression: Compression | null;
  deleted: boolean;
  /**
   * Whether messages older than `messages[0]` exist on the hub (`MessagePage.has_more`).
   * The transcript holds the newest page and whatever the person paged back through.
   */
  hasOlder: boolean;
  /** Whether this view has loaded any page before the newest one. */
  pagedBack: boolean;
}

export interface Compression {
  phase: 'running' | 'finished' | 'failed';
  trigger: 'manual' | 'auto';
  beforeTokens: number | null;
  afterTokens: number | null;
  /** The agent's own words about it, untranslated. */
  message: string | null;
}

export function initialChat(): ChatState {
  return {
    lastSeq: 0,
    session: null,
    messages: [],
    runs: {},
    approvals: {},
    context: null,
    compression: null,
    deleted: false,
    hasOlder: false,
    pagedBack: false,
  };
}

/**
 * Replace the base state with what HTTP returned, keeping the realtime cursor.
 * `page.hasOlder`: whether the hub has messages before the first of `messages`;
 * `page.pagedBack`: whether `messages` reaches further back than the newest page.
 */
export function hydrate(
  state: ChatState,
  detail: SessionDetail,
  messages: Message[],
  page: { hasOlder: boolean; pagedBack: boolean } = { hasOlder: false, pagedBack: false },
): ChatState {
  const { runs: runList, pending_approvals, ...session } = detail;
  const runs: Record<string, Run> = {};
  for (const run of runList) runs[run.id] = run;
  const approvals: Record<string, Approval> = {};
  for (const approval of pending_approvals)
    if (approval.status === 'pending') approvals[approval.id] = approval;
  return {
    ...state,
    session: session as Session,
    messages: [...messages].sort((a, b) => a.seq - b.seq),
    runs,
    approvals,
    context: detail.context,
    hasOlder: page.hasOlder,
    pagedBack: state.pagedBack || page.pagedBack,
  };
}

/**
 * A page of older messages, fetched with `before` = the oldest message held, joins the
 * transcript at its top. Messages already held (a resync in between) are not repeated,
 * and `hasOlder` is taken from the page only when it really reaches past what is held.
 */
export function prependOlder(
  state: ChatState,
  page: { items: Message[]; has_more: boolean },
): ChatState {
  const held = new Set(state.messages.map((m) => m.id));
  const fresh = page.items.filter((m) => !held.has(m.id));
  const oldestHeld = state.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
  const reaches = page.items.length === 0 || (page.items[0]?.seq ?? 0) <= oldestHeld;
  return {
    ...state,
    messages: fresh.length
      ? [...fresh, ...state.messages].sort((a, b) => a.seq - b.seq)
      : state.messages,
    hasOlder: reaches ? page.has_more : state.hasOlder,
    pagedBack: true,
  };
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

/** The active run: waiting or running, else queued. */
export function activeRun(state: ChatState): Run | null {
  const runs = Object.values(state.runs);
  return (
    runs.find((r) => r.status === 'running' || r.status === 'waiting') ??
    runs.find((r) => r.status === 'queued') ??
    null
  );
}

export function isBusy(state: ChatState): boolean {
  return activeRun(state) !== null;
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index >= 0) {
    const next = [...messages];
    next[index] = message;
    return next;
  }
  return [...messages, message].sort((a, b) => a.seq - b.seq);
}

function patchMessage(messages: Message[], id: string, patch: (m: Message) => Message): Message[] {
  const index = messages.findIndex((m) => m.id === id);
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = patch(next[index] as Message);
  return next;
}

/** A shell for a delta whose `message.created` we never saw (a gap the replay could not cover). */
function shellMessage(
  sessionId: string,
  id: string,
  runId: string,
  seq: number,
  profile: string | null,
): Message {
  const now = new Date().toISOString();
  return {
    id,
    profile: profile ?? 'default',
    owner_id: id,
    created_at: now,
    updated_at: now,
    session_id: sessionId,
    room_id: null,
    seq,
    role: 'assistant',
    author: { kind: 'agent', id: null, name: '', avatar: null },
    content: [],
    reasoning: null,
    tool_calls: [],
    run_id: runId,
    status: 'streaming',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
  };
}

function appendText(message: Message, delta: string): Message {
  const content = [...message.content];
  const last = content[content.length - 1];
  if (last && last.type === 'text')
    content[content.length - 1] = { ...last, text: last.text + delta };
  else content.push({ type: 'text', text: delta });
  return { ...message, content, status: 'streaming' };
}

function upsertTool(message: Message, call: ToolCall): Message {
  const index = message.tool_calls.findIndex((c) => c.id === call.id);
  const tool_calls = [...message.tool_calls];
  if (index >= 0) tool_calls[index] = call;
  else tool_calls.push(call);
  return { ...message, tool_calls };
}

export function reduce(state: ChatState, envelope: Envelope, sessionId: string): ChatState {
  // `seq` counts per profile, and the socket hears every profile the lists gather
  // (ADR 0016): only this session's profile moves the cursor it resumes from, or another
  // profile's higher count would skip what this one missed.
  const sameProfile =
    !state.session || !envelope.profile || envelope.profile === state.session.profile;
  const next: ChatState = {
    ...state,
    lastSeq: sameProfile ? Math.max(state.lastSeq, envelope.seq) : state.lastSeq,
  };
  if (!belongsToSession(envelope, sessionId)) return next;
  const p = envelope.payload as Record<string, unknown>;
  const ensure = (messageId: string, runId: string): Message[] =>
    next.messages.some((m) => m.id === messageId)
      ? next.messages
      : [
          ...next.messages,
          shellMessage(
            sessionId,
            messageId,
            runId,
            (next.messages.at(-1)?.seq ?? 0) + 1,
            envelope.profile,
          ),
        ];

  switch (envelope.event) {
    case 'message.created':
      return { ...next, messages: upsertMessage(next.messages, p.message as Message) };
    case 'message.delta': {
      const id = p.message_id as string;
      return {
        ...next,
        messages: patchMessage(ensure(id, p.run_id as string), id, (m) =>
          appendText(m, p.delta as string),
        ),
      };
    }
    case 'reasoning.delta': {
      const id = p.message_id as string;
      return {
        ...next,
        messages: patchMessage(ensure(id, p.run_id as string), id, (m) => ({
          ...m,
          reasoning: {
            text: (m.reasoning?.text ?? '') + (p.delta as string),
            duration_ms: m.reasoning?.duration_ms ?? null,
          },
        })),
      };
    }
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed': {
      const id = p.message_id as string;
      return {
        ...next,
        messages: patchMessage(ensure(id, p.run_id as string), id, (m) =>
          upsertTool(m, p.tool_call as ToolCall),
        ),
      };
    }
    case 'run.queued':
    case 'run.started':
    case 'run.failed':
    case 'run.cancelled': {
      const run = p.run as Run;
      const messages =
        envelope.event === 'run.failed' || envelope.event === 'run.cancelled'
          ? next.messages.map((m) =>
              m.run_id === run.id && m.status === 'streaming'
                ? {
                    ...m,
                    status:
                      envelope.event === 'run.failed'
                        ? ('failed' as const)
                        : ('interrupted' as const),
                  }
                : m,
            )
          : next.messages;
      return { ...next, runs: { ...next.runs, [run.id]: run }, messages };
    }
    case 'run.completed': {
      const run = p.run as Run;
      const message = p.message as Message;
      return {
        ...next,
        runs: { ...next.runs, [run.id]: run },
        messages: upsertMessage(next.messages, message),
      };
    }
    case 'approval.requested': {
      const approval = p.approval as Approval;
      if (approval.status !== 'pending') return next;
      return { ...next, approvals: { ...next.approvals, [approval.id]: approval } };
    }
    case 'approval.resolved': {
      const approval = p.approval as Approval;
      const approvals = { ...next.approvals };
      delete approvals[approval.id];
      return { ...next, approvals };
    }
    case 'session.updated':
      return { ...next, session: p.session as Session };
    case 'session.deleted':
      return { ...next, deleted: true };
    case 'context.updated':
      return { ...next, context: p.context as Session['context'] };
    case 'context.compression': {
      const phase =
        p.phase === 'started' ? 'running' : p.phase === 'failed' ? 'failed' : 'finished';
      const count = (value: unknown) => (typeof value === 'number' ? value : null);
      return {
        ...next,
        compression: {
          phase,
          trigger: p.trigger === 'auto' ? 'auto' : 'manual',
          beforeTokens: count(p.before_tokens),
          afterTokens: count(p.after_tokens),
          message: typeof p.message === 'string' ? p.message : null,
        },
      };
    }
    default:
      return next;
  }
}

export function textOf(message: Pick<Message, 'content'>): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}
