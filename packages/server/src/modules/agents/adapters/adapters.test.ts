import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAcpAdapter, AcpSession, type AcpTransport } from './acp.js';
import { createHermesAdapter } from './hermes.js';
import { createProcessAdapter } from './process.js';
import { createAdapterSet } from './index.js';
import { whichSync } from './host.js';
import type { AgentEvent, AgentTarget } from './types.js';

/**
 * A fake ACP agent: an in-memory transport that answers the handshake, creates a session,
 * streams a few updates and finishes the turn. It lets the adapter be driven end to end
 * without a real CLI, which is what makes the protocol code testable at all.
 */
function fakeAgent(
  options: { protocolVersion?: number; updates?: Record<string, unknown>[] } = {},
) {
  const sent: Record<string, unknown>[] = [];
  let onMessage: (message: Record<string, unknown>) => void = () => {};
  let onClose: (reason: string | null) => void = () => {};

  const reply = (message: Record<string, unknown>) => queueMicrotask(() => onMessage(message));

  const transport: AcpTransport = {
    write(message) {
      const record = message as unknown as Record<string, unknown>;
      sent.push(record);
      const { id, method } = record as { id?: number; method?: string };
      if (method === 'initialize') {
        reply({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: options.protocolVersion ?? 1,
            agentCapabilities: { loadSession: true },
            authMethods: [],
          },
        });
      } else if (method === 'session/new') {
        reply({ jsonrpc: '2.0', id, result: { sessionId: 'sess-1' } });
      } else if (method === 'session/prompt') {
        for (const update of options.updates ?? [
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } },
          { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read file', kind: 'read' },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc1',
            title: 'read file',
            status: 'completed',
            content: [{ type: 'text', text: 'file body' }],
          },
        ]) {
          reply({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 'sess-1', update },
          });
        }
        reply({ jsonrpc: '2.0', id, result: { stopReason: 'completed' } });
      }
    },
    onMessage(handler) {
      onMessage = handler as never;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      onClose(null);
    },
  };

  return {
    transport,
    sent,
    /** Pretend the agent asked the person for a decision. */
    askPermission(id: number) {
      reply({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'tc9', title: 'write file' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    },
    /** Send an arbitrary request from the agent to the hub. */
    request(id: number, method: string, params?: unknown) {
      reply({ jsonrpc: '2.0', id, method, params });
    },
    crash(reason: string) {
      onClose(reason);
    },
  };
}

async function take(stream: AsyncIterable<AgentEvent>, count: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) {
    out.push(event);
    if (out.length >= count) break;
  }
  return out;
}

describe('ACP adapter: the handshake', () => {
  it('sends protocolVersion 1 with the hub’s client capabilities, then opens a session', async () => {
    const agent = fakeAgent();
    const { session } = await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    expect(session.id).toBe('sess-1');
    expect(agent.sent[0]).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: 1,
        // The hub does not lend an agent its own filesystem.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    });
    expect(agent.sent[1]).toMatchObject({
      method: 'session/new',
      params: { cwd: '/work', mcpServers: [] },
    });
  });

  it('refuses an agent that speaks a different major protocol version', async () => {
    const agent = fakeAgent({ protocolVersion: 2 });
    await expect(
      AcpSession.connect(agent.transport, {
        cwd: '/work',
        clientName: 'corehub',
        clientVersion: '1.0.0',
      }),
    ).rejects.toThrow(/ACP v2/);
  });
});

describe('ACP adapter: a turn', () => {
  it('streams deltas, tool calls and a terminal event in order', async () => {
    const agent = fakeAgent();
    const { session } = await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    const events = take(session.stream(), 6);
    const result = await session.send({ text: 'hi' });
    expect(result).toEqual({ stopReason: 'completed' });
    expect(await events).toEqual([
      { type: 'reasoning.delta', text: 'thinking' },
      { type: 'message.delta', text: 'Hello' },
      { type: 'message.delta', text: ' world' },
      { type: 'tool.started', id: 'tc1', title: 'read file', kind: 'read', raw: expect.anything() },
      {
        type: 'tool.completed',
        id: 'tc1',
        title: 'read file',
        output: 'file body',
        raw: expect.anything(),
      },
      { type: 'run.completed', stopReason: 'completed' },
    ]);
  });

  it('turns a permission request into an approval the hub can answer', async () => {
    const agent = fakeAgent();
    const { session } = await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    const events = take(session.stream(), 1);
    agent.askPermission(99);
    const [approval] = await events;
    expect(approval).toEqual({
      type: 'approval.requested',
      id: 'tc9',
      title: 'write file',
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'reject_once' },
      ],
    });

    await session.respond('tc9', 'allow');
    expect(agent.sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    await expect(session.respond('tc9', 'allow')).rejects.toThrow(/no open permission request/);
  });

  it('cancels with a session/cancel notification', async () => {
    const agent = fakeAgent();
    const { session } = await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    await session.interrupt();
    expect(agent.sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'sess-1' },
    });
  });

  it('answers a method it does not implement instead of going silent', async () => {
    const agent = fakeAgent();
    await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    // The hub declared `fs.readTextFile: false`; an agent that asks anyway gets a
    // JSON-RPC "method not found" rather than a hang.
    agent.request(7, 'fs/read_text_file', { path: '/etc/passwd' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(agent.sent.at(-1)).toMatchObject({
      id: 7,
      error: { code: -32601, message: expect.stringContaining('fs/read_text_file') },
    });
  });

  it('turns an agent crash into a run.failed event and rejects pending calls', async () => {
    const agent = fakeAgent();
    const { session } = await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    const events = take(session.stream(), 1);
    agent.crash('agent exited (code 1): boom');
    expect(await events).toEqual([{ type: 'run.failed', error: 'agent exited (code 1): boom' }]);
  });
});

describe('ACP adapter: host detection', () => {
  it('finds a catalog entry’s binary on PATH and reads its version', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-acp-'));
    try {
      const binary = path.join(dir, 'gemini');
      writeFileSync(binary, '#!/bin/sh\necho "gemini 4.5.6"\n');
      chmodSync(binary, 0o755);

      const adapter = createAcpAdapter({ host: { pathValue: dir } });
      const found = await adapter.discover();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        slug: 'gemini-cli',
        vendor: 'Google',
        executablePath: binary,
        version: '4.5.6',
        command: ['gemini', '--experimental-acp'],
      });

      const probe = await adapter.probe({
        slug: 'gemini-cli',
        name: 'Gemini CLI',
        command: ['gemini'],
        executablePath: null,
        endpoint: null,
      });
      expect(probe).toMatchObject({
        installed: true,
        source: 'user_cli',
        version: '4.5.6',
        runtime: { state: 'not_applicable' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports not installed when nothing is on PATH', async () => {
    const adapter = createAcpAdapter({ host: { pathValue: '/nowhere-at-all' } });
    expect(await adapter.discover()).toEqual([]);
    const probe = await adapter.probe({
      slug: 'codex',
      name: 'Codex',
      command: ['codex'],
      executablePath: null,
      endpoint: null,
    });
    expect(probe).toMatchObject({ installed: false, source: 'none', version: null });
  });

  it('whichSync ignores a file that is not executable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-which-'));
    try {
      writeFileSync(path.join(dir, 'tool'), 'not executable');
      expect(whichSync('tool', { pathValue: dir })).toBeNull();
      chmodSync(path.join(dir, 'tool'), 0o755);
      expect(whichSync('tool', { pathValue: dir })).toBe(path.join(dir, 'tool'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Hermes adapter', () => {
  const target: AgentTarget = {
    slug: 'hermes',
    name: 'Hermes',
    command: ['hermes'],
    executablePath: null,
    endpoint: 'http://hermes.test:8642',
  };

  it('reports a reachable gateway as a running runtime even with no CLI on this host', async () => {
    const adapter = createHermesAdapter({
      host: { pathValue: '/nowhere-at-all' },
      fetchImpl: async (input) => {
        expect(String(input)).toBe('http://hermes.test:8642/health');
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    const probe = await adapter.probe(target);
    expect(probe).toMatchObject({
      installed: true,
      runtime: { state: 'running', url: 'http://hermes.test:8642' },
    });
  });

  it('is "stopped", not "missing", when the gateway refuses the connection', async () => {
    const adapter = createHermesAdapter({
      host: { pathValue: '/nowhere-at-all' },
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const probe = await adapter.probe(target);
    expect(probe).toMatchObject({
      installed: false,
      runtime: { state: 'stopped', url: null },
      error: null,
    });
  });

  it('calls a gateway that answers badly an error, not a healthy runtime', async () => {
    const adapter = createHermesAdapter({
      host: { pathValue: '/nowhere-at-all' },
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });
    const probe = await adapter.probe(target);
    expect(probe.runtime).toMatchObject({ state: 'error', error: 'gateway answered 503' });
  });

  it('declares the four settings sections the Hermes screen renders', () => {
    const adapter = createHermesAdapter({ host: { pathValue: '/nowhere-at-all' } });
    const sections = adapter.settings(target, { max_turns: 12 });
    expect(sections.map((section) => section.key)).toEqual([
      'agent',
      'memory',
      'session',
      'gateway',
    ]);
    expect(sections[0]?.restart_required).toBe(true);
    expect(sections[0]?.fields[0]).toMatchObject({ key: 'max_turns', value: 12, kind: 'integer' });
  });

  it('refuses to start a conversation without the API server key it would need', async () => {
    const adapter = createHermesAdapter({ host: { pathValue: '/nowhere-at-all' }, apiKey: null });
    await expect(adapter.start({ ...target, sessionRef: 'corehub-x' })).rejects.toMatchObject({
      code: 'agent_unavailable',
      details: { reason: 'hermes_api_key_missing' },
    });
  });

  it('needs the runner to name the conversation (ADR 0008 §Session continuity)', async () => {
    const adapter = createHermesAdapter({
      host: { pathValue: '/nowhere-at-all' },
      apiKey: 'k'.repeat(32),
    });
    await expect(adapter.start(target)).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

describe('process harness', () => {
  it('is declared, marked unselectable, and refuses every operation (ADR 0002)', async () => {
    const adapter = createProcessAdapter();
    expect(adapter.kind).toBe('harness');
    expect(adapter.selectable).toBe(false);
    expect(adapter.capabilities()).toEqual([]);
    expect(await adapter.discover()).toEqual([]);
    const probe = await adapter.probe({
      slug: 'x',
      name: 'x',
      command: ['x'],
      executablePath: null,
      endpoint: null,
    });
    expect(probe.installed).toBe(false);
    expect(probe.error).toMatch(/not implemented/);
    await expect(
      adapter.start({ slug: 'x', name: 'x', command: ['x'], executablePath: null, endpoint: null }),
    ).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

describe('the adapter set', () => {
  it('registers the three implementations ADR 0002 names, plus the hub itself', () => {
    const set = createAdapterSet({ host: { pathValue: '/nowhere-at-all' } });
    expect(
      set
        .all()
        .map((adapter) => adapter.kind)
        .sort(),
    ).toEqual(['acp', 'builtin', 'harness', 'hermes']);
    // `builtin` is the direct agent (ADOPTION-BACKLOG §2.15): the contract reserved the
    // kind from the start and it is filled now.
    expect(set.byKind('builtin').capabilities()).toEqual(['streaming', 'vision', 'resume']);
  });
});

describe('ACP adapter: subagents (§56)', () => {
  const connect = async (updates: Record<string, unknown>[]) => {
    const agent = fakeAgent({ updates });
    const { session } = await AcpSession.connect(agent.transport, {
      cwd: '/work',
      clientName: 'corehub',
      clientVersion: '1.0.0',
    });
    const signals: unknown[] = [];
    session.subagents.watch((signal) => signals.push(signal));
    return { session, signals };
  };

  it("maps Claude Code's Task tool to a subagent that starts and ends with the call", async () => {
    // What claude-code-acp 0.16 sends: `_meta.claudeCode.toolName`, the arguments in
    // `rawInput`, the description as the title; the subagent's own calls arrive flat.
    const { session, signals } = await connect([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'task1',
        title: 'Review the tests',
        kind: 'think',
        status: 'pending',
        rawInput: {
          description: 'Review the tests',
          prompt: 'Read every test file',
          subagent_type: 'general-purpose',
        },
        _meta: { claudeCode: { toolName: 'Task' } },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'bash1',
        title: 'ls tests',
        kind: 'execute',
        _meta: { claudeCode: { toolName: 'Bash' } },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read1',
        title: 'Read a.test.ts',
        kind: 'read',
        _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'task1' } },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Two tests are missing.' } }],
        _meta: { claudeCode: { toolName: 'Task' } },
      },
    ]);
    expect(session.subagents.support).toBe('observe');
    const events = take(session.stream(), 5);
    await session.send({ text: 'review' });
    const started = (await events).filter((event) => event.type === 'tool.started');
    // A call the bridge does not attribute stays the parent's; one it does is the subagent's.
    expect(
      started.map((event) => [event.id, 'subagentId' in event ? event.subagentId : null]),
    ).toEqual([
      ['task1', null],
      ['bash1', null],
      ['read1', 'task1'],
    ]);
    expect(signals).toEqual([
      {
        phase: 'started',
        id: 'task1',
        parentId: null,
        depth: 0,
        goal: 'Review the tests',
        model: 'general-purpose',
        toolCount: null,
        acceptingSteer: false,
        toolCallRef: 'task1',
      },
      {
        phase: 'completed',
        id: 'task1',
        status: 'completed',
        summary: 'Two tests are missing.',
        acceptingSteer: false,
      },
    ]);
  });

  it("maps OpenCode's task tool, learning its goal when the arguments arrive", async () => {
    const { session, signals } = await connect([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'oc1',
        title: 'task',
        kind: 'think',
        status: 'pending',
        rawInput: {},
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'oc1',
        status: 'in_progress',
        kind: 'think',
        title: 'task',
        rawInput: { description: 'Find the config', prompt: '…', subagent_type: 'general' },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'oc1', status: 'failed', content: [] },
    ]);
    await session.send({ text: 'go' });
    expect(signals).toEqual([
      expect.objectContaining({ phase: 'started', id: 'oc1', goal: null, model: null }),
      { phase: 'updated', id: 'oc1', goal: 'Find the config', model: 'general' },
      { phase: 'completed', id: 'oc1', status: 'failed', summary: null, acceptingSteer: false },
    ]);
  });

  it('says nothing of a tool call that does not mark itself a delegation (Gemini, Codex)', async () => {
    const { session, signals } = await connect([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'g1',
        title: 'Codebase Investigator',
        kind: 'think',
        status: 'in_progress',
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed', content: [] },
    ]);
    await session.send({ text: 'go' });
    expect(signals).toEqual([]);
  });

  it('ends a delegation the stream never closed with the turn', async () => {
    const { session, signals } = await connect([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'task2',
        title: 'Look around',
        kind: 'think',
        rawInput: { description: 'Look around', subagent_type: 'Explore' },
        _meta: { claudeCode: { toolName: 'Task' } },
      },
    ]);
    await session.send({ text: 'go' });
    expect(signals.at(-1)).toEqual({
      phase: 'completed',
      id: 'task2',
      status: 'interrupted',
      summary: null,
      acceptingSteer: false,
    });
  });
});
