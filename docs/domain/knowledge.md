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
| storage_key | text | path relative to `<data>/attachments`; never absolute. Content addressed: every row with the same bytes in a workspace shares it (`DECISIONS.md` §39) |
| kind | enum(image, audio, video, file, diff, log) | |
| source_kind | enum(upload, agent_output, tool_output, device, journal, export) | |
| source_id | ulid? | the message, tool call, device command or journal entry |
| meta | json<AttachmentMeta> | width, height, durationMs, entryName, `purpose`, `producedPath` |
| expires_at | ms? | temporary files (tool output) |
| deleted_at | ms? | bytes gone; row kept so references render "removed" |

Indexes: (workspace, storage_key); (workspace, sha256); `expires_at`. The storage key is
**not** unique: each upload is a row of its own over shared bytes, and a delete removes the
bytes only when no live row still points at them (migration `0013`).

`purpose` (the contract's `AttachmentPurpose`) lives in `meta` rather than in a
column: it is a rendering hint the client sends and reads back, never something the
hub filters or indexes by, so a column would cost a migration for nothing.
`producedPath` is set for a file an agent wrote, and holds its path relative to the
run's output folder.

### What the store actually enforces

Implemented in `packages/server/src/modules/knowledge/` and exercised by
`attachments.test.ts` / `attachments-api.test.ts`:

- **Names are never paths.** `media.sanitiseFilename` keeps the basename only, strips
  control characters and NUL, refuses a leading dot, escapes Windows-reserved stems and
  caps the length at 255. The bytes are addressed by their hash, never by the name.
- **Types are sniffed, not believed.** `media.sniffMime` reads the first 64 bytes; the
  signature wins, then the extension for text, then `application/octet-stream`. A `.exe`
  announced as `image/png` is stored as `application/x-msdownload`, and the mismatch is
  logged.
- **Limits** are the contract's: 25 MB for `sessions.uploadAttachment`, 50 MB and
  256 KiB chunks for the resumable flow, and a refusal carries `payload_too_large` with
  `details.max_bytes`.
- **Bytes stream.** Uploads go through a hash and a temp file into
  `${DATA_DIR}/attachments/<workspace>/<aa>/<sha256>`; downloads answer a read stream and
  honour one `Range`. Nothing is buffered whole.
- **De-duplication** is per workspace, by `(sha256, size)`: the same screenshot in ten
  messages is one file on disk.
- **Deletion** is refused with `409` while a message points at the attachment
  (`sessions` answers that question through a port); otherwise the row is marked
  `deleted_at` and the bytes go once nothing else shares them.

### Attachments and a run

`sessions` holds ids and asks `knowledge` for the bytes
(`modules/sessions/ports.ts` §`AttachmentsPort`). One turn owns two folders under the
session's working directory:

```
<session.working_dir>/.corehub/runs/<run id>/in     the person's attachments, copied
<session.working_dir>/.corehub/runs/<run id>/out    what the agent writes back
```

The prompt names both, because Hermes's run surface takes one text `input` and no
files (ADR 0008). Files left in `out` when the turn ends become attachments of the
reply, capped at 20 files, 25 MB each and 100 MB in total; what the caps refused is
named in the message, never dropped in silence.

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
