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
  deleted: boolean;
}

export function initialChat(): ChatState {
  return {
    lastSeq: 0,
    session: null,
    messages: [],
    runs: {},
    approvals: {},
    context: null,
    deleted: false,
  };
}

/** Replace the base state with what HTTP returned, keeping the realtime cursor. */
export function hydrate(state: ChatState, detail: SessionDetail, messages: Message[]): ChatState {
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
  const next: ChatState = { ...state, lastSeq: Math.max(state.lastSeq, envelope.seq) };
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
