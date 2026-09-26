/**
 * Hiding a channel conversation from one's own list (contract decision §88).
 *
 * A conversation on Telegram or WhatsApp is Hermes's (§61): the hub cannot change it, and
 * deleting it from Hermes is an admin's, permanent step. Hiding is the everyday one — a person
 * no longer wants to see it — and it belongs to that person alone: other people's lists, Hermes
 * and the channel are untouched, and "show again" undoes it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { ModuleDatabase } from '../../db/handle.js';
import { channelConversationHides } from './schema.js';

export class ChannelHides {
  constructor(private readonly db: ModuleDatabase) {}

  /** Hidden for `userId` in `workspace`; hiding one already hidden changes nothing. */
  hide(workspace: string, userId: string, conversationId: string): void {
    this.db
      .insert(channelConversationHides)
      .values({ workspace, ownerId: userId, conversationId })
      .onConflictDoNothing()
      .run();
  }

  /** Shown again; one that was not hidden is fine. */
  unhide(workspace: string, userId: string, conversationId: string): void {
    this.db
      .delete(channelConversationHides)
      .where(
        and(
          eq(channelConversationHides.workspace, workspace),
          eq(channelConversationHides.ownerId, userId),
          eq(channelConversationHides.conversationId, conversationId),
        ),
      )
      .run();
  }

  /** What `userId` hid, per workspace, in these workspaces. */
  hiddenIn(workspaces: readonly string[], userId: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (workspaces.length === 0) return out;
    const rows = this.db
      .select({
        workspace: channelConversationHides.workspace,
        id: channelConversationHides.conversationId,
      })
      .from(channelConversationHides)
      .where(
        and(
          inArray(channelConversationHides.workspace, [...workspaces]),
          eq(channelConversationHides.ownerId, userId),
        ),
      )
      .all();
    for (const row of rows) {
      const set = out.get(row.workspace) ?? new Set<string>();
      set.add(row.id);
      out.set(row.workspace, set);
    }
    return out;
  }

  /** The conversation is gone from Hermes: nobody's mark on it means anything any more. */
  forget(workspace: string, conversationId: string): void {
    this.db
      .delete(channelConversationHides)
      .where(
        and(
          eq(channelConversationHides.workspace, workspace),
          eq(channelConversationHides.conversationId, conversationId),
        ),
      )
      .run();
  }
}
