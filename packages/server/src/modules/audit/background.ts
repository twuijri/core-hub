/**
 * The Background panel (contract decision §56): everything working for one person, gathered
 * from the modules that do the work.
 *
 * This module owns the jobs, so it owns the list; the other kinds of work — runs and subagents
 * (`sessions`), workflow runs (`schedules`) — are *sources* the composition root registers here
 * (`registerBackgroundSource`), so no module imports another. Each source answers for its own
 * kinds, and stops only its own.
 */
import type { FastifyInstance } from 'fastify';
import type { JobRow } from './service.js';

export type BackgroundKind =
  'chat_run' | 'task_run' | 'schedule_run' | 'workflow_run' | 'job' | 'subagent';
export type BackgroundStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The contract's `BackgroundItem`. */
export interface BackgroundItem {
  id: string;
  kind: BackgroundKind;
  job_kind: string | null;
  title: string;
  profile: string;
  status: BackgroundStatus;
  started_at: string | null;
  finished_at: string | null;
  stoppable: boolean;
  session_id: string | null;
  resource: { kind: string; id: string } | null;
}

/** Who is looking, and the workspaces the list covers. */
export interface BackgroundCaller {
  userId: string;
  workspaces: ReadonlyArray<{ id: string; slug: string }>;
}

/** One module's share of the list. */
export interface BackgroundSource {
  /** The `id` prefixes this source answers for (`run`, `workflow_run`, `subagent`). */
  readonly prefixes: readonly string[];
  /** The caller's items: every running one, and those finished at or after `since`. */
  list(caller: BackgroundCaller, since: number): BackgroundItem[];
  /**
   * Stop one of the caller's items in `workspace`. `null` when it is not there (or not the
   * caller's); a `HubError` for one that cannot be stopped.
   */
  stop(
    caller: { userId: string; workspace: { id: string; slug: string } },
    id: string,
  ): Promise<BackgroundItem | null>;
}

type SourceFactory = (app: FastifyInstance) => BackgroundSource | null;
const factories: SourceFactory[] = [];

/** Registered once per process by the composition root (`modules/index.ts`). */
export function registerBackgroundSource(factory: SourceFactory): void {
  factories.push(factory);
}

export function backgroundSourcesFor(app: FastifyInstance): BackgroundSource[] {
  return factories
    .map((factory) => factory(app))
    .filter((source): source is BackgroundSource => !!source);
}

/** How far back "Finished" reaches, and how many it shows. */
export const FINISHED_WINDOW_MS = 24 * 60 * 60_000;
export const FINISHED_LIMIT = 50;

const RUNNING: ReadonlySet<BackgroundStatus> = new Set(['queued', 'running']);

/**
 * One list out of every source's items: running first, oldest first (a queued one, not started
 * yet, after the ones that are); then finished, newest first, at most `FINISHED_LIMIT`.
 */
export function mergeBackground(items: readonly BackgroundItem[]): {
  running: BackgroundItem[];
  finished: BackgroundItem[];
} {
  const seen = new Set<string>();
  const unique = items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  const running = unique
    .filter((item) => RUNNING.has(item.status))
    .sort(
      (a, b) =>
        (a.started_at === null ? 1 : 0) - (b.started_at === null ? 1 : 0) ||
        (a.started_at ?? '').localeCompare(b.started_at ?? '') ||
        a.id.localeCompare(b.id),
    );
  const finished = unique
    .filter((item) => !RUNNING.has(item.status))
    .sort(
      (a, b) =>
        (b.finished_at ?? '').localeCompare(a.finished_at ?? '') || b.id.localeCompare(a.id),
    )
    .slice(0, FINISHED_LIMIT);
  return { running, finished };
}

/**
 * Jobs a person can stop from the panel: the ones whose work stops when asked
 * (`JobHandle.cancelRequested`). A run's own job is shown as the run, never as a job.
 */
const STOPPABLE_JOBS: ReadonlySet<string> = new Set([
  'export',
  'import',
  'discover',
  'channel_login',
]);
/** Jobs that are the bookkeeping of something the panel shows as itself. */
const SHOWN_AS_THEMSELVES: ReadonlySet<string> = new Set(['sessions.run', 'tasks.run']);

const iso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

function jobStatus(row: JobRow): BackgroundStatus {
  return row.status === 'cancelling' ? 'running' : (row.status as BackgroundStatus);
}

/** A job row as a Background item, or `null` for one shown as something else. */
export function jobItem(row: JobRow, profile: string): BackgroundItem | null {
  if (SHOWN_AS_THEMSELVES.has(row.kind)) return null;
  const verb = row.kind.slice(row.kind.indexOf('.') + 1);
  const status = jobStatus(row);
  return {
    id: `job:${row.id}`,
    kind: 'job',
    job_kind: verb,
    title: row.progressMessage?.trim() || verb,
    profile,
    status,
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
    stoppable: RUNNING.has(status) && row.status !== 'cancelling' && STOPPABLE_JOBS.has(verb),
    session_id: null,
    resource: row.entityKind && row.entityId ? { kind: row.entityKind, id: row.entityId } : null,
  };
}
