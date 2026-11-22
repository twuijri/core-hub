/**
 * The questions the harness's own agent hands to the hub's agent (`corehub_ask_agent`), each
 * followed to its end whatever the harness does meanwhile (ADR 0033 §6).
 *
 * Why it exists: Hermes often needs minutes (tens of tool steps). Under PTC a tool call lives
 * inside a `run_code` program whose default timeout is two minutes; a call that blocked until
 * the answer was cut off, the model asked again, and the hub got two messages and did the work
 * twice while the first answer was lost. So:
 *
 * - **Followed apart from the call.** A question is sent once, then followed by its own loop
 *   that no harness abort stops; its answer is kept until it reaches the harness's agent.
 * - **One question at a time per harness session.** While one runs, a new call does not post
 *   another message: it attaches to the running one (unless `forceNew`). An answer the agent
 *   never received (its call was cut off) is handed to the next call instead of asking again.
 * - **Delivered by the harness when it can.** Where the harness offers background jobs
 *   (`ctx.jobs`), the question becomes a job owned by the session: the call returns at once if
 *   the answer is slow, and the harness delivers the answer as the job's completion notice
 *   (dsh-tool-jobs), readable with `job_output`. Without jobs, the call waits a bounded time and
 *   the answer is collected with `corehub_agent_result`.
 */
import type { AskResult, FollowOptions, RunTarget, StartResult } from './hermes.js';
import type { JobRegistry } from './host.js';

/** The part of {@link import('./hermes.js').AgentBridge} the tracker uses. */
export interface AskBridge {
  start(
    harnessSession: string,
    text: string,
    options: { fromHarnessAgent?: boolean },
  ): Promise<StartResult>;
  follow(target: RunTarget, options: FollowOptions): Promise<AskResult>;
}

export type AskPhase = 'starting' | 'queued' | 'running' | 'waiting' | 'done';

export interface AskEntry {
  readonly harnessSession: string;
  readonly question: string;
  readonly startedAt: number;
  target: RunTarget | null;
  phase: AskPhase;
  /** The end of the run, once it ended. */
  result: AskResult | null;
  /** Whether the answer reached the harness's agent (a tool result, or the job's notice). */
  delivered: boolean;
  /** The harness job that carries the answer, when the harness gave one. */
  jobId: string | null;
  readonly settled: Promise<AskResult>;
}

export interface AskReply {
  /** `answered`: `result` is the end of the run (answered, failed, or given up following). */
  state: 'answered' | 'running' | 'failed';
  entry: AskEntry;
  /** The reply is about an earlier question of this session; no new message was sent. */
  earlier: boolean;
}

export interface AskCall {
  /** Send a new message even while another question of this session runs. */
  forceNew?: boolean;
  /** How long the call itself waits for the answer before answering `running`. */
  waitMs: number;
  /** The same when the question became a harness job (its answer then arrives by itself). */
  jobWaitMs?: number;
  signal?: AbortSignal;
  /** The tool call that asked, for the job's lifecycle record. */
  toolCall?: { callId: string; rootCallId: string };
}

export interface AskRunsOptions {
  bridge: AskBridge;
  /** The harness's job registry, when the composition has one. */
  jobs?: () => JobRegistry | null;
  /** The job kind (its ids read `<kind>-…`). */
  jobKind: string;
  /** How long a question is followed before giving up (the run keeps going on the hub). */
  followTimeoutMs?: number;
  /** Following retries after a failed poll (a network blip), with this pause. */
  retries?: number;
  retryPauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: { warn(...args: unknown[]): void };
  /** How many questions are remembered. */
  keep?: number;
}

/** A harness call with no agent behind it: no session to own a job or attach to. */
export const NO_SESSION = 'no-session';

const LIVE_JOB = new Set(['running', 'stopping']);
const SETTLED_JOB = new Set(['completed', 'killed', 'failed']);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for a promise at most `ms`, or until the signal aborts. */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<{ done: true; value: T } | { done: false }> {
  if (signal?.aborted) return { done: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    onAbort = () => resolve({ done: false });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then((value) => ({ done: true as const, value })), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** The line a running job shows (`job_list`, the harness's job card). */
export function progressLine(phase: AskPhase): string {
  switch (phase) {
    case 'starting':
      return 'sending to the hub';
    case 'queued':
      return 'queued on the hub';
    case 'waiting':
      return 'waiting for an approval in Core Hub';
    default:
      return 'the hub’s agent is working';
  }
}

export class AskRuns {
  private readonly entries: AskEntry[] = [];

  constructor(private readonly options: AskRunsOptions) {}

  /** The latest question of a harness session, if any. */
  current(harnessSession: string): AskEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i -= 1)
      if (this.entries[i]!.harnessSession === harnessSession) return this.entries[i]!;
    return null;
  }

  /** A question by its hub run id or its harness job id. */
  find(id: string): AskEntry | null {
    const wanted = id.trim();
    return this.entries.find((e) => e.target?.run_id === wanted || e.jobId === wanted) ?? null;
  }

  /**
   * Asks the hub's agent, or attaches to this session's question that is still running (or
   * whose answer never reached the agent) instead of sending another message.
   */
  async ask(harnessSession: string, question: string, call: AskCall): Promise<AskReply> {
    const current = call.forceNew ? null : this.current(harnessSession);
    if (current && harnessSession !== NO_SESSION) {
      if (current.phase !== 'done') {
        // The harness delivers a live job's answer itself: say so and return at once.
        if (this.jobLive(current)) return { state: 'running', entry: current, earlier: true };
        return this.collect(current, call.waitMs, call.signal, true);
      }
      if (!current.delivered) return this.deliver(current, true);
    }
    return this.begin(harnessSession, question, call);
  }

  /** The answer of a question left running (`corehub_agent_result`), waiting at most `waitMs`. */
  async result(id: string, waitMs: number, signal?: AbortSignal): Promise<AskReply | null> {
    const entry = this.find(id);
    if (!entry) return null;
    return this.collect(entry, waitMs, signal, false);
  }

  private async begin(harnessSession: string, question: string, call: AskCall): Promise<AskReply> {
    let settle!: (result: AskResult) => void;
    const settled = new Promise<AskResult>((resolve) => (settle = resolve));
    const entry: AskEntry = {
      harnessSession,
      question,
      startedAt: (this.options.now ?? Date.now)(),
      target: null,
      phase: 'starting',
      result: null,
      delivered: false,
      jobId: null,
      settled,
    };
    this.entries.push(entry);
    this.prune();
    const finish = (result: AskResult) => {
      if (entry.phase === 'done') return;
      entry.result = result;
      entry.phase = 'done';
      settle(result);
    };

    let started: StartResult;
    try {
      started = await this.options.bridge.start(harnessSession, question, {
        fromHarnessAgent: true,
      });
    } catch (error) {
      started = {
        ok: false,
        result: { state: 'failed', message: errorText(error), session_id: null, run_id: null },
      };
    }
    if (!started.ok) {
      finish(started.result);
      entry.delivered = true;
      return { state: 'failed', entry, earlier: false };
    }
    entry.target = started.target;
    entry.phase = 'queued';

    // The job first, so its progress line follows the run from the first poll.
    const job: { progress: ((line: string) => void) | null } = { progress: null };
    const jobs = harnessSession === NO_SESSION ? null : (this.options.jobs?.() ?? null);
    if (jobs) {
      try {
        entry.jobId = jobs.start({
          kind: this.options.jobKind,
          label: `Core Hub agent: ${question.replace(/\s+/g, ' ').trim()}`.slice(0, 120),
          owner: harnessSession,
          ...(call.toolCall ? { toolCall: call.toolCall } : {}),
          run: (handle) => {
            job.progress = (line) => handle.updateProgress(line);
            handle.updateProgress(progressLine(entry.phase));
            let stop!: (outcome: { status: 'killed'; detail: string }) => void;
            const stopped = new Promise<{ status: 'killed'; detail: string }>(
              (resolve) => (stop = resolve),
            );
            return {
              // Stops the job, not the hub's run: Hermes finishes, the answer stays in the
              // hub conversation, and `corehub_agent_result` can still collect it.
              cancel: (reason) =>
                stop({
                  status: 'killed',
                  detail: `${reason ? `${reason}; ` : ''}the hub’s agent keeps working and its answer stays in the Core Hub conversation`,
                }),
              done: Promise.race([settled.then(jobOutcome), stopped]),
            };
          },
        });
        // From here the harness delivers the answer (the job's notice or `job_output`).
        entry.delivered = true;
      } catch (error) {
        this.options.log?.warn('background job not available; waiting in the call', error);
        entry.jobId = null;
      }
    }

    void this.followToEnd(entry.target, (phase) => {
      entry.phase = phase;
      job.progress?.(progressLine(phase));
    }).then(finish);

    if (entry.jobId && jobs) {
      const ended = await this.waitJob(jobs, entry, call.jobWaitMs ?? call.waitMs, call.signal);
      if (!ended) return { state: 'running', entry, earlier: false };
      // Collected by our own wait (so the harness sends no notice) and never handed out.
      try {
        jobs.remove(entry.jobId, harnessSession);
      } catch {
        // Already gone.
      }
      return this.deliver(entry, false);
    }
    return this.collect(entry, call.waitMs, call.signal, false);
  }

  /** Follows a run to its end, retrying after a failed poll; never throws. */
  private async followToEnd(
    target: RunTarget,
    onPhase: (phase: AskPhase) => void,
  ): Promise<AskResult> {
    const retries = this.options.retries ?? 5;
    const sleep = this.options.sleep ?? defaultSleep;
    const deadline =
      (this.options.now ?? Date.now)() + (this.options.followTimeoutMs ?? 30 * 60_000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.options.bridge.follow(target, {
          timeoutMs: Math.max(0, deadline - (this.options.now ?? Date.now)()),
          stopOnWaiting: false,
          onStatus: (status) =>
            onPhase(status === 'queued' ? 'queued' : status === 'waiting' ? 'waiting' : 'running'),
        });
      } catch (error) {
        if (attempt >= retries)
          return {
            state: 'failed',
            message: errorText(error),
            session_id: target.session_id,
            run_id: target.run_id,
          };
        this.options.log?.warn('following the hub run failed; retrying', error);
        await sleep(this.options.retryPauseMs ?? 3000);
      }
    }
  }

  private async collect(
    entry: AskEntry,
    waitMs: number,
    signal: AbortSignal | undefined,
    earlier: boolean,
  ): Promise<AskReply> {
    if (entry.phase === 'done') return this.deliver(entry, earlier);
    const jobs = this.options.jobs?.() ?? null;
    if (jobs && this.jobLive(entry)) {
      // Waiting on the job itself marks its settlement collected, so no notice repeats it.
      const ended = await this.waitJob(jobs, entry, waitMs, signal);
      return ended ? this.deliver(entry, earlier) : { state: 'running', entry, earlier };
    }
    const waited = await within(entry.settled, waitMs, signal);
    return waited.done ? this.deliver(entry, earlier) : { state: 'running', entry, earlier };
  }

  private deliver(entry: AskEntry, earlier: boolean): AskReply {
    entry.delivered = true;
    return {
      state: entry.result?.state === 'answered' ? 'answered' : 'failed',
      entry,
      earlier,
    };
  }

  /** Waits for the question's job; true when it settled (and the run ended) in time. */
  private async waitJob(
    jobs: JobRegistry,
    entry: AskEntry,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (!entry.jobId || waitMs <= 0 || signal?.aborted) return entry.phase === 'done';
    try {
      const view = await jobs.wait(entry.jobId, waitMs, entry.harnessSession, signal);
      return SETTLED_JOB.has(view.status) && entry.phase === 'done';
    } catch {
      // The call was aborted (the job lives on) or the job is gone.
      return entry.phase === 'done';
    }
  }

  private jobLive(entry: AskEntry): boolean {
    const jobs = this.options.jobs?.() ?? null;
    if (!jobs || !entry.jobId) return false;
    try {
      return LIVE_JOB.has(jobs.get(entry.jobId, entry.harnessSession).status);
    } catch {
      return false;
    }
  }

  /** Forgets the oldest finished questions beyond `keep`. */
  private prune(): void {
    const keep = this.options.keep ?? 50;
    while (this.entries.length > keep) {
      const index = this.entries.findIndex((e) => e.phase === 'done');
      if (index < 0) return;
      this.entries.splice(index, 1);
    }
  }
}

/** What the job reports when the run ended. */
export function jobOutcome(result: AskResult): {
  status: 'completed' | 'failed';
  detail?: string;
  result?: string;
} {
  switch (result.state) {
    case 'answered':
      return { status: 'completed', result: result.text || '(The agent answered without text.)' };
    case 'timeout':
      return {
        status: 'failed',
        detail:
          'the hub’s agent is still working after the plugin stopped following it; its answer will be in the Core Hub conversation',
      };
    case 'waiting':
      return { status: 'failed', detail: 'waiting for an approval in Core Hub' };
    case 'failed':
      return { status: 'failed', detail: `the hub’s agent could not answer: ${result.message}` };
  }
}
