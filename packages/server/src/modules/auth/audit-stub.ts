// TEMPORARY. The `audit` module owns `audit_events` and `jobs` (docs/domain/README.md) but does
// not export `record()` / `createJob()` yet. Until it does, auth writes the two rows it needs
// through this stub with plain SQL against the columns in modules/audit/schema.ts, so the
// audit trail exists from day one and the export/import jobs are queued where the worker
// will find them. Delete this file when audit's index.ts exports the real functions.
import { sql } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';

export type AuditActorKind = 'user' | 'agent' | 'system' | 'schedule' | 'workflow' | 'device';

export interface AuditEventInput {
  actorKind: AuditActorKind;
  actorId?: string | null;
  /** `<entity>.<verb>`: `auth.login`, `auth.pairing_claimed`, `auth.token_revoked`. */
  action: string;
  entityKind?: string | null;
  entityId?: string | null;
  /** One English line; clients localise by `action`. Never a secret. */
  summary?: string;
  data?: Record<string, unknown>;
  deviceId?: string | null;
  requestId?: string | null;
  /** The user the row is attributed to (`owner_id`); the owner account for system actions. */
  ownerId: string;
}

export function recordAudit(db: ModuleDb, event: AuditEventInput, now: number): string {
  const id = newUlid(now);
  db.run(sql`
    insert into audit_events
      (id, owner_id, created_at, updated_at, workspace, actor_kind, actor_id, action,
       entity_kind, entity_id, summary, data, device_id, request_id)
    values
      (${id}, ${event.ownerId}, ${now}, ${now}, ${null}, ${event.actorKind}, ${event.actorId ?? null},
       ${event.action}, ${event.entityKind ?? null}, ${event.entityId ?? null},
       ${event.summary ?? null}, ${JSON.stringify(event.data ?? {})}, ${event.deviceId ?? null},
       ${event.requestId ?? null})
  `);
  return id;
}

export interface JobInput {
  ownerId: string;
  workspace: string | null;
  /** `<module>.<verb>`: `auth.profile_export`, `auth.profile_import`. */
  kind: string;
  entityKind?: string | null;
  entityId?: string | null;
  input?: Record<string, unknown>;
}

/** Queues a job row (`status = queued`); no worker exists yet, the jobs task adds it. */
export function enqueueJob(db: ModuleDb, job: JobInput, now: number): string {
  const id = newUlid(now);
  db.run(sql`
    insert into jobs
      (id, owner_id, created_at, updated_at, workspace, kind, status, progress,
       entity_kind, entity_id, input, attempts)
    values
      (${id}, ${job.ownerId}, ${now}, ${now}, ${job.workspace}, ${job.kind}, ${'queued'}, ${-1},
       ${job.entityKind ?? null}, ${job.entityId ?? null}, ${JSON.stringify(job.input ?? {})}, ${0})
  `);
  return id;
}
