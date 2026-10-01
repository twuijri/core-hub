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
    googleBaseUrl: 'http://127.0.0.1:1/gateway/google',
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

function setup(options: {
  source: () => 'hub' | 'agent' | null;
  failGateway?: boolean;
  /** Why the hub did not route the agent (`AgentsService.gatewayMiss`). */
  miss?: string;
  /** The turn as the agent plays it; absent, two model calls and the end. */
  play?: (
    turn: AgentGatewayTurn | null | undefined,
    finish: () => void,
  ) => Promise<{ stopReason: string }>;
}) {
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
          if (options.play) return options.play(turn, () => finish?.());
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
      name: 'Claude Code',
      installState: 'installed',
      adapterKind: 'acp',
    }),
    settled: async () => {},
    selectionFor: () => ({ model: 'coder', provider: null, providerId: 'p1' }),
    fallbacksFor: () => [{ providerId: 'p2', provider: null, slug: 'backup', model: 'spare' }],
    providerSlugOf: (_workspace: string, selection: { providerId: string | null }) =>
      selection.providerId === 'p2' ? 'backup' : 'example',
    modelSourceFor: () => options.source(),
    gatewayMiss: () => options.miss ?? null,
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

  it('fails a turn the gateway cannot start for, instead of running the agent on its own account', async () => {
    const h = setup({ source: () => 'hub', failGateway: true });
    await expect(h.turn('r1')).rejects.toMatchObject({
      code: 'provider_not_configured',
      message: expect.stringMatching(
        /Claude Code cannot run: Core Hub's model gateway could not start/,
      ),
    });
    // No process was started on the agent's own account.
    expect(h.targets).toEqual([]);
    expect(h.log.lines.some((line) => /model gateway could not start/.test(String(line.msg)))).toBe(
      true,
    );
  });

  it('fails a turn the hub has no model for, saying where to add one, and starts nothing', async () => {
    const miss =
      'Claude Code cannot run: Core Hub has no model for it. Add a provider or choose a default model in Settings → Models, or pick a model for this chat.';
    const h = setup({ source: () => 'hub', miss });
    await expect(h.turn('r1')).rejects.toMatchObject({
      code: 'provider_not_configured',
      message: miss,
    });
    expect(h.grants).toEqual([]);
    expect(h.targets).toEqual([]);
  });

  it('leaves an agent the gateway does not serve exactly as before', async () => {
    const h = setup({ source: () => null });
    await h.turn('r1');
    expect(h.grants).toEqual([]);
    expect(h.targets[0]!.gateway).toBeNull();
  });

  it('fails a turn whose provider ran out of quota as that, naming the provider and model', async () => {
    const h = setup({
      source: () => 'hub',
      play: async (turn) => {
        expect(turn?.fallbacks).toEqual([{ providerId: 'p2', model: 'spare' }]);
        turn?.exhausted?.({
          providerId: 'p1',
          model: 'coder',
          providerLabel: 'CLI Proxy',
          modelLabel: 'Gemini 3.8 Flash High',
          said: 'Resource has been exhausted (e.g. check quota).',
        });
        throw new Error('Internal error: API Error: 429 {"type":"error"}');
      },
    });
    const events = await h.turn('r1');
    expect(events.at(-1)).toEqual({
      type: 'failed',
      code: 'rate_limited',
      message:
        'CLI Proxy ran out of quota for Gemini 3.8 Flash High. Pick another model for this chat.',
      details: {
        reason: 'quota_exhausted',
        provider: 'CLI Proxy',
        model: 'Gemini 3.8 Flash High',
        provider_id: 'p1',
        model_id: 'coder',
        said: 'Resource has been exhausted (e.g. check quota).',
      },
    });
    await h.runner.closeAll();
  });

  it('says what the gateway is doing while it waits and moves down the chain (run.status)', async () => {
    const h = setup({
      source: () => 'hub',
      play: async (turn, finish) => {
        turn?.waiting?.({
          providerLabel: 'Google Antigravity',
          modelLabel: 'gemini-3.8-flash-high',
          seconds: 5,
          reason: 'no_capacity',
        });
        turn?.fellBack?.({
          failed: {
            providerId: 'p1',
            model: 'coder',
            reason: 'no_capacity',
            providerLabel: 'Google Antigravity',
            modelLabel: 'gemini-3.8-flash-high',
            said: 'No capacity available for model gemini-3.8-flash-high on the server',
          },
          answered: {
            providerId: 'p2',
            model: 'spare',
            modelLabel: 'gpt-6-sol',
            providerLabel: 'ChatGPT',
          },
        });
        finish();
        return { stopReason: 'end_turn' };
      },
    });
    const events = await h.turn('r1');
    expect(events.filter((event) => event.type === 'model_status')).toEqual([
      {
        type: 'model_status',
        phase: 'waiting',
        provider: 'Google Antigravity',
        model: 'gemini-3.8-flash-high',
        seconds: 5,
        reason: 'no_capacity',
      },
      {
        type: 'model_status',
        phase: 'trying',
        provider: 'ChatGPT',
        model: 'gpt-6-sol',
        seconds: null,
        reason: 'no_capacity',
      },
    ]);
    expect(events.find((event) => event.type === 'model_fallback')).toMatchObject({
      failed: [
        {
          error: 'Google Antigravity has no capacity for gemini-3.8-flash-high right now',
        },
      ],
    });
    await h.runner.closeAll();
  });

  it('says so when the gateway moved the turn down the fallback chain', async () => {
    const h = setup({
      source: () => 'hub',
      play: async (turn, finish) => {
        turn?.fellBack?.({
          failed: {
            providerId: 'p1',
            model: 'coder',
            providerLabel: 'CLI Proxy',
            modelLabel: 'Coder',
            said: 'quota',
          },
          answered: { providerId: 'p2', model: 'spare', modelLabel: 'Spare' },
        });
        // The chain's first model ran out too: the next move names both.
        turn?.fellBack?.({
          failed: {
            providerId: 'p2',
            model: 'spare',
            reason: 'no_capacity',
            providerLabel: 'Backup',
            modelLabel: 'Spare',
            said: 'No capacity available',
          },
          answered: { providerId: 'p2', model: 'last', modelLabel: 'Last' },
        });
        finish();
        return { stopReason: 'end_turn' };
      },
    });
    const events = await h.turn('r1');
    expect(events.filter((event) => event.type === 'model_fallback').at(-1)).toEqual({
      type: 'model_fallback',
      failed: [
        {
          model: 'coder',
          provider: 'example',
          code: 'rate_limited',
          error: 'CLI Proxy ran out of quota for Coder',
        },
        {
          model: 'spare',
          provider: 'backup',
          code: 'rate_limited',
          error: 'Backup has no capacity for Spare right now',
        },
      ],
      answered: { model: 'last', provider: 'backup' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    await h.runner.closeAll();
  });
});
