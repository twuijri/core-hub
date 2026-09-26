# tasks

The Tasks section (a kanban-style board of columns and cards). Owns:
`project`, `task`, `task_transition`, `task_dependency`, `worktree`.
Schema: `packages/server/src/modules/tasks/schema.ts`. All scoped. Base
columns omitted.

Realtime namespace `/rt/tasks`: `task.created`, `task.moved`,
`task.assigned`, `task.updated`, `worktree.ready`, `worktree.removed`.

Phase 1 "done" in the roadmap: a task assigned to an agent from the Tasks
section runs in its own worktree, reports progress in a room, and a schedule
can run a standup. The columns below are what that needs.

## project (scoped)

| column | type | meaning |
|---|---|---|
| name | text(120) | |
| key | text(10) | upper-case prefix for task numbers ("HUB-12"); unique per workspace |
| description, color | | |
| repo_url | text? | |
| local_path | text? | checkout on the hub host that worktrees are created from |
| default_branch | text(120) ("main") | |
| default_agent_id | ulid? → agents.agent | pre-selected assignee |
| status | enum(active, paused, completed) | paused projects do not auto-start tasks |
| settings | json<ProjectSettings> | worktreeBaseDir, branchTemplate, freshSessionPerAttempt, checks |
| task_counter | int | last number handed out; bumped in the insert transaction |
| archived_at | ms? | |

Indexes: unique (workspace, key); (workspace, archived_at).

## task (scoped)

Lifecycle in `README.md` §task.

| column | type | meaning |
|---|---|---|
| project_id | ulid → project (FK, cascade) | |
| number | int | per project; unique (project_id, number) |
| title | text(300) | |
| description | text? | Markdown brief the agent receives verbatim |
| status | enum(backlog, todo, in_progress, blocked, review, done, cancelled) | the column the card sits in |
| priority | enum(urgent, high, normal, low) | |
| assignee_kind | enum(none, user, agent) | |
| assignee_user_id | ulid? → auth.user | |
| assignee_agent_id | ulid? → agents.agent | |
| parent_id | ulid? → task (FK, set null) | subtasks |
| sort_key | text(64) | fractional ordering inside a column; the client sends "between a and b", the server computes the key |
| labels | json<string[]> | |
| due_at, started_at, completed_at | ms? | |
| blocked_reason | text? | required when status = blocked |
| session_id | ulid? → sessions.session | the working session (`origin_kind = task`) |
| current_run_id | ulid? → sessions.run | in-flight run; null when idle |
| room_id | ulid? → rooms.room | where progress is posted |
| attempt_count | int | agent runs started for this task |
| archived_at | ms? | |
| stuck_at | ms? | the stuck-task watchdog's marker while `running`: when the run last showed activity (DECISIONS §92); cleared by activity or any move |

Indexes: unique (project_id, number); `tasks_workspace_status_idx` on
(workspace, archived_at, status, sort_key) for the columns; (project_id,
status); (assignee_agent_id, status)
for "what is this agent doing"; `parent_id`.

## task_transition (scoped)

Append-only history (`DECISIONS.md` §18).

| column | type | meaning |
|---|---|---|
| task_id | ulid → task (FK, cascade) | |
| field | enum(status, assignee, priority, project) | |
| from_value, to_value | text(64) | status names, ids, or priorities |
| actor_kind | enum(user, agent, system, schedule, workflow) | |
| actor_id | ulid? | |
| run_id | ulid? → sessions.run | the run that moved it |
| note | text? | "reopened", the review comment, the block reason |

Indexes: (task_id, created_at).

## task_dependency (scoped)

| column | type | meaning |
|---|---|---|
| task_id | ulid → task (FK, cascade) | |
| depends_on_task_id | ulid → task (FK, cascade); ≠ task_id (CHECK) | |

Indexes: unique pair; `depends_on_task_id`. Cycle detection is a service
rule (walk before insert), not a constraint. A dependency is done when its task is
`done`, or `archived` with `completed_at` (the weekly archive); a task with
`auto_start` does not start on its own until every dependency is done (DECISIONS §92).

## worktree (scoped)

`DECISIONS.md` §4. Lifecycle in `README.md` §task.

| column | type | meaning |
|---|---|---|
| project_id | ulid → project (FK, cascade) | |
| task_id | ulid? → task (FK, set null) | at most one live worktree per task (partial unique index) |
| path | text, unique | absolute path on the hub host |
| branch | text(200) | |
| base_ref | text(64)? | commit created from |
| head_sha | text(64)? | last observed commit |
| status | enum(creating, ready, dirty, merged, removed, failed) | |
| create_job_id | ulid? → audit.job | |
| pr_url | text? | |
| stats | json<WorktreeStats> | ahead, behind, changedFiles, additions, deletions |
| last_synced_at, removed_at | ms? | |
| error | text? | |

Indexes: `worktrees_live_task_uq` on (task_id) where `removed_at is null and
task_id is not null`; `path` unique; (project_id, status).

## Queries the clients need

- Columns: tasks of the workspace (optionally one project), not archived,
  grouped by `status`, ordered by `sort_key`; with assignee name/avatar,
  live worktree status and `current_run_id`.
- Task screen: the task, its transitions (newest first), dependencies both
  ways, live worktree with stats, the session link, and audit cost for
  `origin_kind = task`.
- Move: update status + sort_key, insert transition, emit `task.moved`;
  when moving to `in_progress` with an agent assignee: ensure worktree (job),
  ensure session, create run via sessions.
- Assign to agent: set assignee, insert transition, optionally auto-start.
- My work: `tasks where assignee_user_id = me and status in (todo, in_progress, review)`.

## Not stored

- File contents of the worktree, diffs (a diff is an attachment produced by
  a tool call, owned by knowledge).
- Git objects; only refs and shas.
- Column definitions: the status enum is the column set; custom columns are
  a future ADR.
