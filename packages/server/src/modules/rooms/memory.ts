/**
 * The room's rolling summary (contract `RoomMemory`, DECISIONS §69 part 3).
 *
 * A seat is shown only the newest messages it has not seen (`context.ts`); what came before
 * reaches it as this summary, which every seat turn carries. It is rewritten **every N
 * messages** (`summary_policy.every_turns`, `0` = never on its own), when the manager asks
 * (`refreshMemory`), and by hand (`putMemory`).
 *
 * Who writes it: **the room's lead agent**, asked one question outside any run (the same
 * one-shot surface that names a chat), with the summary's model when the room names one.
 * When that agent has no such surface, gives up or fails, **the hub writes it itself**: the
 * previous summary and one line per new message, cut to size — plainer, but never nothing.
 */
import type { EngineScope, SeatSessions } from '../sessions/index.js';
import type { RoomMessageRow, RoomRow, SeatRow } from './store.js';

/** The most a summary keeps, in characters. */
export const SUMMARY_MAX = 4_000;
/** How long the agent is given to answer before the hub writes the summary itself. */
export const SUMMARY_TIMEOUT_MS = 60_000;

function speaker(message: Pick<RoomMessageRow, 'authorKind' | 'authorName'>): string {
  if (message.authorKind === 'seat') return `@${message.authorName ?? ''}`;
  if (message.authorKind === 'system') return 'Core Hub';
  return message.authorName ?? '';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The hub's own summary: the previous one, then one line per new message, keeping the end
 * when it grows past `SUMMARY_MAX` — the newest is what the next turn needs most.
 */
export function digest(
  previous: string | null,
  messages: ReadonlyArray<Pick<RoomMessageRow, 'authorKind' | 'authorName' | 'content'>>,
): string {
  const lines = messages
    .filter((message) => message.content.trim())
    .map((message) => `- ${speaker(message)}: ${oneLine(message.content, 200)}`);
  const text = [previous?.trim() ?? '', ...lines].filter(Boolean).join('\n');
  if (text.length <= SUMMARY_MAX) return text;
  const tail = text.slice(-SUMMARY_MAX);
  const cut = tail.indexOf('\n');
  return `…${cut >= 0 && cut < 400 ? tail.slice(cut + 1) : tail}`;
}

/** What the agent is asked for the summary. */
export function summaryPrompt(
  roomName: string,
  previous: string | null,
  messages: ReadonlyArray<Pick<RoomMessageRow, 'authorKind' | 'authorName' | 'content'>>,
): string {
  const lines = [
    `Update the running summary of the room "${roomName}", a group conversation of people and AI agents.`,
    'Keep what was decided, who is doing what, open questions and anything agreed on. At most 200 words, in the language the room is written in. Answer with the summary only.',
  ];
  if (previous?.trim()) lines.push(`Summary so far:\n${previous.trim()}`);
  lines.push('New messages:');
  for (const message of messages) {
    if (message.content.trim())
      lines.push(`[${speaker(message)}] ${oneLine(message.content, 2000)}`);
  }
  return lines.join('\n\n');
}

/**
 * The new summary of `room` after `messages`: the lead agent's words when it answers, the
 * hub's digest otherwise. Says which wrote it.
 */
export async function summarise(input: {
  scope: EngineScope;
  room: RoomRow;
  lead: SeatRow | null;
  messages: readonly RoomMessageRow[];
  seats: SeatSessions | null;
  timeoutMs?: number;
}): Promise<{ summary: string; by: 'agent' | 'hub' }> {
  const { room, lead, messages } = input;
  if (lead && input.seats) {
    const answer = await input.seats.ask({
      workspace: input.scope.workspace,
      agentId: lead.agentId,
      sessionId: lead.sessionId,
      prompt: summaryPrompt(room.name, room.memory ?? null, messages),
      model: room.summaryModel ?? lead.model ?? null,
      provider: room.summaryProvider ?? lead.provider ?? null,
      timeoutMs: input.timeoutMs ?? SUMMARY_TIMEOUT_MS,
    });
    const text = answer?.trim();
    if (text) {
      return {
        summary: text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text,
        by: 'agent',
      };
    }
  }
  return { summary: digest(room.memory ?? null, messages), by: 'hub' };
}
