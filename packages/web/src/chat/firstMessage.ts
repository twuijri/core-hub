/**
 * The handover between "new chat" and the chat itself.
 *
 * The first message mints the session, but the run must not start until the chat screen is
 * subscribed: the hub streams deltas to listeners and only persists the finished text, so a
 * run started a moment too early would show as an empty bubble until it ended. So the blocks
 * wait here — in memory, for one navigation — and the chat screen sends them the instant its
 * stream is ready.
 *
 * Deliberately not router state: replacing the history entry to clear it re-renders the
 * route mid-send. Deliberately not storage: a reload should not resend a message.
 */
import type { ContentBlock } from '../types.js';

const waiting = new Map<string, ContentBlock[]>();

export function putFirstMessage(sessionId: string, blocks: ContentBlock[]): void {
  waiting.set(sessionId, blocks);
}

/** Reads and forgets: a message is handed over exactly once. */
export function takeFirstMessage(sessionId: string): ContentBlock[] | undefined {
  const blocks = waiting.get(sessionId);
  waiting.delete(sessionId);
  return blocks;
}
