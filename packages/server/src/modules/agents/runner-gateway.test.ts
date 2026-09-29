/**
 * The runner on the model gateway (ADR 0029): a coding agent's process gets a gateway grant when
 * its model source is the hub, each turn names its model to the gateway, the gateway's usage
 * reports reach the run, and the token dies with the process — or when the person switches the
 * agent back to its own account.
 */
import { describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import type { AdapterSet } from './adapters/index.js';
import type { AgentEvent, AgentSession } from './adapters/types.js';
import type { AgentGatewayGrant, AgentGatewayTurn, RunnerEvent } from './index.js';
import { AgentRunner } from './runner.js';
import type { AgentsService } from './service.js';

interface FakeGrant extends AgentGatewayGrant {
  turns: (AgentGatewayTurn | null)[];
  revoked: boolean;
}

function fakeGrant(n: number): FakeGrant {
  const grant: FakeGrant = {
    anthropicBaseUrl: 'http://127.0.0.1:1/gateway/anthropic',
    openaiBaseUrl: 'http://127.0.0.1:1/gateway/openai/v1',
    origin: 'http://127.0.0.1:1',
    token: `chgw_token_${n}`,
    turns: [],
    revoked: false,
    setTurn(turn) {
      grant.turns.push(turn);
    },
    revoke() {
      grant.revoked = true;
    },
  };
  return grant;
}

function setup(options: { source: () => 'hub' | 'agent' | null; failGateway?: boolean }) {
  const grants: FakeGrant[] = [];
  const targets: { gateway: AgentGatewayGrant | null | undefined }[] = [];
  const closed: string[] = [];
  let sessions = 0;
  const adapter = {
    async start(): Promise<AgentSession> {
      sessions += 1;
      const id = `session-${sessions}`;
      const grant = grants.at(-1);
      let finish: (() => void) | null = null;
      const session: AgentSession & { closed: boolean } = {
        id,
        closed: false,
        async send() {
          // The agent calls its model twice during the turn; the gateway reports each time.
          const turn = grant?.turns.at(-1);
          turn?.report({
            modelLabel: 'Coder',
            providerId: 'p1',
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costMicroUsd: 5,
            costSource: 'estimated',
          });
          turn?.report({
            modelLabel: 'Coder',
            providerId: 'p1',
            inputTokens: 25,
            outputTokens: 6,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costMicroUsd: 12,
            costSource: 'estimated',
          });
          finish?.();
          return { stopReason: 'end_turn' };
        },
        async *stream(): AsyncIterable<AgentEvent> {
          await new Promise<void>((resolve) => (finish = resolve));
          yield { type: 'run.completed', stopReason: 'end_turn' };
        },
        async respond() {},
        async interrupt() {},
        async close() {
          session.closed = true;
          closed.push(id);
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
    modelSourceFor: () => options.source(),
    openGateway: async () => {
      if (options.failGateway) throw new Error('no CLIProxyAPI');
      const grant = fakeGrant(grants.length + 1);
      grants.push(grant);
      return grant;
    },
    targetFor: (
      _row: unknown,
      _workspace: unknown,
      input: { gateway?: AgentGatewayGrant | null },
    ) => {
      targets.push({ gateway: input.gateway });
      return { sessionRef: null };
    },
  };
  const log = capturingLogger();
  const runner = new AgentRunner({
    service: service as unknown as AgentsService,
    adapters: { byKind: () => adapter } as unknown as AdapterSet,
    log: log.logger,
  });
  const request = (runId: string) => ({
    runId,
    sessionId: 'S1',
    workspace: 'w',
    agentId: 'agent-1',
    agentSessionRef: null,
    workingDir: null,
    model: 'example/coder',
    provider: null,
    reasoningEffort: null,
    userId: 'u1',
    prompt: [{ type: 'text' as const, text: 'hi' }],
    files: null,
    allowedTools: [],
  });
  const turn = async (runId: string) => {
    await runner.start(request(runId));
    const out: RunnerEvent[] = [];
    for await (const event of runner.stream(runId)) out.push(event);
    return out;
  };
  return { runner, grants, targets, closed, turn, log };
}

describe('agent runner: the model gateway (ADR 0029)', () => {
  it('starts the agent with a grant, names each turn’s model to it, and passes its usage to the run', async () => {
    const h = setup({ source: () => 'hub' });
    const events = await h.turn('r1');
    expect(h.targets[0]!.gateway).toBe(h.grants[0]);
    expect(h.grants[0]!.turns[0]).toMatchObject({ runId: 'r1', providerId: 'p1', model: 'coder' });
    // Cleared when the turn ends: a later call is the gateway's to add to the run by itself.
    expect(h.grants[0]!.turns.at(-1)).toBeNull();
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage).toEqual([
      expect.objectContaining({
        modelLabel: 'Coder',
        providerId: 'p1',
        inputTokens: 10,
        outputTokens: 2,
        costMicroUsd: 5,
        costSource: 'estimated',
      }),
      expect.objectContaining({ inputTokens: 25, outputTokens: 6, costMicroUsd: 12 }),
    ]);
    // A second turn reuses the process and its grant.
    await h.turn('r2');
    expect(h.grants).toHaveLength(1);
    expect(h.grants[0]!.turns.filter(Boolean).map((t) => t!.runId)).toEqual(['r1', 'r2']);
    await h.runner.closeAll();
    expect(h.grants[0]!.revoked).toBe(true);
  });

  it('restarts the agent on its own account when the person switches it, and revokes the token', async () => {
    let source: 'hub' | 'agent' = 'hub';
    const h = setup({ source: () => source });
    await h.turn('r1');
    source = 'agent';
    await h.turn('r2');
    expect(h.closed).toEqual(['session-1']);
    expect(h.grants[0]!.revoked).toBe(true);
    expect(h.targets[1]!.gateway).toBeNull();
    expect(h.grants).toHaveLength(1);
  });

  it('runs the agent on its own account when the gateway cannot start, and says why in the log', async () => {
    const h = setup({ source: () => 'hub', failGateway: true });
    const events = await h.turn('r1');
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    expect(h.targets[0]!.gateway).toBeNull();
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect(h.log.lines.some((line) => /model gateway could not start/.test(String(line.msg)))).toBe(
      true,
    );
    // Not retried on every turn: the process stays.
    await h.turn('r2');
    expect(h.closed).toEqual([]);
  });

  it('leaves an agent the gateway does not serve exactly as before', async () => {
    const h = setup({ source: () => null });
    await h.turn('r1');
    expect(h.grants).toEqual([]);
    expect(h.targets[0]!.gateway).toBeNull();
  });
});
