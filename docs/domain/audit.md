# audit

Owns: `audit_event`, `usage_record`, `job`, `job_event`. Schema: `packages/server/src/modules/audit/schema.ts`.

`usage_records` is scoped. (`performance_snapshots` was dropped by migration
`0023`, contract decision §74: Performance is measured when asked.)
`audit_events`, `jobs`, `job_events` carry a **nullable** `workspace`
(hub-level rows have none). Base columns omitted. Jobs are here by
`DECISIONS.md` §6.

Realtime: jobs stream `job.progress`, `job.finished` on the namespace of the
module that started them (an install job on `/rt/agents`-less REST polling in
Phase 0; the contract decides the namespace).

## audit_event (global, workspace nullable)

Append-only. Never updated, never deleted by a user; trimmed by age.

| column | type | meaning |
|---|---|---|
| workspace | ulid? | null for hub-level actions |
| actor_kind | enum(user, agent, system, schedule, workflow, device) | |
| actor_id | ulid? | |
| action | text(64) | `<entity>.<verb>`, same vocabulary as realtime events: `task.moved`, `secret.created`, `auth.login_failed` |
| entity_kind, entity_id | text(32)?, ulid? | |
| summary | text(300)? | one English line; clients localise by `action` |
| data | json | redacted before/after; never secrets, never message bodies |
| device_id | ulid? → devices.device | |
| request_id | text(64)? | correlates with server logs |

Indexes: `created_at`; (workspace, created_at); (entity_kind, entity_id);
(actor_kind, actor_id).

## usage_record (scoped)

The cost ledger (`DECISIONS.md` §3). One row per (run, model label).

| column | type | meaning |
|---|---|---|
| run_id | ulid → sessions.run | |
| session_id | ulid → sessions.session | |
| agent_id | ulid → agents.agent | |
| provider_id | ulid? → models.provider | |
| model_label | text(200) | unique with run_id |
| input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens | int | |
| cost_micro_usd | int | 1e-6 USD; integer sums |
| cost_source | enum(provider, estimated, unknown) | reported by the provider, computed from `models.pricing`, or unknown (local models) |
| origin_kind, origin_id | as the run | copied for roll-ups by task / schedule / room |
| recorded_at | ms | |

Indexes: unique (run_id, model_label); (workspace, recorded_at);
`session_id`; (workspace, agent_id, recorded_at); (origin_kind, origin_id).

## performance_snapshot (global)

| column | type | meaning |
|---|---|---|
| captured_at | ms | every minute, kept 7 days |
| cpu_percent | real | |
| memory_bytes, disk_free_bytes, db_bytes | int? | |
| active_runs, queued_jobs, connected_clients | int | |
| data | json | anything else the dashboard plots |

## The jobs kernel

Other modules never touch these tables: they take `AuditService` and `JobRunner` from
`modules/audit/index.ts`. `record()` writes the audit trail;
`createJob / startJob / progressJob / finishJob / requestCancel` drive a job, and every
one of those transitions is announced on `/rt/jobs`, so a client polling `jobs.list` and a
client on the socket see one history. `JobRunner.start()` wraps the common case — work
that is a single async function — and hands it a handle for progress and cancellation; a
module whose work is a stream drives `AuditService` directly.

Two shapes differ from the contract on purpose: `kind` stores `<module>.<verb>` while the
API sends the verb (the contract's `JobKind`), and the table's `cancelling` state ("cancel
asked, worker still winding down") is reported as `running`, because the contract has no
such value.

A job with a null `workspace` (importing a profile creates the workspace it belongs to)
is invisible to `jobs.list`, which is workspace-scoped, while the contract's `Job.profile`
is not nullable; the operation that needs such a job owns that gap.

## job (global, workspace nullable)

Lifecycle in `README.md` §job.

| column | type | meaning |
|---|---|---|
| workspace | ulid? | null for hub-level jobs (server update, backup) |
| kind | text(64) | `<module>.<verb>`: `agents.install`, `tasks.worktree_create`, `plugins.install`, `knowledge.reindex`, `auth.workspace_purge` |
| status | enum(queued, running, cancelling, succeeded, failed, cancelled) | |
| progress | int | 0–100, or -1 for indeterminate |
| progress_message | text(300)? | |
| entity_kind, entity_id | | the subject (agent, worktree, plugin) |
| input | json | |
| result | json? | |
| error_code, error_message | | |
| attempts | int | |
| parent_job_id | ulid? → job (FK, set null) | sub-jobs |
| started_at, finished_at, cancel_requested_at | ms? | |
| heartbeat_at | ms? | worker liveness; stale on restart → failed(`stale`) |

Indexes: (status, created_at) for the worker; (workspace, created_at);
(entity_kind, entity_id).

## job_event (global, workspace nullable)

| column | type | meaning |
|---|---|---|
| job_id | ulid → job (FK, cascade) | |
| seq | int | unique per job |
| level | enum(debug, info, warn, error, progress) | |
| message | text | |
| data | json | |

## Queries the clients need

- Job screen: job by id + events by `seq`; progress bar from `progress`.
- Running jobs badge: `jobs where status in (queued, running, cancelling)`
  for the workspace.
- Usage dashboard: `usage_records` summed by day / agent / provider / origin
  for a period; session cost = sum by `session_id`.
- Audit log (admin): `audit_events` newest first, filter by workspace,
  actor, action, entity.
- Performance: measured when asked, never stored (`live.ts`, contract
  decision §51).

## Not stored

- Server log lines (stdout, rotated files), except what a job chooses to
  record as a `job_event`.
- Request bodies; only `request_id`.
- Prices themselves (on `models.pricing`); a usage record freezes the cost
  it computed.
