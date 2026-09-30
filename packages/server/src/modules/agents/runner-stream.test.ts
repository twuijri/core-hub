/**
 * One agent process serves every turn of a conversation, and each turn reads the session's one
 * event queue until its own end. A turn the runner ended itself — the agent refused the prompt
 * (`send()` rejected: an ACP error such as Claude Code's "API Error: 429") — must stop reading:
 * a reader left waiting took every other event of the next turn (owner, 2026-09-30: «هلا! كيف
 * أقدر أساعد؟» arrived as «لا كيفقدرساعد؟», and the turn never ended because its `run.completed`
 * went to the stale reader).
 */
import { describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import type { AdapterSet } from './adapters/index.js';
import { EventQueue } from './adapters/event-queue.js';
import type { AgentSession } from './adapters/types.js';
import type { RunnerEvent } from './index.js';
import { AgentRunner } from './runner.js';
import type { AgentsService } from './service.js';

const TOKENS = ['ه', 'لا', '!', ' كيف', ' أ', 'قدر', ' أ', 'ساعد', '؟'];

function setup(script: ((queue: EventQueue) => Promise<{ stopReason: string }>)[]) {
  let turn = 0;
  const queue = new EventQueue();
  const adapter = {
    async start(): Promise<AgentSession> {
      const session: AgentSession & { closed: boolean } = {
        id: 'session-1',
        closed: false,
        send: () => script[turn++]!(queue),
        stream: () => queue.iterator(),
        discardStale: () => void queue.discardBuffered(),
        async respond() {},
        async interrupt() {},
        async close() {
          session.closed = true;
          queue.end();
        },
      };
      return session;
    },
  };
  const service = {
    loadAgent: () => ({
      id: 'agent-1',
      slug: 'claude-code',
      installState: 'installed',
      adapterKind: 'acp',
    }),
    settled: async () => {},
    selectionFor: () => ({ model: 'coder', provider: null, providerId: 'p1' }),
    fallbacksFor: () => [],
    providerSlugOf: () => 'example',
    modelSourceFor: () => 'agent',
    targetFor: () => ({ sessionRef: null }),
  };
  const runner = new AgentRunner({
    service: service as unknown as AgentsService,
    adapters: { byKind: () => adapter } as unknown as AdapterSet,
    log: capturingLogger().logger,
  });
  const run = async (runId: string) => {
    await runner.start({
      runId,
      sessionId: 'S1',
      workspace: 'w',
      agentId: 'agent-1',
      agentSessionRef: null,
      workingDir: null,
      model: null,
      provider: null,
      reasoningEffort: null,
      userId: 'u1',
      prompt: [{ type: 'text' as const, text: 'هلا' }],
      files: null,
      allowedTools: [],
    });
    const out: RunnerEvent[] = [];
    for await (const event of runner.stream(runId)) out.push(event);
    return out;
  };
  return { runner, run, queue };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('agent runner: one reader per turn', () => {
  it('a turn after a refused prompt gets every event and ends', async () => {
    const h = setup([
      async () => {
        await tick();
        throw new Error('Internal error: API Error: 429 {"type":"error"}');
      },
      async (queue) => {
        for (const text of TOKENS) {
          await tick();
          queue.push({ type: 'message.delta', text });
        }
        queue.push({ type: 'run.completed', stopReason: 'end_turn' });
        return { stopReason: 'end_turn' };
      },
    ]);
    const first = await h.run('r1');
    expect(first.at(-1)).toMatchObject({ type: 'failed' });
    const second = await Promise.race([
      h.run('r2'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the turn never ended')), 2_000),
      ),
    ]);
    const said = second
      .filter(
        (event): event is Extract<RunnerEvent, { type: 'message_delta' }> =>
          event.type === 'message_delta',
      )
      .map((event) => event.text)
      .join('');
    expect(said).toBe(TOKENS.join(''));
    expect(second.at(-1)).toMatchObject({ type: 'completed' });
    await h.runner.closeAll();
  });

  it('drops what the agent said after a turn the hub already ended', async () => {
    const h = setup([
      async (queue) => {
        await tick();
        // The bridge answers the prompt with an error, then still says something.
        setTimeout(() => {
          queue.push({ type: 'message.delta', text: 'stale words' });
          queue.push({ type: 'run.completed', stopReason: 'end_turn' });
        }, 5);
        throw new Error('Internal error: API Error: 429');
      },
      async (queue) => {
        await tick();
        queue.push({ type: 'message.delta', text: 'fresh' });
        await tick();
        queue.push({ type: 'run.completed', stopReason: 'end_turn' });
        return { stopReason: 'end_turn' };
      },
    ]);
    await h.run('r1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await h.run('r2');
    const said = second
      .filter(
        (event): event is Extract<RunnerEvent, { type: 'message_delta' }> =>
          event.type === 'message_delta',
      )
      .map((event) => event.text)
      .join('');
    expect(said).toBe('fresh');
    await h.runner.closeAll();
  });
});

describe('EventQueue', () => {
  it('a reader that stops takes its wait off the queue', async () => {
    const queue = new EventQueue();
    const stale = queue.iterator()[Symbol.asyncIterator]();
    const waiting = stale.next();
    await stale.return?.();
    expect(await waiting).toMatchObject({ done: true });
    const reader = queue.iterator()[Symbol.asyncIterator]();
    const read: string[] = [];
    const reading = (async () => {
      for (;;) {
        const next = await reader.next();
        if (next.done || next.value.type !== 'message.delta') return;
        read.push(next.value.text);
      }
    })();
    for (const text of TOKENS) queue.push({ type: 'message.delta', text });
    queue.push({ type: 'run.completed', stopReason: 'end_turn' });
    await reading;
    expect(read.join('')).toBe(TOKENS.join(''));
  });
});
