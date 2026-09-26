/**
 * The pure parts of the hub's own tools (contract decision §67): the protocol, the way a call
 * is attributed to a run, and the runner opening and closing that attribution as a run lives.
 */
import { describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../../tests/unit/helpers.js';
import { runGrantOf } from '../../auth/index.js';
import type { AdapterSet } from '../adapters/index.js';
import type { AgentEvent } from '../adapters/types.js';
import { AgentRunner } from '../runner.js';
import type { AgentsService } from '../service.js';
import { HUB_TOOLS, HUB_TOOL_GROUPS, confined, phoneToLocate, type ToolContext } from './catalog.js';
import { RunLeases } from './leases.js';
import { handleRpc, type McpHandlers } from './protocol.js';

const handlers: McpHandlers = {
  serverName: 'corehub',
  serverVersion: '0.0.0',
  instructions: 'x',
  listTools: () => [{ name: 'tasks.list', description: 'd', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => ({
    content: [{ type: 'text', text: JSON.stringify({ name, args }) }],
    isError: false,
  }),
};

describe('hub tools: the protocol', () => {
  it('answers initialize with the version asked for when it knows it, its newest otherwise', async () => {
    const known = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      handlers,
    );
    expect(known?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'corehub' },
    });
    const unknown = await handleRpc(
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      handlers,
    );
    expect(unknown?.result?.protocolVersion).toBe('2025-11-25');
  });

  it('acknowledges a notification with nothing and refuses what is not one message', async () => {
    expect(
      await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers),
    ).toBeNull();
    expect(
      (await handleRpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }], handlers))?.error?.code,
    ).toBe(-32600);
    expect((await handleRpc({ id: 1, method: 'ping' }, handlers))?.error?.code).toBe(-32600);
    expect(
      (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'nope' }, handlers))?.error?.code,
    ).toBe(-32601);
    expect(
      (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, handlers))
        ?.error?.code,
    ).toBe(-32602);
  });

  it('lists and calls through the handlers it is given', async () => {
    const list = await handleRpc({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, handlers);
    expect(list).toMatchObject({ id: 'a', result: { tools: [{ name: 'tasks.list' }] } });
    const called = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tasks.list', arguments: { limit: 2 } },
      },
      handlers,
    );
    expect(
      JSON.parse((called?.result as { content: Array<{ text: string }> }).content[0]!.text),
    ).toEqual({
      name: 'tasks.list',
      args: { limit: 2 },
    });
  });

  it('has the groups the card lists, every tool in one of them, reads before writes named plainly', () => {
    expect(HUB_TOOL_GROUPS).toEqual([
      'tasks',
      'schedules',
      'conversations',
      'notifications',
      'workflows',
      'files',
      'devices',
    ]);
    expect(HUB_TOOLS.map((tool) => tool.name)).toEqual([
      'tasks.list',
      'tasks.create',
      'tasks.move',
      'tasks.assign',
      'tasks.comment',
      'schedules.list',
      'schedules.create',
      'schedules.pause',
      'schedules.run_now',
      'conversations.list',
      'conversations.search',
      'conversations.summary',
      'notifications.notify',
      'workflows.list',
      'workflows.run',
      'files.list',
      'files.read',
      'files.write',
      'devices.list',
      'devices.list_folder',
      'devices.read_file',
      'devices.write_file',
      'devices.open',
      'devices.fetch_file',
      'devices.run',
      'devices.locate',
      'devices.run_status',
    ]);
    for (const tool of HUB_TOOLS) {
      expect(tool.name.startsWith(`${tool.group}.`)).toBe(true);
      expect(tool.name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('keeps a path inside the profile folder', () => {
    const root = `${process.env.TMPDIR ?? '/tmp'}/corehub-confined-${process.pid}`;
    expect(confined(root, 'a/b.txt')).toBe(`${confined(root, '.')}/a/b.txt`);
    expect(() => confined(root, '../x')).toThrow(/outside/);
  });
});

describe('hub tools: which run a call belongs to', () => {
  it('no live run: nobody to act for', async () => {
    expect(await new RunLeases().attribute('W', 0)).toEqual({
      ok: false,
      reason: 'hub_tools_no_live_run',
    });
  });

  it('one owner, however many runs: that owner; another profile does not count', async () => {
    const leases = new RunLeases();
    leases.open({ runId: 'r1', sessionId: 's1', workspaceId: 'W', userId: 'U1' });
    leases.open({ runId: 'r2', sessionId: 's2', workspaceId: 'W', userId: 'U1' });
    leases.open({ runId: 'r3', sessionId: 's3', workspaceId: 'OTHER', userId: 'U2' });
    const got = await leases.attribute('W', 0);
    expect(got.ok && got.lease.userId).toBe('U1');
    leases.toolStarted('r1', 'mcp__corehub__tasks_list');
    const announced = await leases.attribute('W', 0);
    expect(announced.ok && announced.lease.runId).toBe('r1');
    for (const id of ['r1', 'r2', 'r3']) leases.close(id);
  });

  it('two owners: the one whose agent announced the call, or a refusal — never a guess', async () => {
    const leases = new RunLeases();
    leases.open({ runId: 'a', sessionId: 'sa', workspaceId: 'W', userId: 'U1' });
    leases.open({ runId: 'b', sessionId: 'sb', workspaceId: 'W', userId: 'U2' });
    expect(await leases.attribute('W', 0)).toEqual({
      ok: false,
      reason: 'hub_tools_run_ambiguous',
    });
    // Another MCP server's tool says nothing about ours.
    leases.toolStarted('a', 'mcp__github__search');
    expect((await leases.attribute('W', 0)).ok).toBe(false);
    // The announcement may arrive a moment after the call: the call waits for it.
    const waiting = leases.attribute('W', 1000);
    setTimeout(() => leases.toolStarted('b', 'mcp__corehub__tasks_create'), 100);
    const got = await waiting;
    expect(got.ok && got.lease.userId).toBe('U2');
    leases.toolEnded('b', 'mcp__corehub__tasks_create');
    expect((await leases.attribute('W', 0)).ok).toBe(false);
    leases.close('a');
    leases.close('b');
  });

  it("counts a call through Hermes's tool_call bridge as the hub's, and no other", () => {
    const leases = new RunLeases();
    leases.open({ runId: 'a', sessionId: 'sa', workspaceId: 'W', userId: 'U1' });
    leases.toolStarted('a', 'tool_call', { calls: [{ name: 'mcp__github__x', arguments: {} }] });
    expect(leases.live('W')[0]!.pending).toBe(0);
    const bridged = { calls: [{ name: 'mcp__corehub__tasks_create', arguments: {} }] };
    leases.toolStarted('a', 'tool_call', bridged);
    expect(leases.live('W')[0]!.pending).toBe(1);
    leases.toolEnded('a', 'tool_call', bridged);
    expect(leases.live('W')[0]!.pending).toBe(0);
    leases.close('a');
  });

  it('a lease without an owner is never opened', async () => {
    const leases = new RunLeases();
    leases.open({ runId: 'x', sessionId: 's', workspaceId: 'W', userId: null });
    expect(leases.live('W')).toEqual([]);
  });
});

describe('hub tools: the runner opens a lease for the life of a run', () => {
  it("names the run's owner, counts the agent's calls to the hub's tools, and revokes at the end", async () => {
    let release!: () => void;
    const finished = new Promise<void>((resolve) => (release = resolve));
    const events: AgentEvent[] = [
      { type: 'tool.started', id: 't1', title: 'x', kind: 'x', name: 'mcp__corehub__tasks_create' },
    ];
    const adapter = {
      async start() {
        return {
          id: 'agent-session',
          async send() {
            return { stopReason: 'completed' };
          },
          async *stream(): AsyncIterable<AgentEvent> {
            for (const event of events) yield event;
            await finished;
            yield { type: 'tool.completed', id: 't1', title: 'x', output: 'ok' };
            yield { type: 'run.completed', stopReason: 'completed' };
          },
          async respond() {},
          async interrupt() {},
          async close() {},
        };
      },
    };
    const service = {
      loadAgent: () => ({ id: 'agent-1', installState: 'installed', adapterKind: 'hermes' }),
      selectionFor: () => ({ model: null, provider: null, providerId: null }),
      fallbacksFor: () => [],
      providerSlugOf: () => null,
      targetFor: () => ({}),
    };
    const leases = new RunLeases();
    const runner = new AgentRunner({
      service: service as unknown as AgentsService,
      adapters: { byKind: () => adapter } as unknown as AdapterSet,
      log: capturingLogger().logger,
      leases,
    });
    await runner.start({
      runId: 'RUN',
      sessionId: 'SES',
      workspace: 'W',
      agentId: 'agent-1',
      agentSessionRef: null,
      workingDir: null,
      model: null,
      provider: null,
      reasoningEffort: null,
      prompt: [{ type: 'text', text: 'hi' }],
      files: null,
      allowedTools: [],
      userId: 'OWNER',
    });
    const drained = (async () => {
      for await (const _event of runner.stream('RUN')) void _event;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [lease] = leases.live('W');
    expect(lease).toMatchObject({ userId: 'OWNER', sessionId: 'SES', pending: 1 });
    expect(runGrantOf(lease!.token)).toMatchObject({ userId: 'OWNER', workspaceId: 'W' });
    release();
    await drained;
    expect(leases.live('W')).toEqual([]);
    expect(runGrantOf(lease!.token)).toBeNull();
  });
});

describe('hub tools: where the phone is (§103)', () => {
  const phone = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `Phone ${id}`,
    kind: 'phone',
    online: false,
    last_seen_at: '2026-09-26T08:00:00Z',
    profiles: null,
    capabilities: [{ kind: 'location', enabled: true }],
    ...over,
  });

  it('asks the phone that can tell: named, else connected, else seen last', () => {
    const list = [
      phone('a', { last_seen_at: '2026-09-26T09:00:00Z' }),
      phone('b', { online: true }),
      phone('c', { capabilities: [{ kind: 'location', enabled: false }], online: true }),
      phone('d', { profiles: ['home'], online: true, last_seen_at: '2026-09-26T10:00:00Z' }),
      phone('e', { capabilities: [{ kind: 'notifications', enabled: true }] }),
    ];
    expect(phoneToLocate(list, 'work')?.id).toBe('b');
    expect(phoneToLocate(list.filter((d) => d.id !== 'b'), 'work')?.id).toBe('a');
    expect(phoneToLocate(list, 'home')?.id).toBe('d');
    expect(phoneToLocate(list, 'work', 'a')?.id).toBe('a');
    expect(phoneToLocate(list, 'work', 'c')).toBeNull();
    expect(phoneToLocate([phone('x', { capabilities: [] })], 'work')).toBeNull();
  });

  it('makes a location request with the why, and answers with the place the phone sent', async () => {
    const tool = HUB_TOOLS.find((t) => t.name === 'devices.locate')!;
    expect(tool.access).toBe('read');
    const calls: Array<{ method: string; route: string; body?: unknown }> = [];
    let reads = 0;
    const ctx: ToolContext = {
      profile: 'work',
      agentId: null,
      filesRoot: '/tmp',
      timezone: 'UTC',
      sessionId: '01J8QK3ZR2W7M5N4P6T8V9X0SS',
      notify: () => {},
      sleep: async () => {},
      async call(method, route, options) {
        calls.push({ method, route, body: options?.body });
        if (method === 'GET' && route === '/devices') return { items: [phone('p1', { online: true })] };
        if (method === 'POST') return { job_id: 'j', request_id: 'r1' };
        reads += 1;
        return reads < 2
          ? { id: 'r1', status: 'pending', result: null, error: null }
          : {
              id: 'r1',
              status: 'fulfilled',
              result: { latitude: 24.7, longitude: 46.7, accuracy_m: 12, captured_at: '2026-09-26T09:00:00Z' },
              error: null,
            };
      },
    };
    const answer = await tool.run(ctx, { why: 'أقرب صيدلية' });
    expect(answer).toEqual({
      device: 'Phone p1',
      latitude: 24.7,
      longitude: 46.7,
      accuracy_m: 12,
      captured_at: '2026-09-26T09:00:00Z',
    });
    const created = calls.find((c) => c.method === 'POST')!;
    expect(created.body).toMatchObject({
      device_id: 'p1',
      capability: 'location',
      purpose: 'أقرب صيدلية',
      session_id: '01J8QK3ZR2W7M5N4P6T8V9X0SS',
      timeout_ms: 90_000,
    });
  });

  it('a phone that says no is a refusal the agent can read', async () => {
    const tool = HUB_TOOLS.find((t) => t.name === 'devices.locate')!;
    const ctx: ToolContext = {
      profile: 'work',
      agentId: null,
      filesRoot: '/tmp',
      timezone: 'UTC',
      notify: () => {},
      sleep: async () => {},
      async call(method, route) {
        if (route === '/devices') return { items: [phone('p1')] };
        if (method === 'POST') return { request_id: 'r1' };
        return { id: 'r1', status: 'denied', result: null, error: { code: 'forbidden', message: 'the person said no' } };
      },
    };
    await expect(tool.run(ctx, {})).rejects.toMatchObject({ code: 'device_denied' });
    const none: ToolContext = { ...ctx, call: async () => ({ items: [] }) };
    await expect(tool.run(none, {})).rejects.toMatchObject({ code: 'device_capability_off' });
  });
});
