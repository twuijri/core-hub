# schedules

Owns: `schedule`, `schedule_run`, `workflow`, `workflow_run`, `node_run`.
Schema: `packages/server/src/modules/schedules/schema.ts`. All scoped. Base
columns omitted.

Realtime namespace `/rt/schedules`: `schedule.fired`, `schedule_run.finished`,
`workflow_run.started`, `node_run.started`, `node_run.finished`,
`workflow_run.waiting`, `workflow_run.paused`, `workflow_run.finished`.

## schedule (scoped)

What the phone client's "cron job" screen edits: name, schedule, prompt,
skills, model, delivery, repeat.

| column | type | meaning |
|---|---|---|
| name, description | | |
| kind | enum(cron, interval, once) | |
| cron_expr | text(120)? | 5-field, evaluated in `timezone` |
| timezone | text(64) ("UTC") | IANA name |
| interval_seconds | int? | kind=interval |
| run_at | ms? | kind=once |
| enabled | bool | |
| target_kind | enum(prompt, workflow) | |
| agent_id | ulid? → agents.agent | prompt target |
| workflow_id | ulid? → workflow (FK, set null) | workflow target |
| prompt | text? | |
| model_id | ulid? → models.model | |
| skills | json<string[]> | Hermes skills to enable |
| delivery | json<ScheduleDelivery> | roomId, notify, webhookId — where the answer goes besides its session |
| repeat_limit, repeat_count | int?, int | "run N times" |
| overlap_policy | enum(skip, queue, parallel) | when the previous tick is still running |
| misfire_policy | enum(skip, run_once) | when the server was down at tick time |
| next_run_at, last_run_at | ms? | scheduler cursor |
| last_status | enum(schedule_run statuses)? | list badge |
| archived_at | ms? | |

Indexes: (enabled, next_run_at) for the scheduler loop; (workspace, archived_at).

## schedule_run (scoped)

One tick (`DECISIONS.md` §13).

| column | type | meaning |
|---|---|---|
| schedule_id | ulid → schedule (FK, cascade) | |
| scheduled_for | ms | the tick; unique per schedule, so a restart cannot double-fire |
| status | enum(queued, running, succeeded, failed, skipped, cancelled) | |
| run_id | ulid? → sessions.run | prompt target |
| workflow_run_id | ulid? → workflow_run (FK, set null) | workflow target |
| output_preview | text(500)? | first lines, for the history list |
| error | text? | |
| started_at, finished_at | ms? | |

Lifecycle: `queued → running → succeeded | failed | cancelled`, or
`queued → skipped` by policy. Terminal: succeeded, failed, skipped, cancelled.

Indexes: unique (schedule_id, scheduled_for); (schedule_id, created_at).

## workflow (scoped)

`DECISIONS.md` §14.

| column | type | meaning |
|---|---|---|
| name, description | | |
| version | int | bumped on every definition change |
| definition | json<WorkflowDefinition> | nodes (key, type, config), edges (from, to, when), declared inputs |
| trigger_kind | enum(manual, schedule, event) | |
| event_key | text(64)? | e.g. `task.moved` for event triggers |
| enabled | bool | |
| archived_at | ms? | |

Node types: `agent_run`, `approval`, `condition`, `delay`, `webhook`, `task`,
`notify`, `room_post`.

Indexes: (workspace, archived_at); (enabled, trigger_kind, event_key).

## workflow_run (scoped)

Lifecycle in `README.md` §workflow_run.

| column | type | meaning |
|---|---|---|
| workflow_id | ulid → workflow (FK, cascade) | |
| schedule_id | ulid? → schedule (FK, set null) | |
| trigger_kind | enum(manual, schedule, event, api) | |
| trigger_ref | ulid? | schedule_run, task, … |
| status | enum(queued, running, waiting_approval, paused, succeeded, failed, cancelled, timed_out) | |
| workflow_version | int | |
| definition_snapshot | json<WorkflowDefinition> | frozen copy |
| input, output | json | |
| active_node_keys | json<string[]> | for the live diagram |
| error | text? | |
| started_at, finished_at | ms? | |

Indexes: (workflow_id, created_at); (workspace, status).

## node_run (scoped)

| column | type | meaning |
|---|---|---|
| workflow_run_id | ulid → workflow_run (FK, cascade) | |
| node_key, node_type | | from the snapshot |
| attempt | int | unique (workflow_run_id, node_key, attempt) |
| status | enum(pending, running, waiting_approval, succeeded, failed, skipped, cancelled) | |
| input, output | json | |
| error | text? | |
| run_id | ulid? → sessions.run | agent_run nodes |
| approval_id | ulid? → sessions.approval | approval nodes |
| task_id | ulid? → board.task | task nodes |
| started_at, finished_at | ms? | |

## Queries the clients need

- Schedules list: scoped, not archived, with `next_run_at`, `last_status`,
  agent/workflow name.
- Schedule history: `schedule_runs where schedule_id` newest first; open a
  row → the session run or the workflow run.
- Delivery targets picker: rooms (rooms module), webhooks (notify module).
- Workflow editor: the `definition`; run list; a run's node runs with their
  linked run/approval/task for drill-down.
- Scheduler loop: `schedules where enabled and next_run_at <= now`, claim by
  inserting the `schedule_run` (unique tick), then dispatch.
- Pending approvals inside workflows: sessions' approvals with
  `origin_kind = workflow` (set on the run) plus `workflow_runs where status
  = waiting_approval`.

## Not stored

- Cron evaluation state beyond `next_run_at`.
- The rendered prompt sent to the agent (it is the run's trigger message in
  the session).
- Workflow node code: node types are server code; the definition only
  configures them.
