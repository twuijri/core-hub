# knowledge

Owns: `knowledge_note`, `journal_entry`, `attachment`. Schema:
`packages/server/src/modules/knowledge/schema.ts`. All scoped. Base columns
omitted.

The "memory browser" screen shows two sources side by side: hub notes of
kind `memory` (stored here) and the agent's own memory read live through the
adapter (never stored, see below).

## knowledge_note (scoped)

| column | type | meaning |
|---|---|---|
| title | text(200) | |
| body | text | Markdown |
| kind | enum(note, memory, snippet, report) | memory = a fact the user wants agents to know; report = agent-written summary |
| tags | json<string[]> | |
| source_kind | enum(user, agent, import) | |
| source_agent_id | ulid? → agents.agent | |
| project_id, task_id | ulid? → tasks | the common filters, as columns |
| links | json<NoteLink[]> | other references: session, room, run, schedule, note |
| pinned | bool | |
| archived_at | ms? | |

Indexes: (workspace, archived_at, updated_at); `project_id`; `task_id`.

## journal_entry (scoped)

| column | type | meaning |
|---|---|---|
| date | text(10) | `YYYY-MM-DD` in the owner's timezone |
| seq | int | several entries per day |
| mood | text(32)? | |
| body | text | Markdown |
| highlights | json<string[]> | |
| author_kind | enum(user, agent) | |
| author_agent_id | ulid? → agents.agent | |
| attachment_ids | json<string[]> | image, voice note |
| run_id | ulid? → sessions.run | when a schedule wrote it (daily summary) |
| archived_at | ms? | |

Indexes: unique (workspace, owner_id, date, seq); (workspace, date).

## attachment (scoped)

The single file registry (`DECISIONS.md` §15).

| column | type | meaning |
|---|---|---|
| filename | text(255) | original name |
| mime | text(120) | |
| size_bytes | int | |
| sha256 | text(64) | de-duplication within a workspace |
| storage_key | text, unique | path relative to `<data>/attachments`; never absolute |
| kind | enum(image, audio, video, file, diff, log) | |
| source_kind | enum(upload, agent_output, tool_output, device, journal, export) | |
| source_id | ulid? | the message, tool call, device command or journal entry |
| meta | json<AttachmentMeta> | width, height, durationMs, entryName |
| expires_at | ms? | temporary files (tool output) |
| deleted_at | ms? | bytes gone; row kept so references render "removed" |

Indexes: `storage_key` unique; (workspace, sha256); `expires_at`.

## Search

Full text over `knowledge_notes.title/body`, `journal_entries.body` and
`messages.content` uses an FTS5 virtual table `knowledge_fts(entity_kind,
entity_id, workspace, text)` created by a hand-written migration and kept in
sync by the owning modules through knowledge's `index(entity, text)` API.
PostgreSQL uses a `tsvector` column on the same helper table with a GIN
index. Not a Drizzle-declared table on purpose: virtual tables are engine
specific.

## Queries the clients need

- Notes list: scoped, not archived, filter by kind/tag/project/task, order
  by `pinned desc, updated_at desc`.
- Journal: entries by `date` desc, `seq` asc; month view = distinct dates.
- Upload: create attachment row → store bytes → return id; clients then put
  the id in a message, note or journal entry.
- Serve: attachment by id, scoped, `deleted_at is null`, bytes from storage.
- Search: `knowledge_fts match ?` filtered by workspace, top N per kind.

## Not stored

- Agent memory: Hermes `MEMORY.md`/user profile, Claude Code project memory,
  Codex notes. The adapter exposes read (and, with approval, write) and the
  screen renders it live; nothing is copied into the hub database.
- Skills sources: listed through the adapter, exposed through plugins.
- Attachment bytes: on disk under the data directory, keyed by
  `storage_key`; the database holds metadata only.
