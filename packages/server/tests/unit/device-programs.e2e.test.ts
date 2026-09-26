/**
 * The whole road of ADR 0025, end to end, with nothing faked but Hermes's model and DaVinci
 * Resolve:
 *
 *   an agent's turn on a hub (a server, here on a free port)
 *   → the hub's `devices` tools (its MCP endpoint, as Hermes calls it)
 *   → a device request to the person's own computer
 *   → the desktop app's main process (its real device connection, `/rt/devices`)
 *   → a program on that computer (a stand-in for Resolve's AI integration, over stdio)
 *   → the render uploaded with the resumable upload
 *   → the reply in the chat carries the video, and it streams with `Range`.
 *
 * The desktop side is the app's own code (`apps/desktop/src/main`), without Electron: the
 * keychain, the native dialog and the shell are small fakes. The acceptance of the spec: a
 * project created, clips imported, a timeline built, an MP4 rendered, one consent question,
 * every call in the activity list, and the MP4 in the chat.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HermesRunEvent, HermesTransport } from '../../src/modules/agents/adapters/hermes.js';
import { authed, signedInHub, type TestHub } from './helpers.js';
import { ThisComputerService } from '../../../../apps/desktop/src/main/this-computer.js';
import { defaultConfig, type DesktopConfig } from '../../../../apps/desktop/src/shared/config.js';
import type { ConsentQuestion } from '../../../../apps/desktop/src/main/consent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_RESOLVE = path.resolve(
  here,
  '../../../../apps/desktop/tests/fixtures/fake-resolve-mcp.mjs',
);
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

interface ToolAnswer {
  isError: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

describe('device programs: a hub on a server drives a program on the person’s computer', () => {
  let hub: TestHub & { token: string; userId: string };
  let baseUrl = '';
  let home = '';
  let computer: ThisComputerService;
  let config: DesktopConfig;
  const questions: ConsentQuestion[] = [];
  /** What the "agent" saw, call by call. */
  const seen: Array<{ tool: string; answer: ToolAnswer }> = [];
  let hubKey = '';

  /** One MCP call to the hub's own tools, as Hermes makes it. */
  async function mcp(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
    const res = await fetch(`${baseUrl}/api/v1/hub-mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hubKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: seen.length + 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const answer = {
      isError: body.result.isError,
      body: JSON.parse(body.result.content[0]!.text) as unknown,
    };
    seen.push({ tool: name, answer });
    return answer;
  }

  /** The stand-in for Hermes's model: it plans the edit and calls the hub's tools. */
  const transport: HermesTransport = {
    async createRun() {
      return { run_id: 'hermes-run-1' };
    },
    async *events(): AsyncIterable<HermesRunEvent> {
      yield { event: 'run.started' } as HermesRunEvent;
      const list = await mcp('devices.list');
      const device = list.body.devices[0];
      const program = device.programs[0];
      const folder = device.folders.find((f: { default?: boolean }) => f.default).path as string;
      const run = (tool: string, args: Record<string, unknown>) =>
        mcp('devices.run', { device_id: device.id, program: program.id, tool, arguments: args });
      await run('create_project', { name: 'Trip' });
      await run('import_media', {
        paths: [path.join(folder, 'clips', 'a.mov'), path.join(folder, 'clips', 'b.mov')],
      });
      await run('create_timeline', { name: 'Trip cut' });
      let render = await run('render', { output_dir: folder, file_name: 'trip.mp4' });
      for (let i = 0; render.body.state === 'running' && i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        render = await mcp('devices.run_status', {
          device_id: device.id,
          call_id: render.body.call_id,
        });
      }
      await mcp('devices.fetch_file', {
        device_id: device.id,
        path: path.join(folder, 'trip.mp4'),
      });
      yield { event: 'message.delta', delta: 'Your cut is rendered.' } as HermesRunEvent;
      yield {
        event: 'run.completed',
        completed: true,
        output: 'Your cut is rendered.',
        usage: {},
      } as HermesRunEvent;
    },
    async approve() {},
    async stop() {},
  };

  beforeAll(async () => {
    hub = await signedInHub(
      {},
      {
        agents: {
          adapterOptions: { hermes: { fetchImpl: healthy, transport: () => transport } },
          runtime: { healthIntervalMs: 0 },
        },
      },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    mkdirSync(path.join(hub.dataDir, 'hermes'), { recursive: true });

    // The person's computer: a home with Claude Desktop's extension for Resolve installed.
    home = mkdtempSync(path.join(tmpdir(), 'corehub-home-'));
    const extension = path.join(home, '.config', 'Claude', 'Claude Extensions', 'davinci-resolve');
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      path.join(extension, 'manifest.json'),
      JSON.stringify({
        manifest_version: '0.2',
        name: 'davinci-resolve',
        display_name: 'DaVinci Resolve',
        description: 'Control DaVinci Resolve from an assistant.',
        server: {
          type: 'node',
          entry_point: 'server.mjs',
          mcp_config: {
            command: process.execPath,
            args: [FAKE_RESOLVE],
            env: { RESOLVE_MCP_KEY: '${user_config.api_key}', FAKE_RENDER_MS: '1500' },
          },
        },
        user_config: {
          api_key: { type: 'string', title: 'API key', sensitive: true, required: true },
        },
      }),
    );
    config = defaultConfig(() => 'device-key-programs-e2e');
    computer = new ThisComputerService({
      config: {
        get: () => config,
        update: (change) => (config = change(config)),
      },
      seal: (text) => `plain:${text}`,
      unseal: (text) => text.replace(/^plain:/, ''),
      askConsent: async (question) => {
        questions.push(question);
        return 'session';
      },
      env: { openPath: async () => '', openUrl: async () => undefined },
      version: '0.0.0-test',
      productName: 'Core Hub',
      discovery: { home, platform: 'linux', env: {} },
      home,
      softDeadlineMs: 300,
      reconnectDelayMs: 100,
      computer: () => ({
        deviceKey: config.deviceKey,
        name: 'Studio Mac',
        platform: 'darwin',
        appVersion: '0.0.0-test',
        model: 'test',
      }),
    });
  });

  afterAll(async () => {
    await computer?.stop();
    await hub?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('finds the program, which needs its key first, and the default folder when the helper goes on', async () => {
    computer.rescan();
    const found = computer.programsState().programs;
    expect(found.map((p) => [p.id, p.source, p.status])).toEqual([
      ['davinci-resolve', 'claude_desktop_extension', 'needs_setup'],
    ]);
    expect(found[0]!.fields).toMatchObject([{ key: 'api_key', sensitive: true, set: false }]);
    expect(found[0]!.resolve).toBe(true);

    config = { ...config, helper: { ...config.helper, enabled: true } };
    const folder = computer.ensureDefaultFolder();
    expect(folder).toBe(path.join(home, 'Core Hub'));
    expect(existsSync(folder!)).toBe(true);
    expect(config.helper.folders).toEqual([{ path: folder, write: true }]);
    expect(config.helper.defaultFolder).toBe(folder);
    mkdirSync(path.join(folder!, 'clips'));
    writeFileSync(path.join(folder!, 'clips', 'a.mov'), 'clip a');
    writeFileSync(path.join(folder!, 'clips', 'b.mov'), 'clip b');

    await computer.setField('davinci-resolve', 'api_key', 'k-123');
    await computer.setProfiles('davinci-resolve', ['default']);
    const ready = computer.programsState().programs[0]!;
    expect(ready.status).toBe('ready');
    expect(ready.profiles).toEqual(['default']);
    expect(ready.tools.map((t) => t.name)).toContain('render');
    // The key is kept sealed, never in clear.
    expect(JSON.stringify(config.helper.programs)).toContain('plain:k-123');
  });

  it('pairs from the signed-in page and keeps its own connection, telling the hub what it offers', async () => {
    const pairing = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/pairings',
      payload: { connection: 'lan', ttl_seconds: 300 },
    });
    expect(pairing.statusCode, pairing.body).toBe(201);
    const { id, code } = pairing.json() as { id: string; code: string };
    await computer.useHub(baseUrl);
    const linked = await computer.linkWithPairing(id, code);
    expect(linked.linked).toBe(true);
    // The token is the app's, kept sealed, never handed to the page.
    expect(config.links[baseUrl]!.token.startsWith('plain:hub_at_')).toBe(true);

    let device: Record<string, unknown> | undefined;
    for (let i = 0; i < 50; i += 1) {
      const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/devices' });
      device = (list.json() as { items: Array<Record<string, unknown>> }).items.find(
        (d) => d.id === linked.deviceId,
      );
      if (device?.online && (device.helper as { programs?: unknown[] } | null)?.programs?.length)
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(computer.deviceState().status).toBe('connected');
    expect(device).toMatchObject({
      online: true,
      profiles: null,
      helper: {
        allow_open: false,
        folders: [{ path: path.join(home, 'Core Hub'), write: true, default: true }],
        programs: [{ id: 'davinci-resolve', name: 'DaVinci Resolve', profiles: ['default'] }],
      },
    });
    expect(device!.capabilities).toEqual(
      expect.arrayContaining([
        { kind: 'files', enabled: true, consent_at: null },
        { kind: 'apps', enabled: true, consent_at: null },
      ]),
    );
  });

  it('runs the whole edit from a chat: one question, every call listed, the MP4 in the reply', async () => {
    const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
    const hermes = (agents.json() as { items: Array<{ id: string; slug: string }> }).items.find(
      (a) => a.slug === 'hermes',
    )!;
    const tools = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${hermes.id}/hub-tools`,
      payload: { enabled: true, groups: [{ id: 'devices', enabled: true, allow_writes: true }] },
    });
    expect(tools.statusCode, tools.body).toBe(200);
    const env = readFileSync(path.join(hub.dataDir, 'hermes', '.env'), 'utf8');
    hubKey = /COREHUB_MCP_TOKEN=(\S+)/.exec(env)![1]!;

    const session = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { agent_id: hermes.id },
    });
    expect(session.statusCode, session.body).toBe(201);
    const sessionId = (session.json() as { id: string }).id;
    const started = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'Make a cut of my trip clips and render it.' }] },
    });
    expect(started.statusCode, started.body).toBe(202);

    let reply: { parts: Array<Record<string, unknown>> } | undefined;
    for (let i = 0; i < 200 && !reply; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const messages = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/messages`,
      });
      const items = (messages.json() as { items: Array<Record<string, unknown>> }).items;
      const last = items.find(
        (m) => m.role === 'assistant' && Array.isArray(m.content) && m.status !== 'streaming',
      );
      const parts = (last?.content ?? []) as Array<Record<string, unknown>>;
      if (parts.some((p) => p.type === 'file')) reply = { parts };
    }

    // What the agent was told at each step.
    expect(seen.map((s) => [s.tool, s.answer.isError])).toEqual(
      expect.arrayContaining([
        ['devices.list', false],
        ['devices.run', false],
        ['devices.run_status', false],
        ['devices.fetch_file', false],
      ]),
    );
    const runs = seen.filter((s) => s.tool === 'devices.run').map((s) => s.answer.body);
    expect(runs[0]).toEqual({ state: 'done', result: 'Created project "Trip".' });
    expect(runs[1].result).toBe('Imported 2 clip(s) into the media pool.');
    expect(runs[2].result).toBe('Created timeline "Trip cut" with 2 clip(s).');
    // The render outlives the device's soft deadline: "running", then followed to the end.
    expect(runs[3]).toMatchObject({ state: 'running' });
    const last = seen.filter((s) => s.tool === 'devices.run_status').at(-1)!.answer.body;
    expect(last.state).toBe('done');
    expect(last.result).toContain('trip.mp4');
    expect(existsSync(path.join(home, 'Core Hub', 'trip.mp4'))).toBe(true);
    const fetched = seen.find((s) => s.tool === 'devices.fetch_file')!.answer.body;
    expect(fetched).toMatchObject({ name: 'trip.mp4', kind: 'video', attached_to_reply: true });

    // The person was asked once, for the program, from the hub.
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      programId: 'davinci-resolve',
      via: 'hub',
      hub: baseUrl,
      profile: 'default',
    });
    // Every call is in the activity list, newest first.
    const listed = computer.activity().map((a) => [a.tool, a.ok, a.via]);
    expect(listed).toEqual(
      expect.arrayContaining([
        ['create_project', true, 'hub'],
        ['import_media', true, 'hub'],
        ['create_timeline', true, 'hub'],
        ['render', true, 'hub'],
        ['send_file', true, 'hub'],
      ]),
    );

    // The chat: the reply carries the video, which plays through a stream with byte ranges.
    expect(reply, 'the reply carries the render').toBeDefined();
    const file = reply!.parts.find((p) => p.type === 'file')!;
    expect(file).toMatchObject({ name: 'trip.mp4', mime: 'video/mp4' });
    const stream = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/attachments/${String(file.attachment_id)}/stream`,
    });
    expect(stream.statusCode, stream.body).toBe(201);
    const url = (stream.json() as { url: string }).url;
    const ranged = await fetch(`${baseUrl}${url}`, { headers: { range: 'bytes=4-11' } });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).toString('latin1')).toBe('ftypisom');
  });
});
