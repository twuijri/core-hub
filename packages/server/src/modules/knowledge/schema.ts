/**
 * knowledge — notes the hub owns, the journal, and attachments (files).
 *
 * All tables are workspace-scoped. Agent memory (Hermes memory files, Claude
 * project memory) is the agent's private state: it is browsed live through
 * the adapter and never copied here (docs/domain/knowledge.md).
 *
 * Full-text search runs on an FTS5 virtual table (`knowledge_fts`) created
 * by a hand-written migration, not declared here; PostgreSQL uses a tsvector
 * column instead (packages/server/src/db/README.md).
 *
 * Cross-module id columns: knowledge_notes.project_id / task_id -> tasks,
 * knowledge_notes.source_agent_id / journal_entries.author_agent_id ->
 * agents.agents, journal_entries.run_id -> sessions.runs,
 * attachments.source_id -> the entity named by `source_kind`.
 */
import { check, index, sqliteTable, text, uniqueIndex, integer } from 'drizzle-orm/sqlite-core';
import {
  EMPTY_ARRAY,
  EMPTY_OBJECT,
  bool,
  inList,
  json,
  scopedColumns,
  timestampMs,
  ulid,
} from '../../db/columns.js';

export const NOTE_KINDS = ['note', 'memory', 'snippet', 'report'] as const;
export const NOTE_SOURCES = ['user', 'agent', 'import'] as const;
export const JOURNAL_AUTHORS = ['user', 'agent'] as const;
export const ATTACHMENT_KINDS = ['image', 'audio', 'video', 'file', 'diff', 'log'] as const;
export const ATTACHMENT_SOURCES = [
  'upload',
  'agent_output',
  'tool_output',
  'device',
  'journal',
  'export',
] as const;

export type NoteLink = { kind: 'session' | 'room' | 'run' | 'schedule' | 'note'; id: string };

export type AttachmentMeta = {
  width?: number;
  height?: number;
  durationMs?: number;
  /** Original name of the file inside a diff/log bundle. */
  entryName?: string;
  /**
   * The contract's `AttachmentPurpose` (`message`, `avatar`, `task`, …). It lives in
   * `meta` rather than in a column of its own because it is a rendering hint the client
   * sends and reads back, never something the hub queries or filters by; a column would
   * cost a migration for a value no index would ever use.
   */
  purpose?: string;
  /**
   * For a file an agent produced: its path relative to the run's output folder, so a
   * client can show `report/summary.md` rather than a bare name.
   */
  producedPath?: string;
};

export const knowledgeNotes = sqliteTable(
  'knowledge_notes',
  {
    ...scopedColumns(),
    title: text('title', { length: 200 }).notNull(),
    /** Markdown. */
    body: text('body').notNull().default(''),
    kind: text('kind', { enum: NOTE_KINDS }).notNull().default('note'),
    tags: json<string[]>('tags').notNull().default(EMPTY_ARRAY),
    sourceKind: text('source_kind', { enum: NOTE_SOURCES }).notNull().default('user'),
    sourceAgentId: ulid('source_agent_id'),
    projectId: ulid('project_id'),
    taskId: ulid('task_id'),
    links: json<NoteLink[]>('links').notNull().default(EMPTY_ARRAY),
    pinned: bool('pinned').notNull().default(false),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    index('knowledge_notes_workspace_idx').on(t.workspace, t.archivedAt, t.updatedAt),
    index('knowledge_notes_project_idx').on(t.projectId),
    index('knowledge_notes_task_idx').on(t.taskId),
    check('knowledge_notes_kind_check', inList(t.kind, NOTE_KINDS)),
    check('knowledge_notes_source_kind_check', inList(t.sourceKind, NOTE_SOURCES)),
  ],
);

export const journalEntries = sqliteTable(
  'journal_entries',
  {
    ...scopedColumns(),
    /** Calendar day `YYYY-MM-DD` in the owner's timezone; several entries per day. */
    date: text('date', { length: 10 }).notNull(),
    seq: integer('seq').notNull().default(1),
    mood: text('mood', { length: 32 }),
    /** Markdown. */
    body: text('body').notNull(),
    highlights: json<string[]>('highlights').notNull().default(EMPTY_ARRAY),
    authorKind: text('author_kind', { enum: JOURNAL_AUTHORS }).notNull().default('user'),
    authorAgentId: ulid('author_agent_id'),
    /** Image / voice note attachments. */
    attachmentIds: json<string[]>('attachment_ids').notNull().default(EMPTY_ARRAY),
    /** The run that wrote the entry when a schedule produced it. */
    runId: ulid('run_id'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('journal_entries_owner_day_seq_uq').on(t.workspace, t.ownerId, t.date, t.seq),
    index('journal_entries_workspace_date_idx').on(t.workspace, t.date),
    check('journal_entries_author_kind_check', inList(t.authorKind, JOURNAL_AUTHORS)),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    ...scopedColumns(),
    filename: text('filename', { length: 255 }).notNull(),
    mime: text('mime', { length: 120 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256', { length: 64 }).notNull(),
    /**
     * Path relative to `<data>/attachments`; never an absolute host path. Shared by every row
     * holding the same bytes in a workspace.
     */
    storageKey: text('storage_key').notNull(),
    kind: text('kind', { enum: ATTACHMENT_KINDS }).notNull().default('file'),
    sourceKind: text('source_kind', { enum: ATTACHMENT_SOURCES }).notNull().default('upload'),
    sourceId: ulid('source_id'),
    meta: json<AttachmentMeta>('meta').notNull().default(EMPTY_OBJECT),
    /** Temporary files (tool output) are purged after this. */
    expiresAt: timestampMs('expires_at'),
    /** Bytes removed from storage; the row stays so references resolve to "deleted". */
    deletedAt: timestampMs('deleted_at'),
  },
  (t) => [
    // Not unique: content addressing means every upload of the same bytes in a workspace
    // points at the same key, one row each (contract decision §39). A delete removes the bytes
    // only when no live row still points at them (`AttachmentStore.referencesTo`).
    index('attachments_workspace_storage_key_idx').on(t.workspace, t.storageKey),
    index('attachments_workspace_sha_idx').on(t.workspace, t.sha256),
    index('attachments_expires_idx').on(t.expiresAt),
    check('attachments_kind_check', inList(t.kind, ATTACHMENT_KINDS)),
    check('attachments_source_kind_check', inList(t.sourceKind, ATTACHMENT_SOURCES)),
  ],
);
