import { describe, expect, it } from 'vitest';
import { AskRuns, NO_SESSION, jobOutcome, within, type AskBridge } from '../src/ask-runs.js';
import { ASK_DESCRIPTION, RESULT_DESCRIPTION, toolAnswer } from '../src/ask-tool.js';
import type { AskResult, FollowOptions } from '../src/hermes.js';
import type { JobRegistry } from '../src/host.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A hub whose runs end when the test says so. */
function fakeBridge(options: { startFails?: string } = {}) {
  const starts: Array<{ session: string; text: string; marked: boolean }> = [];
  const follows: string[] = [];
  const pending = new Map<
    string,
    { resolve(r: AskResult): void; reject(e: unknown): void; options: FollowOptions }
  >();
  let n = 0;
  const bridge: AskBridge = {
    async start(session, text, o) {
      starts.push({ session, text, marked: o.fromHarnessAgent === true });
      if (options.startFails)
        return {
          ok: false,
          result: { state: 'failed', message: options.startFails, session_id: null, run_id: null },
        };
      n += 1;
      return { ok: true, target: { session_id: 'S1', run_id: `R${n}`, profile: 'work' } };
    },
    follow(target, o) {
      follows.push(target.run_id);
      return new Promise((resolve, reject) =>
        pending.set(target.run_id, { resolve, reject, options: o }),
      );
    },
  };
  return {
    bridge,
    starts,
    follows,
    status(runId: string, status: string) {
      pending.get(runId)!.options.onStatus?.(status);
    },
    answer(runId: string, text: string) {
      pending.get(runId)!.resolve({ state: 'answered', text, session_id: 'S1', run_id: runId });
    },
    breakPoll(runId: string) {
      pending.get(runId)!.reject(new Error('socket hang up'));
    },
  };
}

/** A job registry with the documented semantics the tracker relies on (docs/subsystems/jobs.md). */
function fakeJobs(options: { refuse?: boolean } = {}) {
  interface Rec {
    owner: string | undefined;
    status: string;
    waiters: Array<() => void>;
    progress: string[];
    cancel(reason?: string): void;
    removed: boolean;
  }
  const records = new Map<string, Rec>();
  const notices: Array<{ id: string; status: string; result?: string; detail?: string }> = [];
  let n = 0;
  const view = (id: string) => ({ id, status: records.get(id)!.status });
  const registry: JobRegistry = {
    start(spec) {
      if (options.refuse) throw new Error('no job controller serves this owner');
      n += 1;
      const id = `${spec.kind}-${n.toString(16).padStart(16, '0')}`;
      const rec: Rec = {
        owner: spec.owner,
        status: 'running',
        waiters: [],
        progress: [],
        cancel: () => undefined,
        removed: false,
      };
      records.set(id, rec);
      const hooks = spec.run({ id, updateProgress: (line) => rec.progress.push(line) });
      rec.cancel = hooks.cancel;
      void hooks.done.then((outcome) => {
        rec.status = outcome.status;
        const awaited = rec.waiters.length > 0;
        for (const w of rec.waiters.splice(0)) w();
        // A settlement a live wait collected is not reported again (tool-jobs README).
        if (!awaited) notices.push({ id, ...outcome });
      });
      return id;
    },
    get(id, caller) {
      const rec = records.get(id);
      if (!rec || rec.removed || rec.owner !== caller) throw new Error('unknown job');
      return view(id);
    },
    wait(id, timeoutMs, caller, signal) {
      const rec = records.get(id);
      if (!rec || rec.owner !== caller) return Promise.reject(new Error('unknown job'));
      if (rec.status !== 'running') return Promise.resolve(view(id));
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          resolve(view(id));
        };
        const timer = setTimeout(() => {
          rec.waiters.splice(rec.waiters.indexOf(done), 1);
          resolve(view(id));
        }, timeoutMs);
        rec.waiters.push(done);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          rec.waiters.splice(rec.waiters.indexOf(done), 1);
          reject(new Error('aborted'));
        });
      });
    },
    remove(id, caller) {
      const rec = records.get(id);
      if (!rec || rec.owner !== caller || rec.status === 'running') throw new Error('live');
      rec.removed = true;
    },
  };
  return { registry, records, notices };
}

function tracker(bridge: AskBridge, jobs: JobRegistry | null = null) {
  return new AskRuns({
    bridge,
    jobs: () => jobs,
    jobKind: 'corehub',
    retryPauseMs: 1,
    sleep: async () => undefined,
  });
}

describe('AskRuns without background jobs', () => {
  it('waits a bounded time, then answers running with the run id; a re-ask attaches instead of posting', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    const first = await asks.ask('H1', 'Summarise my week from the hub memory', { waitMs: 20 });
    expect(first.state).toBe('running');
    expect(first.entry.target?.run_id).toBe('R1');
    expect(hub.starts).toEqual([
      { session: 'H1', text: 'Summarise my week from the hub memory', marked: true },
    ]);

    // The model asks a shorter version while the first one runs: nothing is posted.
    setTimeout(() => hub.answer('R1', 'Your week: …'), 5);
    const again = await asks.ask('H1', 'Summarise my week', { waitMs: 1000 });
    expect(hub.starts).toHaveLength(1);
    expect(again).toMatchObject({ state: 'answered', earlier: true });
    expect(again.entry.result).toMatchObject({ state: 'answered', text: 'Your week: …' });
    expect(toolAnswer(again, 'ask').answer).toContain('no new message was sent');

    // Once delivered, a new question is a new message.
    const next = await asks.ask('H1', 'And next week?', { waitMs: 1 });
    expect(hub.starts).toHaveLength(2);
    expect(next.earlier).toBe(false);
  });

  it('keeps following when the harness aborts the call, and hands the lost answer to the next call', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    const abort = new AbortController();
    const pending = asks.ask('H1', 'Long question', { waitMs: 60_000, signal: abort.signal });
    await tick(5);
    abort.abort(new Error('run_code timed out'));
    expect((await pending).state).toBe('running');

    hub.answer('R1', 'The long answer');
    await tick();
    const retry = await asks.ask('H1', 'Long question, shorter', { waitMs: 10 });
    expect(hub.starts).toHaveLength(1);
    expect(retry).toMatchObject({ state: 'answered', earlier: true });
    expect(toolAnswer(retry, 'ask').answer).toContain('The long answer');
    expect(toolAnswer(retry, 'ask').answer).toContain('force_new: true');
  });

  it('sends a new message with force_new even while one runs', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    await asks.ask('H1', 'one', { waitMs: 1 });
    await asks.ask('H1', 'two', { waitMs: 1, forceNew: true });
    expect(hub.starts.map((s) => s.text)).toEqual(['one', 'two']);
  });

  it('keeps sessions apart, and never attaches calls without a session', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    await asks.ask('H1', 'one', { waitMs: 1 });
    await asks.ask('H2', 'two', { waitMs: 1 });
    await asks.ask(NO_SESSION, 'three', { waitMs: 1 });
    await asks.ask(NO_SESSION, 'four', { waitMs: 1 });
    expect(hub.starts).toHaveLength(4);
  });

  it('collects a left-running answer by run id, and says when the id is unknown', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    await asks.ask('H1', 'q', { waitMs: 1 });
    expect((await asks.result('R1', 5))?.state).toBe('running');
    setTimeout(() => hub.answer('R1', 'done'), 5);
    const got = await asks.result('R1', 1000);
    expect(got).toMatchObject({ state: 'answered', earlier: false });
    expect(toolAnswer(got!, 'result')).toMatchObject({ ok: true, answer: 'done', run_id: 'R1' });
    expect(await asks.result('R404', 1)).toBeNull();
  });

  it('retries following after a failed poll', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    await asks.ask('H1', 'q', { waitMs: 1 });
    hub.breakPoll('R1');
    await tick();
    expect(hub.follows).toEqual(['R1', 'R1']);
    hub.answer('R1', 'after the blip');
    expect(await asks.result('R1', 100)).toMatchObject({ state: 'answered' });
  });

  it('reports a question that could not be sent', async () => {
    const asks = tracker(fakeBridge({ startFails: 'not_linked' }).bridge);
    const reply = await asks.ask('H1', 'q', { waitMs: 1 });
    expect(reply.state).toBe('failed');
    expect(toolAnswer(reply, 'ask').answer).toContain('link');
  });

  it('tells the model to collect with corehub_agent_result, and shows an approval wait', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge);
    const reply = await asks.ask('H1', 'q', { waitMs: 1 });
    hub.status('R1', 'waiting');
    const text = toolAnswer(reply, 'ask');
    expect(text).toMatchObject({ ok: true, state: 'running', run_id: 'R1' });
    expect(text.answer).toContain('corehub_agent_result({ run_id: "R1" })');
    expect(text.answer).toContain('approval');
    expect(text.answer).toContain('Do not ask again');
  });
});

describe('AskRuns with the harness background jobs', () => {
  it('returns at once with a job id when the answer is slow; the job’s notice carries the answer', async () => {
    const hub = fakeBridge();
    const jobs = fakeJobs();
    const asks = tracker(hub.bridge, jobs.registry);
    const reply = await asks.ask('H1', 'slow question', {
      waitMs: 60_000,
      jobWaitMs: 10,
      toolCall: { callId: 'c1', rootCallId: 'c0' },
    });
    expect(reply.state).toBe('running');
    const jobId = reply.entry.jobId!;
    expect(jobId).toMatch(/^corehub-/);
    expect(toolAnswer(reply, 'ask').answer).toContain(`job_output({ job_id: "${jobId}"`);

    // While the job lives, a re-ask attaches at once and posts nothing.
    const again = await asks.ask('H1', 'slow q', { waitMs: 60_000, jobWaitMs: 60_000 });
    expect(again).toMatchObject({ state: 'running', earlier: true });
    expect(hub.starts).toHaveLength(1);

    hub.status('R1', 'running');
    hub.answer('R1', 'the slow answer');
    await tick();
    expect(jobs.notices).toEqual([{ id: jobId, status: 'completed', result: 'the slow answer' }]);
    expect(jobs.records.get(jobId)!.progress).toContain('the hub’s agent is working');
    // Delivered by the harness: the next question is a new message.
    await asks.ask('H1', 'next', { waitMs: 1, jobWaitMs: 1 });
    expect(hub.starts).toHaveLength(2);
  });

  it('answers in the call when the answer comes in time, with no notice and no job left', async () => {
    const hub = fakeBridge();
    const jobs = fakeJobs();
    const asks = tracker(hub.bridge, jobs.registry);
    setTimeout(() => hub.answer('R1', 'quick'), 5);
    const reply = await asks.ask('H1', 'quick question', { waitMs: 60_000, jobWaitMs: 1000 });
    expect(reply.state).toBe('answered');
    expect(toolAnswer(reply, 'ask').answer).toBe('quick');
    await tick();
    expect(jobs.notices).toEqual([]);
    expect(jobs.records.get(reply.entry.jobId!)!.removed).toBe(true);
  });

  it('a harness abort leaves the job running; its notice still comes', async () => {
    const hub = fakeBridge();
    const jobs = fakeJobs();
    const asks = tracker(hub.bridge, jobs.registry);
    const abort = new AbortController();
    const pending = asks.ask('H1', 'q', {
      waitMs: 60_000,
      jobWaitMs: 60_000,
      signal: abort.signal,
    });
    await tick(5);
    abort.abort();
    expect((await pending).state).toBe('running');
    hub.answer('R1', 'still delivered');
    await tick();
    expect(jobs.notices).toHaveLength(1);
  });

  it('falls back to waiting in the call when the harness refuses the job', async () => {
    const hub = fakeBridge();
    const asks = tracker(hub.bridge, fakeJobs({ refuse: true }).registry);
    const reply = await asks.ask('H1', 'q', { waitMs: 5, jobWaitMs: 60_000 });
    expect(reply.state).toBe('running');
    expect(reply.entry.jobId).toBeNull();
    expect(toolAnswer(reply, 'ask').answer).toContain('corehub_agent_result');
  });

  it('a killed job stops the job only: the hub run is still followed and collectable', async () => {
    const hub = fakeBridge();
    const jobs = fakeJobs();
    const asks = tracker(hub.bridge, jobs.registry);
    const reply = await asks.ask('H1', 'q', { waitMs: 1, jobWaitMs: 1 });
    const jobId = reply.entry.jobId!;
    jobs.records.get(jobId)!.cancel('cancelled by the user');
    await tick();
    expect(jobs.notices[0]).toMatchObject({ id: jobId, status: 'killed' });
    expect(jobs.notices[0]!.detail).toContain('keeps working');
    setTimeout(() => hub.answer('R1', 'after the kill'), 5);
    expect(await asks.result(jobId, 1000)).toMatchObject({ state: 'answered' });
  });

  it('collecting a live job’s answer by its id suppresses the repeated notice', async () => {
    const hub = fakeBridge();
    const jobs = fakeJobs();
    const asks = tracker(hub.bridge, jobs.registry);
    const reply = await asks.ask('H1', 'q', { waitMs: 1, jobWaitMs: 1 });
    setTimeout(() => hub.answer('R1', 'by id'), 5);
    expect(await asks.result(reply.entry.jobId!, 1000)).toMatchObject({ state: 'answered' });
    await tick();
    expect(jobs.notices).toEqual([]);
  });
});

describe('helpers', () => {
  it('within: settles, times out, or stops on abort', async () => {
    expect(await within(Promise.resolve(1), 10)).toEqual({ done: true, value: 1 });
    expect(await within(new Promise(() => undefined), 1)).toEqual({ done: false });
    const abort = new AbortController();
    abort.abort();
    expect(await within(new Promise(() => undefined), 10_000, abort.signal)).toEqual({
      done: false,
    });
  });

  it('job outcomes', () => {
    expect(jobOutcome({ state: 'answered', text: '', session_id: 'S', run_id: 'R' })).toEqual({
      status: 'completed',
      result: '(The agent answered without text.)',
    });
    expect(
      jobOutcome({ state: 'failed', message: 'boom', session_id: null, run_id: null }),
    ).toMatchObject({ status: 'failed', detail: expect.stringContaining('boom') });
    expect(jobOutcome({ state: 'timeout', session_id: 'S', run_id: 'R' }).status).toBe('failed');
  });

  it('the descriptions tell the model not to re-ask and how to wait longer', () => {
    expect(ASK_DESCRIPTION).toContain('Never ask a question again');
    expect(ASK_DESCRIPTION).toContain('job_output');
    expect(ASK_DESCRIPTION).toContain('corehub_agent_result');
    expect(ASK_DESCRIPTION).toContain('600000');
    expect(RESULT_DESCRIPTION).toContain('never ask the question again');
  });
});
