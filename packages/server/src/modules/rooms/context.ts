/**
 * What a seat is told on its turn, and what its reply asks of the room — pure functions, so
 * the rules are read and tested without a hub (DECISIONS §57).
 *
 * A seat keeps its own conversation in `sessions`, so it already has what it said and what it
 * was shown before. Each turn therefore hands it only the room as it has **not** seen it: the
 * messages after its last turn, trimmed to the newest ones (older context reaches it as the
 * room's summary, part 3), under a short header saying where it is, who else is there, and how
 * to pass the turn.
 */

export interface ContextSeat {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
}

export interface ContextMessage {
  seq: number;
  authorKind: 'user' | 'seat' | 'system';
  authorName: string;
  seatId: string | null;
  content: string;
  status: string;
}

/** The newest messages a turn carries, and the characters they may take. */
export const CONTEXT_MESSAGES = 30;
export const CONTEXT_CHARS = 12_000;

export interface SeatPrompt {
  roomName: string;
  seat: ContextSeat;
  others: readonly ContextSeat[];
  people: readonly string[];
  summary: string | null;
  handoffEnabled: boolean;
  /** Messages the seat has not been shown yet, oldest first. */
  unseen: readonly ContextMessage[];
}

/** The messages worth showing: finished words from someone other than the seat itself. */
export function unseenFor(seatId: string, messages: readonly ContextMessage[]): ContextMessage[] {
  return messages.filter(
    (message) =>
      message.seatId !== seatId &&
      message.status === 'complete' &&
      message.content.trim().length > 0,
  );
}

/**
 * The newest messages that fit: at most `CONTEXT_MESSAGES`, and at most `CONTEXT_CHARS` of
 * text (the newest message always goes, cut if it alone is longer). Answers what is kept and
 * how many older ones were left out.
 */
export function trimmed(
  messages: readonly ContextMessage[],
  maxMessages = CONTEXT_MESSAGES,
  maxChars = CONTEXT_CHARS,
): { kept: ContextMessage[]; dropped: number } {
  const kept: ContextMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < maxMessages; i -= 1) {
    const message = messages[i]!;
    const size = message.content.length;
    if (kept.length > 0 && used + size > maxChars) break;
    kept.unshift(
      size > maxChars ? { ...message, content: `${message.content.slice(0, maxChars)}…` } : message,
    );
    used += Math.min(size, maxChars);
  }
  return { kept, dropped: messages.length - kept.length };
}

function speaker(message: ContextMessage): string {
  if (message.authorKind === 'seat') return `@${message.authorName}`;
  if (message.authorKind === 'system') return 'Core Hub';
  return message.authorName;
}

/** The prompt of one seat turn. */
export function seatPrompt(input: SeatPrompt): string {
  const { seat } = input;
  const lines: string[] = [];
  lines.push(
    `You are @${seat.name}, one of the agents in the room "${input.roomName}" — a group conversation of people and AI agents.`,
  );
  if (seat.description) lines.push(`Your role in this room: ${seat.description}`);
  if (seat.instructions) lines.push(`Your instructions for this room:\n${seat.instructions}`);
  const others = input.others.map((other) =>
    other.description ? `@${other.name} (${other.description})` : `@${other.name}`,
  );
  lines.push(`Other agents here: ${others.length > 0 ? others.join(', ') : 'none'}.`);
  if (input.people.length > 0) lines.push(`People here: ${input.people.join(', ')}.`);
  lines.push(
    input.handoffEnabled && others.length > 0
      ? 'To hand the next step to another agent, mention it as @Name in your reply; mention no agent to simply answer.'
      : 'Answer the room directly.',
  );
  if (input.summary) lines.push(`Summary of the room so far:\n${input.summary}`);
  const { kept, dropped } = trimmed(input.unseen);
  lines.push('');
  lines.push(
    dropped > 0
      ? `New in the room since your last turn (the newest ${kept.length}; ${dropped} earlier not shown):`
      : 'New in the room since your last turn:',
  );
  for (const message of kept) lines.push(`[${speaker(message)}] ${message.content}`);
  lines.push('');
  lines.push(`Reply to the room now as @${seat.name}.`);
  return lines.join('\n');
}

/** Code (fenced or inline) is not where a seat is addressed. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The seats an agent's reply mentions, in the order they first appear. An agent writes text,
 * not structured mentions, so its `@Name`s are read here — whole names only, longest first,
 * never inside code, never the seat itself.
 */
export function mentionedSeats<T extends { id: string; name: string }>(
  text: string,
  seats: readonly T[],
  selfId: string,
): T[] {
  const clean = withoutCode(text);
  const lower = clean.toLocaleLowerCase();
  const found: Array<{ at: number; seat: T }> = [];
  const taken: Array<[number, number]> = [];
  for (const seat of [...seats].sort((a, b) => b.name.length - a.name.length)) {
    const needle = `@${seat.name}`.toLocaleLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      const before = at > 0 ? clean[at - 1]! : '';
      const after = clean[at + needle.length] ?? '';
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
      if (taken.some(([a, b]) => at < b && at + needle.length > a)) continue;
      taken.push([at, at + needle.length]);
      if (seat.id !== selfId && !found.some((f) => f.seat.id === seat.id)) found.push({ at, seat });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.seat);
}

export type HandoffVerdict =
  | { go: true; depth: number; visited: string[] }
  | { go: false; reason: 'max_depth' | 'loop_detected'; depth: number };

/**
 * May the turn pass from `from` to `to` in a chain that has gone `depth` passes and made
 * `visited` passes? The same pass twice in one chain is a loop (A→B, B→A, A→B stops at the
 * third); more than `maxDepth` passes (`null` = no cap) is too deep. `once` lets one pass
 * through the guard — `continueHandoff`.
 */
export function judgeHandoff(input: {
  from: string;
  to: string;
  depth: number;
  visited: readonly string[];
  maxDepth: number | null;
  once?: boolean;
}): HandoffVerdict {
  const pair = `${input.from}>${input.to}`;
  const depth = input.depth + 1;
  if (!input.once) {
    if (input.visited.includes(pair)) return { go: false, reason: 'loop_detected', depth };
    if (input.maxDepth !== null && depth > input.maxDepth)
      return { go: false, reason: 'max_depth', depth };
  }
  return { go: true, depth, visited: [...input.visited, pair] };
}
