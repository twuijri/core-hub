/**
 * Files handed to the next composer that opens.
 *
 * "Attach to chat" on the Files page makes an attachment of a profile file on the hub
 * (`knowledge.attachWorkspaceFile`) and then opens a conversation. The composer there must
 * start with that file already in its tray, exactly as if it had been dropped on it. This is
 * the one slot between the two screens: the Files page puts, the composer takes on mount.
 *
 * It lives in memory on purpose — the attachment is already on the hub, so a reload that
 * loses the slot loses nothing but the convenience — and it keeps its profile, so a
 * composer in another profile never picks up a file that belongs to this one. A slot left
 * untaken expires rather than surprising a chat opened much later.
 */
import type { Attachment } from '../types.js';

/** How long a handed-off file waits for its composer. */
export const HANDOFF_TTL_MS = 60_000;

interface Slot {
  profile: string;
  attachments: Attachment[];
  at: number;
}

let slot: Slot | null = null;

/** Put files in the slot for the composer that opens next in `profile`. */
export function handOff(profile: string, attachments: readonly Attachment[]): void {
  slot = { profile, attachments: [...attachments], at: Date.now() };
}

/** Take what was handed off to `profile`, once; empty when nothing (or it expired). */
export function takeHandOff(profile: string, now: number = Date.now()): Attachment[] {
  const current = slot;
  if (!current) return [];
  if (now - current.at > HANDOFF_TTL_MS) {
    slot = null;
    return [];
  }
  if (current.profile !== profile) return [];
  slot = null;
  return current.attachments;
}
