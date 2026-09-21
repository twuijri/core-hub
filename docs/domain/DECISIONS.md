# Domain modelling decisions

Each entry: the choice, why, and the alternatives rejected. A later ADR may
supersede an entry; do not edit one in place, add a note pointing forward.

## 1. Two message tables: `messages` (sessions) and `room_messages` (rooms)

**Chosen.** A session message is a transcript line between one user and one
agent: it has a role, a run, tool calls and reasoning. A room message is a
line in a group log: it has an author that is a seat or a user, mentions,
replies, and no role. A seat's private session receives a *rendering* of the
room log as its own `messages` rows, so the two tables never hold the same
fact.

**Rejected: one polymorphic `message` table with `container_kind` /
`container_id`.** Half the columns would be null in each case, the two
streams would share one `seq` space for no reason, the realtime namespaces
(`/rt/sessions`, `/rt/rooms`) would filter the same table, and any index
would be a compromise between two access patterns.

**Rejected: room messages as session messages of a shared session.** Rooms
then could not seat two agents with different models, adapters or working
directories, which is the point of a room.

## 2. `run` is the unit of streaming, cost and approval, not `message`

**Chosen.** One user turn = one `run`; the run owns tool calls, approvals,
status, errors and (via audit) usage. Messages point at their run. Retries
are new runs with `attempt + 1` on the same trigger message.

**Rejected: status and cost on the assistant message.** A turn can end with
no assistant message (failed before the first token) or with several
(tool narration, then the answer). Approvals and interrupts need a target
that exists before any message does.

## 3. Usage and cost live in `audit.usage_records`, keyed by run

**Chosen.** One row per (run, model label) the adapter reported, with tokens,
`cost_micro_usd`, `cost_source` (`provider` | `estimated` | `unknown`) and a
copy of the run's `origin_kind`/`origin_id`. Cost per session, task, schedule,
room or agent is a sum over this table; the sessions module asks audit for
totals when a client wants "cost so far".

**Rejected: token columns on `runs`.** The run would carry two truths once a
run spans models (fallback chains), and every roll-up screen would need to
join sessions to tasks to schedules. The copied origin columns are the
price of not joining.

**Rejected: a cost column on `sessions`, maintained incrementally.** Drift is
inevitable when a run is retried or a record is re-priced after the provider
publishes usage; a sum over an immutable ledger cannot drift.

Micro-USD integers, not decimals: SQLite has no decimal, floats do not sum
exactly, and bigint maps cleanly to PostgreSQL.

## 4. A task's worktree is tracked on `worktrees.task_id`, not on `tasks`

**Chosen.** `worktrees` rows carry `task_id`; a partial unique index
(`task_id where removed_at is null and task_id is not null`) guarantees at
most one live worktree per task while keeping removed ones as history.
"The task's worktree" is the one live row; a task's session carries
`worktree_id` so the agent runs in the right directory.

**Rejected: `tasks.worktree_id`.** Two pointers (task → worktree and
worktree → task) can disagree; history of removed worktrees would need a
second table; and creating the worktree is a job that finishes after the
task row exists, so the pointer would be null most of the time anyway.

**Rejected: worktree as a column set on `tasks` (path, branch, sha).** A
worktree has its own lifecycle (`creating … removed`), its own job and its
own stats; tasks without a repository (non-code tasks) would carry dead
columns.

## 5. Cross-module references are id columns without database foreign keys

**Chosen.** Inside a module, foreign keys exist and cascade (or set null).
Across modules, a reference is a plain ULID column; the referencing module
validates existence through the owner's public API and the owner answers 404
for stale ids (invariant 2). `db/schema.ts` aggregates every module for
Drizzle Kit but modules never import it.

**Rejected: foreign keys across modules.** A module would then mutate another
module's rows through `ON DELETE`, breaking invariant 1; the schema files
would import each other in cycles; and archive-then-purge semantics differ
per module (a purged session must *not* delete the task that used it).
The trade-off is honest: a nightly integrity job reports dangling ids per
module, and tests assert the 404 path.

## 6. `job` and `job_events` are owned by `audit`

**Chosen.** Long work is a job with progress (invariant 4). The audit module
already owns operational records (logs, snapshots); jobs are the log of work,
and every module from Phase 0 (agent install) onward needs them. Other
modules call `audit.jobs.create/progress/finish` and store the id.

**Rejected: a new `jobs` module.** Cleanest naming, but `ARCHITECTURE.md`
lists thirteen modules and adding one is an ADR, not a schema decision. If
the owner prefers it, moving the two tables is one file and one line in
`db/schema.ts`; the docs already treat jobs as their own section.

**Rejected: jobs in `agents`** (the first user): plugins, tasks, knowledge
and updates would depend on agents for something unrelated to agents.

## 7. Global tables omit `workspace`; three tables make it nullable

**Chosen.** The brief asks for `workspace` on every table. Users, workspaces
themselves, app tokens, devices, the agent registry, release channels, push
credentials, plugins and performance snapshots are host- or user-level facts;
giving them a `workspace` would either be a lie (a sentinel) or force copies
per workspace. They have no column. `audit_events`, `jobs` and `job_events`
keep a nullable `workspace` because the same table records hub-level rows
(login, server update) and scoped rows (a task moved, an agent installed for
a workspace).

**Rejected: a sentinel workspace id such as `"global"`.** Every scoped query
helper would need a special case and every audit screen would filter it out.

**Rejected: one table per workspace for the registry.** ADR 0005 says
workspaces own *settings* for agents and models, not the installed binaries;
`agent_settings` and `plugin_bindings` are the per-workspace half.

## 8. The agent registry is global; `agent_settings` is per workspace

**Chosen.** Whether Claude Code is installed on the host is one fact; which
model, approval mode and working directory it uses is per workspace.
`agent_settings` is unique per (workspace, agent) and created lazily with
defaults the first time a workspace uses an agent.

**Rejected: agents per workspace.** Installing an agent twice for two
workspaces makes no sense on one host, and Hermes has one gateway.

## 9. Enums are `text` + CHECK, never database enum types

**Chosen.** Adding a state is a migration that rewrites one CHECK; the TS
union comes from the exported constant (`RUN_STATUSES`) which the contract
reuses. Works identically on SQLite and PostgreSQL.

**Rejected: PostgreSQL `CREATE TYPE … AS ENUM`.** Not available on SQLite,
and altering PG enums inside transactions has historically been painful.

## 10. Timestamps are epoch milliseconds (integer), not ISO strings

**Chosen.** `integer` in SQLite, `bigint` in PostgreSQL, `Date` in
TypeScript, JSON number in the contract if the contract agent wants it or
ISO string converted at the edge. Sorting, indexing and comparing need no
parsing, and export/import between engines is byte-identical.

**Rejected: `timestamptz` on PostgreSQL only.** Nicer to read in `psql`, but
the two engines would then hold different representations of the same row,
and the drizzle query helpers would diverge.

## 11. Approvals and questions share one table

**Chosen.** `approvals.kind` includes `question`: a clarification the agent
asks is a pending item that blocks a run, needs a push notification, can
expire, and gets a response — the same lifecycle as a tool approval, with a
free-text answer instead of approve/deny. The run status distinguishes them
(`waiting_approval` vs `waiting_input`).

**Rejected: a separate `questions` table.** Two inbox queries, two
notification kinds with identical plumbing, two expiry sweepers.

## 12. A seat is backed by its own session

**Chosen.** `seats.session_id` points at a session owned by the sessions
module. Every seat turn is an ordinary run with tool calls, approvals and
usage; rooms only fan messages in and out. Room cost is a sum of its seats'
sessions (usage records carry `origin_kind = "room"`).

**Rejected: rooms driving adapters directly.** Rooms would duplicate the
run machine, approvals and usage; the ADR 0002 rule that rooms see only
`AgentAdapter` is honoured by routing through sessions instead.

## 13. Schedules keep their own tick ledger (`schedule_runs`)

**Chosen.** A schedule tick is a fact even when it produced nothing
(`skipped` by overlap or misfire policy). Each tick links to the session run
or workflow run it produced, so the history screen from the phone client
(run time, status, error, preview) is one query.

**Rejected: deriving history from `runs where origin_kind = 'schedule'`.**
Skipped ticks would vanish, and workflow-targeted schedules would need a
second query on `workflow_runs`.

**Rejected: every schedule is a one-node workflow.** Uniform, but the
"prompt at 9:00" case — the common one — would create hidden workflow rows
the user never sees or edits.

## 14. Workflow definitions are JSON, snapshotted per run

**Chosen.** `workflows.definition` holds the node/edge DAG; `workflow_runs`
copies it as `definition_snapshot` with `workflow_version`. Node runs are
rows because they carry status, timing and links to runs/approvals/tasks.

**Rejected: `workflow_nodes` and `workflow_edges` tables.** Editing a DAG is
a whole-document operation in every UI; row-level nodes only add joins and
make versioning harder. Validation of the JSON is the contract's job.

## 15. Attachments are one table for every file, referenced by id lists

**Chosen.** `attachments` is the single file registry (uploads, tool output
overflow, device captures, journal media). Messages, room messages and
journal entries carry `attachment_ids` as a JSON array; tool calls and
device commands carry a single id column.

**Rejected: join tables (`message_attachments`, ...).** Three join tables for
"show the thumbnails of this message" is more schema than value; the only
query lost is "which messages use this attachment", which the sweeper
answers by scanning candidates once a day.

## 16. Room memory is a column, not a note

**Chosen.** `rooms.memory` is the rolling summary the hub maintains and
injects into every seat. It belongs to the room, is regenerated by the hub,
and has no life outside it.

**Rejected: a `knowledge_note` of kind `memory` per room.** It would put a
rooms-owned lifecycle in the knowledge module and surface machine summaries
in the user's notes list.

## 17. Push tokens live on `devices`, push credentials in `notify`

**Chosen.** A device registers its push token when it pairs or refreshes;
that is a device fact. The FCM/APNs/VAPID server credentials are hub-level
notify configuration with their own encrypted table.

**Rejected: a global `secrets` scope for push credentials.** Secrets are
per workspace (providers are per workspace, ADR 0005); bending that for two
rows is worse than one small table.

## 18. `task_transitions` records more than status

**Chosen.** `field` ∈ {status, assignee, priority, project} with
`from_value`/`to_value` text. The activity feed of a task is one ordered
query; agents and users appear as `actor_kind`/`actor_id`.

**Rejected: status-only transitions plus audit events for the rest.** The
task screen would merge two tables with different shapes; the audit log is
global and admin-only.

## 19. Users are hub-level with a member list per workspace

**Chosen.** `users` is global with one role (owner/admin/member, as
`ARCHITECTURE.md` lists); `workspace_members` says which workspaces a member
may use. Owner and admin see every workspace.

**Rejected: per-workspace roles.** Not in the architecture; can be added as
a column on `workspace_members` without a migration of `users`.

## 20. Login lockouts store the client IP in clear

**Chosen.** The admin screen lists locked IPs (the phone client shows it).
These are visitor addresses, not the owner's hosts; they are never written
to audit `data`.

**Rejected: hashed IPs.** Unusable for the "unlock this address" action.
