/**
 * A room's transcript as the screen holds it, and how each `/rt/rooms` event changes it.
 *
 * Pure on purpose: the socket hook feeds events in, the screen draws what comes out, and the
 * tests replay a stream without a socket. A room message is the contract's one `Message`
 * (DECISIONS §1); a seat's reply streams into the message its run opened, found by id.
 */
import type { Message } from '../types.js';

export interface RoomTranscript {
  messages: Message[];
  /** Whether messages older than the first one exist on the hub. */
  hasMore: boolean;
  /** People typing now, by member id. */
  typing: Record<string, string>;
  /** The tool a seat's run is using right now, by run id — the progress line. */
  tools: Record<string, string>;
}

export const emptyTranscript: RoomTranscript = {
  messages: [],
  hasMore: false,
  typing: {},
  tools: {},
};

export function loaded(messages: readonly Message[], hasMore: boolean): RoomTranscript {
  return { ...emptyTranscript, messages: sortBySeq(messages), hasMore };
}

/** An older page, put in front of what is already there. */
export function prepend(
  state: RoomTranscript,
  older: readonly Message[],
  hasMore: boolean,
): RoomTranscript {
  return { ...state, messages: merge(state.messages, older), hasMore };
}

function sortBySeq(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => a.seq - b.seq);
}

function merge(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return sortBySeq([...byId.values()]);
}

/** The words of a message: its text blocks, joined. */
export function textOf(message: Pick<Message, 'content'>): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

type Payload = Record<string, unknown>;

export function applyRoomEvent(
  state: RoomTranscript,
  event: string,
  payload: Payload,
): RoomTranscript {
  switch (event) {
    case 'message.created':
      return { ...state, messages: merge(state.messages, [payload.message as Message]) };
    case 'run.completed': {
      const run = payload.run as { id: string };
      const { [run.id]: _done, ...tools } = state.tools;
      return {
        ...state,
        tools,
        messages: payload.message
          ? merge(state.messages, [payload.message as Message])
          : state.messages,
      };
    }
    case 'run.failed':
    case 'run.cancelled': {
      const run = payload.run as { id: string };
      const { [run.id]: _done, ...tools } = state.tools;
      return { ...state, tools };
    }
    case 'message.delta': {
      const id = String(payload.message_id);
      const delta = String(payload.delta ?? '');
      let changed = false;
      const messages = state.messages.map((message) => {
        if (message.id !== id) return message;
        changed = true;
        const current = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        const text = `${current}${delta}`;
        return { ...message, content: [{ type: 'text' as const, text }] };
      });
      return changed ? { ...state, messages } : state;
    }
    case 'tool.started': {
      const call = payload.tool_call as { name?: string; preview?: string | null };
      return {
        ...state,
        tools: { ...state.tools, [String(payload.run_id)]: call.preview || call.name || '' },
      };
    }
    case 'tool.completed':
    case 'tool.failed': {
      const { [String(payload.run_id)]: _done, ...tools } = state.tools;
      return { ...state, tools };
    }
    case 'member.typing': {
      const id = String(payload.member_id);
      const { [id]: _was, ...others } = state.typing;
      return {
        ...state,
        typing: payload.typing === true ? { ...others, [id]: String(payload.name) } : others,
      };
    }
    case 'room.cleared':
      return { ...emptyTranscript };
    default:
      return state;
  }
}
