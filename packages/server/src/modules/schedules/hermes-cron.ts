/**
 * The hub's schedules reflecting Hermes's cron.
 *
 * `hermes-jobs.ts` talks to Hermes; this decides when, and what it means for the rows.
 * The owner's rules (2026-09-23), the same as for the board:
 *
 * 1. **One Schedules page.** Hermes's jobs appear on it beside every other schedule —
 *    including the ones Hermes made itself, from a chat or its own CLI.
 * 2. **Hermes wins.** On every read, what Hermes says about a job overwrites the
 *    reflection; a job Hermes no longer lists leaves the page.
 * 3. **Writes go through Hermes.** A schedule for the Hermes agent is created, edited,
 *    paused, fired and deleted *on Hermes*, and Hermes fires it. If Hermes refuses, the
 *    hub refuses with Hermes's words and changes nothing.
 *
 * That third rule is also why these schedules actually run while the hub's own worker
 * does not exist yet: Hermes has a scheduler, and the hub does not pretend to be one.
 */
import { HubError, conflict } from '../../lib/errors.js';
import {
  HermesJobRefusal,
  HermesUnreachable,
  hermesScheduleOf,
  type HermesJob,
  type HermesJobs,
  type HermesJobWrite,
} from './hermes-jobs.js';
import type { ScheduleRow, SchedulesService, Scope } from './service.js';

/** What the mirror needs from the rest of the hub. Composed in `modules/index.ts`. */
export interface HermesCronPort {
  /** Hermes's scheduler, or `null` when there is no Hermes gateway to ask. */
  jobs(): HermesJobs | null;
  /** The registry id of the Hermes agent in this workspace. */
  agentId(workspace: string): string | null;
  /** The IANA zone Hermes evaluates cron expressions in (`timezone` in its config). */
  timezone(): string;
  /** How stale the reflection may be when someone opens the page. Five seconds by default. */
  throttleMs?: number;
}

export interface CronSyncReport {
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}

type Body = Record<string, unknown>;

export class HermesCron {
  private readonly lastSync = new Map<string, number>();

  constructor(private readonly port: HermesCronPort) {}

  /** Bring the reflection up to date, at most once per throttle window. Never throws. */
  async sync(
    service: SchedulesService,
    scope: Scope,
    force = false,
  ): Promise<CronSyncReport | null> {
    const jobs = this.port.jobs();
    if (!jobs) return null;
    const now = Date.now();
    const last = this.lastSync.get(scope.workspace) ?? 0;
    if (!force && now - last < (this.port.throttleMs ?? 5_000)) return null;
    this.lastSync.set(scope.workspace, now);

    let listed: HermesJob[];
    try {
      listed = await jobs.list();
    } catch (error) {
      return {
        added: 0,
        updated: 0,
        removed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Nothing past the list may escape either: a job that does not fit is reported, never
    // a Schedules page that fails for everyone.
    try {
      if (!Array.isArray(listed)) throw new Error('hermes did not answer a list of jobs');
      const context = this.contextFor(scope.workspace);
      const seen = new Set<string>();
      let added = 0;
      let updated = 0;
      for (const job of listed) {
        const reflected = service.reflectHermes(scope, job, context);
        if (!reflected) continue;
        seen.add(job.id);
        if (reflected.created) added += 1;
        else updated += 1;
      }
      let removed = 0;
      for (const row of service.hermesRows(scope)) {
        if (row.externalId && !seen.has(row.externalId) && !row.archivedAt) {
          service.archiveReflection(row.id);
          removed += 1;
        }
      }
      return { added, updated, removed, error: null };
    } catch (error) {
      return {
        added: 0,
        updated: 0,
        removed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** True when this target is a prompt for the Hermes agent of this workspace. */
  targetsHermes(workspace: string, target: Body | undefined): boolean {
    if (!target || target.kind === 'workflow' || !this.port.jobs()) return false;
    const agentId = target.agent_id as string | null | undefined;
    return !!agentId && agentId === this.port.agentId(workspace);
  }

  /**
   * What Hermes cannot do, refused before anything is written — with what it would take.
   * Hermes evaluates cron in one zone for all its jobs; it posts to messaging platforms but
   * not into the hub's notices or rooms; and a Hermes job is a prompt.
   */
  checkWritable(input: Body): void {
    const trigger = input.trigger as Body | undefined;
    if (trigger?.kind === 'cron') {
      const asked = (trigger.timezone as string | undefined) ?? 'UTC';
      const hermes = this.port.timezone();
      if (asked !== hermes) {
        throw conflict({ reason: 'hermes_timezone', field: 'trigger.timezone', timezone: hermes });
      }
    }
    const delivery = input.delivery as Body | undefined;
    if (delivery && delivery.kind !== 'none' && delivery.kind !== 'channel') {
      throw conflict({ reason: 'hermes_delivery', field: 'delivery.kind', kind: delivery.kind });
    }
    const target = input.target as Body | undefined;
    if (target && !String(target.prompt ?? '').trim()) {
      throw conflict({ reason: 'hermes_prompt_required', field: 'target.prompt' });
    }
    // Hermes decides both for its own jobs, per profile and not per job: a missed time runs
    // by its `cron.catch_up_missed` (on unless the profile's config says otherwise), and a
    // job still running is always skipped (DECISIONS §40). A value here would not be kept.
    for (const field of ['run_if_missed', 'overlap'] as const) {
      if (input[field] !== undefined && input[field] !== null) {
        throw conflict({ reason: 'hermes_run_options', field });
      }
    }
  }

  /** The whole job, from a row the hub just saved. */
  jobOf(row: ScheduleRow): HermesJobWrite {
    return {
      name: row.name,
      schedule: hermesScheduleOf(triggerOf(row)),
      prompt: row.prompt ?? '',
      skills: row.skills,
      ...(row.repeatLimit === null ? {} : { repeat: row.repeatLimit }),
      deliver: deliverOf(row),
      paused: !row.enabled,
    };
  }

  /** Only what a patch changes, in Hermes's field names — `enabled` travels separately. */
  patchOf(patch: Body, merged: ScheduleRow): HermesJobWrite {
    const out: HermesJobWrite = {};
    if (patch.name !== undefined) out.name = merged.name;
    if (patch.trigger !== undefined) out.schedule = hermesScheduleOf(triggerOf(merged));
    const target = patch.target as Body | undefined;
    if (target?.prompt !== undefined) out.prompt = merged.prompt ?? '';
    if (target?.skills !== undefined) out.skills = merged.skills;
    if (patch.repeat !== undefined) out.repeat = merged.repeatLimit;
    if (patch.delivery !== undefined) out.deliver = deliverOf(merged);
    return out;
  }

  jobs(): HermesJobs | null {
    return this.port.jobs();
  }

  contextFor(workspace: string): { agentId: string | null; timezone: string } {
    return { agentId: this.port.agentId(workspace), timezone: this.port.timezone() };
  }
}

/**
 * Hermes said no: answer 409 with Hermes's own sentence. Hermes did not answer: 422, the
 * agent is unavailable. Anything else is the hub's own error and stays one.
 */
export function refusedByHermesCron(error: unknown): never {
  if (error instanceof HermesJobRefusal) {
    throw conflict({ reason: 'hermes_refused', status: error.status, message: error.message });
  }
  if (error instanceof HermesUnreachable) {
    throw new HubError('agent_unavailable', {
      details: { reason: 'hermes_unreachable', message: error.message },
    });
  }
  throw error;
}

function triggerOf(row: ScheduleRow) {
  return {
    kind: row.kind,
    expression: row.cronExpr,
    every_minutes: row.intervalSeconds === null ? null : Math.round(row.intervalSeconds / 60),
    run_at: row.runAt?.toISOString() ?? null,
  };
}

function deliverOf(row: ScheduleRow): string {
  const channel = row.delivery.channel;
  if (!channel) return 'local';
  return row.delivery.address ? `${channel}:${row.delivery.address}` : channel;
}
