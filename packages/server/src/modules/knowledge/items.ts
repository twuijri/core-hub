/**
 * `knowledge.listItems` — the journal, the notes and the files of one workspace, in one
 * page, newest first.
 *
 * Three tables, one list. They are merged here rather than in the client because a client
 * that pages three sources cannot page them as one: a cursor would have to carry three
 * positions, and "the next ten things" would stop meaning what it says.
 *
 * Every id in this hub is a ULID, which sorts by time — so "newest first" is "id
 * descending", and a cursor is the last id seen, whichever table it came from. That is
 * what makes one cursor enough for three tables.
 */
import { and, desc, eq, isNull, like, lt, ne, or } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { attachments, journalEntries, knowledgeNotes } from './schema.js';

export type ItemKind = 'journal' | 'note' | 'file';

export interface KnowledgeItem {
  id: string;
  profile: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  kind: ItemKind;
  title: string | null;
  content: string | null;
  date: string | null;
  mood: string | null;
  tags: string[];
  attachment_ids: string[];
}

export interface ItemQuery {
  workspace: string;
  profile: string;
  kind?: ItemKind | undefined;
  q?: string | undefined;
  cursor?: string | null;
  limit: number;
}

export class KnowledgeItems {
  constructor(private readonly db: ModuleDb) {}

  list(query: ItemQuery): { items: KnowledgeItem[]; lastId: string | null } {
    const wanted = (kind: ItemKind) => !query.kind || query.kind === kind;
    const needle = query.q?.trim();
    // Each table is asked for one page's worth; the merge then keeps the newest of the
    // three. Asking for `limit` from each is what makes the merge exact: whatever the
    // split between tables, the newest `limit` items are certainly among them.
    const take = query.limit;
    const before = query.cursor ?? null;

    const items: KnowledgeItem[] = [];

    if (wanted('journal')) {
      const rows = this.db
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.workspace, query.workspace),
            isNull(journalEntries.archivedAt),
            before ? lt(journalEntries.id, before) : undefined,
            needle ? like(journalEntries.body, `%${needle}%`) : undefined,
          ),
        )
        .orderBy(desc(journalEntries.id))
        .limit(take)
        .all();
      for (const row of rows) {
        items.push({
          id: row.id,
          profile: query.profile,
          owner_id: row.ownerId,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
          kind: 'journal',
          // A journal entry has no title of its own: the day it belongs to is its name.
          title: row.date,
          content: row.body,
          date: row.date,
          mood: row.mood,
          tags: row.highlights,
          attachment_ids: row.attachmentIds,
        });
      }
    }

    if (wanted('note')) {
      const rows = this.db
        .select()
        .from(knowledgeNotes)
        .where(
          and(
            eq(knowledgeNotes.workspace, query.workspace),
            isNull(knowledgeNotes.archivedAt),
            before ? lt(knowledgeNotes.id, before) : undefined,
            needle
              ? or(
                  like(knowledgeNotes.title, `%${needle}%`),
                  like(knowledgeNotes.body, `%${needle}%`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(knowledgeNotes.id))
        .limit(take)
        .all();
      for (const row of rows) {
        items.push({
          id: row.id,
          profile: query.profile,
          owner_id: row.ownerId,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
          kind: 'note',
          title: row.title,
          content: row.body,
          date: null,
          mood: null,
          tags: row.tags,
          attachment_ids: [],
        });
      }
    }

    if (wanted('file')) {
      const rows = this.db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.workspace, query.workspace),
            isNull(attachments.deletedAt),
            // A profile export is its requester's alone (contract decision §30), and it
            // is on its way out: it is not one of the profile's files.
            ne(attachments.sourceKind, 'export'),
            before ? lt(attachments.id, before) : undefined,
            needle ? like(attachments.filename, `%${needle}%`) : undefined,
          ),
        )
        .orderBy(desc(attachments.id))
        .limit(take)
        .all();
      for (const row of rows) {
        items.push({
          id: row.id,
          profile: query.profile,
          owner_id: row.ownerId,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
          kind: 'file',
          title: row.filename,
          // A file's bytes are not its content here: `sessions.downloadAttachment` serves
          // those. The list says what it is, not what is inside it.
          content: null,
          date: null,
          mood: null,
          tags: [],
          attachment_ids: [row.id],
        });
      }
    }

    items.sort((a, b) => b.id.localeCompare(a.id));
    const page = items.slice(0, take);
    return { items: page, lastId: page.length === take ? (page.at(-1)?.id ?? null) : null };
  }
}
