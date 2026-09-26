/**
 * The worker: what makes assigning a task **start** it.
 *
 * A task that is started gets a session of its own (source `task`, its origin the task),
 * one run in it whose prompt is the task itself, and a follow-up that moves the card when
 * the run ends — `review` with the agent's last words, `blocked` with the reason it
 * failed, `ready` when a person stopped it from the chat. The board then shows what is
 * really happening, not what somebody hoped would happen.
 *
 * The run itself belongs to `sessions`; this file never touches its tables. It asks
 * through `TaskRunPort`, which the composition root fills (`modules/index.ts`), the way
 * workflows reach an agent turn. With no port — a hub that composes no sessions — a start
 * is refused by name, never faked.
 *
 * Three rules this file keeps:
 *
 * - **The ids are real, and they are answered at once.** The route answers `202` with the
 *   job, the run and the session the moment the run is queued; the ending comes later.
 * - **Only the run a task is on may move it.** Stop, unassign and reassign move the task
 *   themselves and forget the run first; when that run's ending arrives it finds the task
 *   on another run (or on none) and leaves it alone.
 * - **Nothing is left `running` by a restart.** The follow-up lives in this process; a
 *   hub that restarts settles, at boot, every task it finds `running` — by what the run's
 *   record says if it ended, and to `blocked` with the reason if it did not.
 *
 * Since stage 2 a task of a project with a repository runs in its own git worktree (the
 * session is opened with the worktree as its folder), and a task with `auto_start` starts
 * on its own — at most `COREHUB_TASK_AUTO_START_MAX` of those at once per profile, which
 * this class counts (`autoRunning`). Still not here: reporting into a room.
 */
import { PRODUCT } from '@corehub/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleDb } from '../../lib/db.js';
import { TasksService, type Actor, type Scope, type TaskStatus } from './service.js';
import type { SubtaskRow, TaskRow } from './serialize.js';

/** Who a run acts as: the person who started it, in their language. */
export interface TaskRunScope extends Scope {
  userName: string;
  language: 'ar' | 'en';
}

/** How a run stands, as `sessions` reports it. */
export interface TaskRunOutcome {
  sessionId: string;
  runId: string;
  status: string;
  output: string;
  error: string | null;
  /** `stale` for a run a restart cut short. */
  errorCode?: string | null;
}

/** What `tasks` needs from `sessions`. Filled in `modules/index.ts`. */
export interface TaskRunPort {
  /** Open the task's session and queue its run; resolves once both exist. */
  start(
    scope: TaskRunScope,
    input: {
      taskId: string;
      agentId: string;
      prompt: string;
      title: string;
      model: string | null;
      provider: string | null;
      /** The task's git worktree, when its project has a repository. */
      workingDir: string | null;
    },
  ): Promise<{
    sessionId: string;
    runId: string;
    jobId: string;
    /** Resolves when the run is terminal; never rejects. */
    done: Promise<TaskRunOutcome>;
  }>;
  /** Stop a run; one that already ended is not an error. */
  cancel(scope: TaskRunScope, sessionId: string, runId: string): Promise<void>;
  /** A run by id, for settling after a restart. `null` when there is no such run. */
  outcome(workspace: string, runId: string): TaskRunOutcome | null;
}

/** How long the progress summary may be: a card and a details pane, not a transcript. */
export const SUMMARY_MAX = 600;

const WORDS = {
  ar: {
    checklist: 'قائمة التحقق',
    instructions: 'تعليمات',
    finish:
      'نفّذ المهمة. وحين تنتهي اختم بملخص قصير لما فعلته وما بقي، فهذا ما يظهر على بطاقة المهمة.',
    failed: 'فشل التشغيل',
    stopped: 'أُوقف التشغيل من المحادثة',
    restarted: 'أُعيد تشغيل المركز أثناء تنفيذ المهمة، فلم يكتمل تشغيلها',
  },
  en: {
    checklist: 'Checklist',
    instructions: 'Instructions',
    finish:
      'Do the task. When you finish, end with a short summary of what you did and what is left — it is what the task card shows.',
    failed: 'The run failed',
    stopped: 'The run was stopped from the chat',
    restarted: 'The hub restarted while this task was running, so its run did not finish',
  },
} as const;

/**
 * The prompt a task's run starts with: the task itself, as the agent needs it — title,
 * brief, the checklist with what is already ticked, and whatever the person added when
 * they assigned it.
 */
export function taskPrompt(input: {
  key: string;
  task: Pick<TaskRow, 'number' | 'title' | 'description'>;
  subtasks: readonly Pick<SubtaskRow, 'title' | 'status'>[];
  instructions: string | null;
  language: 'ar' | 'en';
}): string {
  const words = WORDS[input.language];
  const parts = [`# ${input.key}-${input.task.number}: ${input.task.title}`];
  if (input.task.description?.trim()) parts.push(input.task.description.trim());
  if (input.subtasks.length > 0) {
    parts.push(
      `## ${words.checklist}\n` +
        input.subtasks
          .map((line) => `- [${line.status === 'done' ? 'x' : ' '}] ${line.title}`)
          .join('\n'),
    );
  }
  if (input.instructions?.trim()) {
    parts.push(`## ${words.instructions}\n${input.instructions.trim()}`);
  }
  parts.push(words.finish);
  return parts.join('\n\n');
}

/** The last words of a run, cut to a card's length on a word boundary. */
export function summaryOf(output: string): string | null {
  const text = output.trim();
  if (text === '') return null;
  if (text.length <= SUMMARY_MAX) return text;
  // The *end* of the reply: that is where the task prompt asks for the summary.
  const tail = text.slice(-SUMMARY_MAX);
  const cut = tail.search(/\s/);
  return `…${cut > 0 && cut < 80 ? tail.slice(cut + 1) : tail}`;
}

type Emit = (
  profile: string,
  event: 'task.moved',
  payload: { task: Record<string, unknown>; from: TaskStatus; to: TaskStatus; actor: unknown },
) => void;

type Render = (scope: Scope, id: string) => Record<string, unknown>;

export class TaskRuns {
  private readonly following = new Set<Promise<void>>();
  /** Runs the hub started on its own (`auto_start`): task id → run id. */
  private readonly auto = new Map<string, { workspace: string; runId: string }>();
  /** One auto-start pass at a time per workspace, so two passes never both take the last place. */
  private readonly passes = new Map<string, Promise<void>>();
  /** Called after a run's ending has moved its task (the worktree's numbers, the next start). */
  afterSettle: ((scope: TaskRunScope, taskId: string) => void) | null = null;
  /**
   * When each followed run last showed activity (ms since the epoch): set when it starts and
   * on every event of its session that names it (`noteActivity`). What the stuck-task
   * watchdog reads (DECISIONS §93). In memory on purpose: a restart ends every run and
   * settles its task, so nothing here has to outlive the process.
   */
  private readonly activity = new Map<string, number>();

  constructor(
    private readonly port: TaskRunPort | null,
    private readonly db: () => ModuleDb,
    private readonly emit: Emit,
    private readonly render: Render,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Whether this hub can start a run at all. */
  get available(): boolean {
    return this.port !== null;
  }

  /**
   * Open the task's session and queue its run. Throws what `sessions` throws — an agent
   * the hub does not know (404) or one that cannot take a turn (422) — before anything
   * about the task has changed.
   */
  async open(
    scope: TaskRunScope,
    service: TasksService,
    task: TaskRow,
    input: {
      agentId: string;
      model: string | null;
      provider: string | null;
      instructions: string | null;
      workingDir: string | null;
    },
  ) {
    if (!this.port) throw new Error('no task runner');
    const project = service.project(scope, task.projectId);
    const prompt = taskPrompt({
      key: project.key,
      task,
      subtasks: service.subtasksOf(task.id),
      instructions: input.instructions,
      language: scope.language,
    });
    return this.port.start(scope, {
      taskId: task.id,
      agentId: input.agentId,
      prompt,
      title: `${project.key}-${task.number} · ${task.title}`.slice(0, 200),
      model: input.model,
      provider: input.provider,
      workingDir: input.workingDir,
    });
  }

  /** Remember that the hub, not a person, started this run. */
  markAutoStarted(workspace: string, taskId: string, runId: string): void {
    this.auto.set(taskId, { workspace, runId });
  }

  /**
   * How many runs the hub started on its own are still going in `workspace`. Read against
   * the tasks as they are now — one that ended, was stopped or was moved no longer counts —
   * and a restart starts at zero, which is right: a restart ends every run.
   */
  autoRunning(workspace: string): number {
    const service = new TasksService(this.db());
    let count = 0;
    for (const [taskId, entry] of this.auto) {
      const row = service.many({ workspace: entry.workspace, profile: '', userId: '' }, [
        taskId,
      ])[0];
      if (!row || row.status !== 'running' || row.currentRunId !== entry.runId) {
        this.auto.delete(taskId);
        continue;
      }
      if (entry.workspace === workspace) count += 1;
    }
    return count;
  }

  /**
   * Run `pass` after any pass already going in this workspace, and follow it like a run, so
   * `settled()` waits for it too.
   */
  serially(workspace: string, pass: () => Promise<void>): Promise<void> {
    const previous = this.passes.get(workspace) ?? Promise.resolve();
    const next = previous
      .then(pass)
      .catch((error: unknown) => {
        this.log.error({ err: error, workspace }, 'tasks: starting tasks automatically failed');
      })
      .finally(() => {
        if (this.passes.get(workspace) === next) this.passes.delete(workspace);
        this.following.delete(next);
      });
    this.passes.set(workspace, next);
    this.following.add(next);
    return next;
  }

  /** A run this worker follows said something (a delta, a tool call, a step): it is alive. */
  noteActivity(runId: string, at: number = Date.now()): void {
    if (this.activity.has(runId)) this.activity.set(runId, at);
  }

  /** When a followed run last showed activity; `null` for a run this worker does not follow. */
  lastActivity(runId: string): number | null {
    return this.activity.get(runId) ?? null;
  }

  /** How a run stands, as `sessions` says (`waiting` for a person, say); `null` without one. */
  runStatus(workspace: string, runId: string): string | null {
    try {
      return this.port?.outcome(workspace, runId)?.status ?? null;
    } catch {
      return null;
    }
  }

  /** Watch a run to its end, then move the task the way the ending says. */
  follow(scope: TaskRunScope, taskId: string, runId: string, done: Promise<TaskRunOutcome>): void {
    this.activity.set(runId, Date.now());
    const followed = done
      .then((outcome) => {
        this.settle(scope, taskId, runId, outcome, scope.language);
        this.afterSettle?.(scope, taskId);
      })
      .catch((error: unknown) => {
        this.log.error({ err: error, taskId, runId }, 'tasks: settling a finished run failed');
      })
      .finally(() => {
        this.activity.delete(runId);
        this.following.delete(followed);
      });
    this.following.add(followed);
  }

  /** Stop a run a task was on. The caller has already moved the task off it. */
  async cancel(scope: TaskRunScope, sessionId: string | null, runId: string | null) {
    if (!this.port || !sessionId || !runId) return;
    await this.port.cancel(scope, sessionId, runId);
  }

  /** Test and shutdown hook: every run being followed has been settled. */
  async settled(): Promise<void> {
    while (this.following.size > 0) await Promise.all([...this.following]);
  }

  /**
   * At boot: a task still `running` was running in a process that is gone, so nobody will
   * ever move it. Settle each one by what its run's record says — the run may have ended
   * a moment before the restart — and to `blocked`, saying why, when it did not end.
   */
  settleStranded(language: 'ar' | 'en' = 'ar'): number {
    const service = new TasksService(this.db());
    let settled = 0;
    for (const row of service.runningEverywhere()) {
      let outcome: TaskRunOutcome | null = null;
      if (this.port && row.currentRunId) {
        try {
          outcome = this.port.outcome(row.workspace, row.currentRunId);
        } catch (error) {
          this.log.warn({ err: error, taskId: row.id }, 'tasks: could not read a stranded run');
        }
      }
      const ended =
        outcome && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(outcome.status)
          ? outcome
          : null;
      const scope: Scope = { workspace: row.workspace, profile: '', userId: row.ownerId };
      const runId = row.currentRunId;
      // A run that was cut short (sessions fails those with `stale`) is not the run's own
      // failure: the reason says the hub restarted, which is what a person can act on.
      const stale = ended?.status === 'failed' && ended.errorCode === 'stale';
      const words = WORDS[language];
      const result = runId
        ? service.finishRun(
            scope,
            ended?.status === 'succeeded'
              ? { kind: 'agent', id: row.assigneeAgentId }
              : { kind: 'system', id: null },
            row.id,
            runId,
            {
              status: ended && !stale ? ended.status : 'failed',
              summary: ended ? summaryOf(ended.output) : null,
              reason: ended && !stale ? reasonFor(ended, words) : words.restarted,
            },
          )
        : service.moveTask(scope, { kind: 'system', id: null }, row.id, {
            status: 'blocked',
            reason: words.restarted,
          });
      if (result) settled += 1;
    }
    return settled;
  }

  private settle(
    scope: TaskRunScope,
    taskId: string,
    runId: string,
    outcome: TaskRunOutcome,
    language: 'ar' | 'en',
  ): void {
    const service = new TasksService(this.db());
    const current = service.many(scope, [taskId])[0];
    if (!current) return; // deleted while it ran
    const actor: Actor =
      outcome.status === 'succeeded'
        ? { kind: 'agent', id: current.assigneeAgentId }
        : { kind: 'system', id: null };
    const moved = service.finishRun(scope, actor, taskId, runId, {
      status: outcome.status,
      summary: summaryOf(outcome.output),
      reason: reasonFor(outcome, WORDS[language]),
    });
    if (!moved) return;
    const task = this.render(scope, taskId);
    this.emit(scope.profile, 'task.moved', {
      task,
      from: moved.from,
      to: moved.row.status,
      actor:
        actor.kind === 'agent'
          ? {
              kind: 'agent',
              id: actor.id,
              name: (task.assignee as { name?: string } | null)?.name ?? 'agent',
              avatar: null,
            }
          : { kind: 'system', id: null, name: PRODUCT.name, avatar: null },
    });
  }
}

function reasonFor(
  outcome: TaskRunOutcome,
  words: (typeof WORDS)['ar'] | (typeof WORDS)['en'],
): string {
  if (outcome.status === 'cancelled') return words.stopped;
  const detail = outcome.error?.trim();
  return detail ? `${words.failed}: ${detail}` : words.failed;
}
