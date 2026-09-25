/**
 * The hub's own tools against **the real Hermes** from the image (contract decision §58).
 *
 * The whole path a person would take: the hub listens on the loopback, the card switches its
 * tools on (the hub writes the `corehub` block into Hermes's `config.yaml` and the key into
 * its `.env`), and a chat turn goes through the hub's own engine and runner to the image's
 * Hermes TUI gateway. The model is scripted on this machine: its first answer calls
 * `mcp__corehub__tasks_create` — which it can only do if Hermes connected to the hub, listed
 * its tools and offered them — and its second repeats what the tool said. Then the task is on
 * the board, made as the person whose chat it was.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hub-tools/hub-tools.real.test.ts
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { capturingLogger } from '../../../../tests/unit/helpers.js';
import { stdioTuiChannel, type TuiChannel } from '../adapters/hermes-tui.js';
import { HermesDashboard, type DashboardSpawner } from '../hermes-dashboard.js';
import type { SpawnedProcess } from '../hermes-runtime.js';
import { testMcpServer } from '../hermes-tools.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const TITLE = 'Filed by Hermes through Core Hub';

interface ModelLog {
  /** Per request: the tools Hermes offered the model, as JSON (names and descriptions). */
  offered: string[];
}

/** Turn one calls the hub's `tasks.create`; turn two says what the tool answered. */
function scriptedModel(log: ModelLog): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as {
            messages?: Array<{ role: string; content: unknown }>;
            stream?: boolean;
            tools?: Array<{ function?: { name?: string } }>;
          })
        : {};
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? '');
      const offered = JSON.stringify(body.tools ?? []);
      log.offered.push(offered);
      const tool = [...(body.messages ?? [])].reverse().find((m) => m.role === 'tool');
      // Hermes lists MCP tools on demand behind its bridge (`tool_search` / `tool_call`) once
      // there are enough of them; a model that sees the name calls it through the bridge.
      const direct = names.includes('mcp__corehub__tasks_create');
      const bridged =
        !direct && names.includes('tool_call') && offered.includes('mcp__corehub__tasks_create');
      // Only the person's own turn asks for a task; the hub's title question (a conversation
      // of its own, outside any run) must not — and could not: nobody would be acted for.
      const asked = JSON.stringify(body.messages ?? []).includes('File a task');
      const call = !tool && asked && (direct || bridged);
      const reply = tool ? `tool said: ${String(tool.content).slice(0, 400)}` : 'no tools here';
      const toolCall = {
        id: 'call_hub_1',
        type: 'function',
        function: direct
          ? { name: 'mcp__corehub__tasks_create', arguments: JSON.stringify({ title: TITLE }) }
          : {
              name: 'tool_call',
              arguments: JSON.stringify({
                calls: [{ name: 'mcp__corehub__tasks_create', arguments: { title: TITLE } }],
              }),
            },
      };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = call
          ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
          : { role: 'assistant', content: reply };
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake-1',
          choices: [
            {
              index: 0,
              message: call
                ? { role: 'assistant', content: null, tool_calls: [toolCall] }
                : { role: 'assistant', content: reply },
              finish_reason: call ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

describe.skipIf(!image)("the hub's own tools (real Hermes; set COREHUB_HERMES_IMAGE)", () => {
  const log: ModelLog = { offered: [] };
  let model: http.Server;
  let hub: TestHub & { token: string; userId: string };
  let channel: TuiChannel | null = null;
  const containers: string[] = [];

  beforeAll(async () => {
    model = scriptedModel(log);
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const modelPort = (model.address() as AddressInfo).port;
    const { uid, gid } = userInfo();
    let dataDir = '';
    hub = await signedInHub(
      {},
      {
        agents: {
          adapterOptions: {
            hermes: {
              fetchImpl: healthy,
              ensureProfile: async () => undefined,
              // The image's own TUI gateway, with the hub's data at the same path inside, so the
              // home the hub writes and the session folders it names are the ones Hermes reads.
              tui: () => {
                if (channel?.alive) return channel;
                const name = `corehub-hubtools-real-${process.pid}-${containers.length}`;
                containers.push(name);
                channel = stdioTuiChannel({
                  command: 'docker',
                  args: [
                    'run',
                    '--rm',
                    '-i',
                    '--name',
                    name,
                    '--network',
                    'host',
                    '--user',
                    `${uid}:${gid}`,
                    '-v',
                    `${dataDir}:${dataDir}`,
                    '-e',
                    `HERMES_HOME=${path.join(dataDir, 'hermes')}`,
                    '-e',
                    'HOME=/tmp',
                    '-e',
                    'COREHUB_FAKE_KEY=fake-key-000000000000',
                    '--entrypoint',
                    '/opt/hermes/.venv/bin/python',
                    image!,
                    '-m',
                    'tui_gateway.entry',
                  ],
                  env: process.env,
                  readyTimeoutMs: 120_000,
                });
                return channel;
              },
            },
          },
        },
      },
    );
    dataDir = hub.dataDir;
    const home = path.join(dataDir, 'hermes');
    mkdirSync(home, { recursive: true });
    chmodSync(dataDir, 0o777);
    writeFileSync(
      path.join(home, 'config.yaml'),
      [
        '# written by the real-Hermes test',
        'providers:',
        '  corehub-fake:',
        '    name: corehub-fake',
        `    base_url: http://127.0.0.1:${modelPort}/v1`,
        '    key_env: COREHUB_FAKE_KEY',
        '    api_mode: chat_completions',
        'model:',
        '  default: fake-1',
        '  provider: corehub-fake',
        '',
      ].join('\n'),
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
  }, 180_000);

  afterAll(async () => {
    await channel?.close();
    await hub?.close().catch(() => undefined);
    model?.close();
    for (const name of containers) {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // gone with --rm
      }
    }
    try {
      rmSync(hub?.dataDir ?? '', { recursive: true, force: true });
    } catch {
      // a temp directory
    }
  });

  it('Hermes lists the hub tools, an agent turn calls tasks.create, and the task is on the board', async () => {
    const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
    const hermes = (agents.json().items as Array<{ id: string; kind: string }>).find(
      (agent) => agent.kind === 'hermes',
    )!.id;
    const on = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${hermes}/hub-tools`,
      payload: { enabled: true, groups: [{ id: 'tasks', allow_writes: true }] },
    });
    expect(on.statusCode, on.body).toBe(200);

    const session = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { agent_id: hermes },
    });
    expect(session.statusCode, session.body).toBe(201);
    const sessionId = session.json().id as string;
    const run = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'File a task for me, please.' }] },
    });
    expect(run.statusCode, run.body).toBe(202);
    const runId = (run.json().run_id ?? run.json().id) as string;

    let status = '';
    for (let i = 0; i < 240 && !['succeeded', 'failed', 'cancelled'].includes(status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const got = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/runs/${runId}`,
      });
      status = got.json().status as string;
    }
    const messages = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/messages`,
    });
    expect(status, messages.body).toBe('succeeded');

    // Hermes connected, listed the hub's tools and offered them to the model under its names.
    const offered = log.offered.find((tools) => tools.includes('mcp__corehub__tasks_create'));
    expect(offered, log.offered.join('\n')).toBeDefined();
    expect(offered).toContain('mcp__corehub__tasks_list');
    // Files read only: its write was never offered.
    expect(offered).not.toContain('mcp__corehub__files_write');

    const board = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/tasks' });
    const task = (board.json().items as Array<{ title: string; owner_id: string }>).find(
      (item) => item.title === TITLE,
    );
    expect(task, board.body).toBeDefined();
    expect(task!.owner_id).toBe(hub.userId);
    expect(messages.body).toContain('tool said');

    const card = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/agents/${hermes}/hub-tools`,
    });
    expect(card.json().recent_calls[0], card.body).toMatchObject({
      tool: 'tasks.create',
      ok: true,
      user_id: hub.userId,
      session_id: sessionId,
    });
  }, 300_000);
  it("the card's Test: Hermes's own MCP test connects to the hub and lists the tools offered", async () => {
    const { uid, gid } = userInfo();
    const home = path.join(hub.dataDir, 'hermes');
    // `hermes serve` in the image, as this user, on the same home (ADR 0015).
    const spawnImpl: DashboardSpawner = (_command, args, options) => {
      const name = `corehub-hubtools-serve-${process.pid}-${containers.length}`;
      containers.push(name);
      return spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'host',
          '--user',
          `${uid}:${gid}`,
          '-v',
          `${hub.dataDir}:${hub.dataDir}`,
          '-e',
          `HERMES_HOME=${home}`,
          '-e',
          'HOME=/tmp',
          '-e',
          'HERMES_DASHBOARD_SESSION_TOKEN',
          '--entrypoint',
          '/opt/hermes/.venv/bin/hermes',
          image!,
          ...args,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HERMES_DASHBOARD_SESSION_TOKEN: options.env.HERMES_DASHBOARD_SESSION_TOKEN,
          },
        },
      ) as unknown as SpawnedProcess;
    };
    const dashboard = new HermesDashboard({
      host: {
        status: () => ({ mode: 'managed', home }),
        executable: () => '/opt/hermes/.venv/bin/hermes',
        cliEnv: () => ({}),
      },
      dataDir: hub.dataDir,
      log: capturingLogger().logger,
      spawnImpl,
      startTimeoutMs: 120_000,
    });
    try {
      const result = await testMcpServer(
        (method, route, body, options) => dashboard.request(method, route, body, options),
        { profile: 'default', name: 'corehub', config: {}, language: 'en' },
      );
      expect(result.error).toBeNull();
      expect(result.ok).toBe(true);
      const names = result.tools.map((tool) => tool.name);
      expect(names).toContain('tasks.create');
      expect(names).toContain('conversations.search');
      expect(names).not.toContain('files.write');
    } finally {
      await dashboard.close();
    }
  }, 300_000);
});
