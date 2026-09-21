/**
 * The jobs runner (invariant 4: long work returns a job id immediately and reports
 * progress as events).
 *
 * `AuditService` owns the rows and the `/rt/jobs` events; this wraps them for the common
 * case — work that is one async function. `start()` creates the row, returns it, and runs
 * the function in the background; the function gets a handle to report progress and to
 * notice a cancellation request.
 *
 * A module whose work is not a single function (a streamed run, whose events arrive over
 * a socket) drives `AuditService` directly instead.
 */
import { HubError } from '../../lib/errors.js';
import type { FastifyBaseLogger } from 'fastify';
import { t, type Language } from '../../i18n/index.js';
import type { AuditService, JobRow } from './service.js';

/** Handed to a job's worker so it can report progress and notice cancellation. */
export interface JobHandle {
  readonly id: string;
  progress(percent: number | null, message: string | null): void;
  /** True once `jobs.cancel` was called; long workers check it between steps. */
  cancelRequested(): boolean;
}

export type JobWorker = (handle: JobHandle) => Promise<Record<string, unknown> | void>;

export interface NewJob {
  workspace: string;
  ownerId: string;
  /** `<module>.<verb>`; the verb is the contract's `JobKind`. */
  kind: string;
  entityKind?: string;
  entityId?: string;
  input?: Record<string, unknown>;
  message?: string;
}

export interface JobRunnerOptions {
  audit: AuditService;
  log: FastifyBaseLogger;
  language?: Language;
}

export interface JobRunner {
  /** Creates the job, returns its row immediately and runs `work` in the background. */
  start(job: NewJob, work: JobWorker): JobRow;
  /** Asks a job to stop. Returns the row after the request, or null when unknown. */
  cancel(workspace: string, jobId: string): JobRow | null;
  /** Waits for every background worker to settle; used by tests and by shutdown. */
  drain(): Promise<void>;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { audit, log } = options;
  const language = options.language ?? 'en';
  const cancelling = new Set<string>();
  const running = new Map<string, Promise<void>>();

  return {
    start(job, work) {
      const id = audit.createJob({
        workspace: job.workspace,
        ownerId: job.ownerId,
        kind: job.kind,
        entityKind: job.entityKind ?? null,
        entityId: job.entityId ?? null,
        ...(job.input ? { input: job.input } : {}),
        message: job.message ?? t('jobs.queued', language),
      });
      const row = audit.job(id);
      if (!row) throw new HubError('internal', { message: 'job row vanished after insert' });

      const handle: JobHandle = {
        id,
        progress: (percent, message) => audit.progressJob(id, percent, message),
        cancelRequested: () => cancelling.has(id),
      };

      const task = (async () => {
        audit.startJob(id);
        try {
          const result = (await work(handle)) ?? {};
          if (cancelling.has(id)) {
            audit.finishJob(id, 'cancelled', { message: t('jobs.cancelled', language) });
          } else {
            audit.finishJob(id, 'succeeded', { result });
          }
        } catch (error) {
          const hubError =
            error instanceof HubError
              ? error
              : new HubError('internal', {
                  message: error instanceof Error ? error.message : String(error),
                });
          log.warn({ jobId: id, kind: job.kind, err: hubError.message }, 'job failed');
          audit.finishJob(id, 'failed', {
            errorCode: hubError.code,
            errorMessage: hubError.message,
            message: hubError.message,
          });
        } finally {
          cancelling.delete(id);
          running.delete(id);
        }
      })();
      running.set(id, task);
      // A rejected background task must never become an unhandled rejection.
      void task.catch((error: unknown) => log.error({ err: error }, 'job runner crashed'));
      return row;
    },

    cancel(workspace, jobId) {
      const row = audit.jobIn(workspace, jobId);
      if (!row) return null;
      cancelling.add(jobId);
      if (row.status === 'queued') {
        // Nothing has started yet: it can die now.
        audit.finishJob(jobId, 'cancelled', { message: t('jobs.cancelled', language) });
        return audit.job(jobId);
      }
      return audit.requestCancel(jobId);
    },

    async drain() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}
