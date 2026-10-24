/**
 * One hub conversation, one Gemini conversation (DECISIONS §155, the owner's requirement).
 *
 * The direct agent sends its whole history every turn. For a Gemini Desktop model the hub keeps,
 * per hub conversation, the Gemini ids of each answered turn, keyed by a hash of the history up
 * to and including that answer. A new turn whose history (all but its last message) hashes to a
 * known turn continues from that turn's ids and sends only its new message: the latest turn is a
 * plain continuation, an older one a branch (the hub's history was cut back). A history the hub
 * no longer holds in memory (the hub restarted; the direct agent starts each session afresh)
 * continues the conversation's latest turn. Anything else — a history Gemini never saw — starts a
 * new Gemini conversation with the history folded into the first message.
 */
import { createHash } from 'node:crypto';
import type { ConversationIds } from './wire.js';

export interface ThreadMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
}

export interface ThreadTurn {
  hash: string;
  ids: ConversationIds;
}

export interface Thread {
  /** The account the conversation lives in; it never moves to another account's history. */
  account: string;
  turns: ThreadTurn[];
  /** Epoch milliseconds of the last turn, for keeping the most recent conversations. */
  at: number;
}

export type Threads = Record<string, Thread>;

/** Turns kept per conversation (a branch can start from any of them). */
export const MAX_TURNS = 100;
/** Conversations kept per provider row; the least recent go first. */
export const MAX_THREADS = 1_000;

/**
 * A conversation key the hub can trust to name one hub conversation: the direct agent's session
 * reference, `direct-<session id>`. Anything else (an older session's shared reference) has no
 * continuity, and every turn folds its history as before.
 */
export function usableKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && /^direct-[0-9a-z]{20,40}$/.test(key);
}

export function historyHash(messages: readonly ThreadMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(message.role);
    hash.update('\u0000');
    hash.update(message.text);
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

function conversational(messages: readonly ThreadMessage[]): boolean {
  return messages.some((message) => message.role !== 'system');
}

export type TurnPlan =
  | { kind: 'continue' | 'branch'; resume: ConversationIds }
  /** `folded`: the history Gemini never saw goes with the first message. */
  | { kind: 'new'; folded: boolean; diverged: boolean };

/** How the next turn reaches Gemini. `messages` ends with the new user message. */
export function planTurn(thread: Thread | undefined, messages: readonly ThreadMessage[]): TurnPlan {
  const before = messages.slice(0, -1);
  if (thread && thread.turns.length > 0) {
    const latest = thread.turns[thread.turns.length - 1]!;
    if (!conversational(before)) return { kind: 'continue', resume: latest.ids };
    const hash = historyHash(before);
    for (let i = thread.turns.length - 1; i >= 0; i--) {
      const turn = thread.turns[i]!;
      if (turn.hash === hash) {
        return { kind: turn === latest ? 'continue' : 'branch', resume: turn.ids };
      }
    }
    return { kind: 'new', folded: true, diverged: true };
  }
  return { kind: 'new', folded: conversational(before), diverged: false };
}

/**
 * The text a turn sends: only the new message when Gemini has the rest; otherwise the history,
 * each message in a role tag, as the owner's plugin folds it. A system prompt goes with the first
 * message of a Gemini conversation only.
 */
export function turnText(messages: readonly ThreadMessage[], continuing: boolean): string {
  const last = messages[messages.length - 1];
  if (continuing || messages.length === 1) return last?.text ?? '';
  return messages
    .map((message) => `<${message.role}>\n${message.text}\n</${message.role}>\n`)
    .join('');
}

/** The thread after an answered turn: `history` is the whole history including the answer. */
export function recordTurn(
  threads: Threads,
  key: string,
  account: string,
  history: readonly ThreadMessage[],
  ids: ConversationIds,
  at: number,
  startedNew: boolean,
): Threads {
  const previous = threads[key];
  const turns =
    startedNew || !previous || previous.account !== account ? [] : previous.turns.slice();
  turns.push({ hash: historyHash(history), ids });
  const next: Threads = { ...threads, [key]: { account, turns: turns.slice(-MAX_TURNS), at } };
  const keys = Object.keys(next);
  if (keys.length > MAX_THREADS) {
    keys
      .sort((a, b) => next[a]!.at - next[b]!.at)
      .slice(0, keys.length - MAX_THREADS)
      .forEach((old) => delete next[old]);
  }
  return next;
}
