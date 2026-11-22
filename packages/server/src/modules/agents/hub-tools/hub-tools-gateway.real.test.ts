/**
 * The hub's own tools from a hub conversation **attached to the running gateway** on the real
 * Hermes (Hermes v0.22.2 and later), with the hub's hook loaded in that gateway — the way the
 * hub runs it since the 1.1.10 line.
 *
 * On the owner's live hub (2026-11-22) every call a fresh hub chat made was refused as
 * `hub_tools_run_ambiguous`: inside the gateway a hub conversation is a turn like a channel's,
 * the hook reported it (platform `local`, the gateway's local user, `dm`, the Hermes session id),
 * the hub opened a "channel turn of nobody" for it, and that stood beside the run that announced
 * the call. None of the other real suites ran the gateway, the hook and a hub run together.
 *
 * Here the image's `hermes gateway run` serves the hub's own home (the hub wrote the `corehub`
 * block, its key and the hook there), the hub's conversation attaches to it
 * (`adapters/hermes-gateway-channel.ts`), and a scripted model on this machine calls
 * `mcp__corehub__tasks_list`: the call acts for the person whose chat it is. Name the image to
 * run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hub-tools/hub-tools-gateway.real.test.ts
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageHermesVersion } from '../../../../tests/unit/hermes-real.js';
import { authed, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { gatewayTuiChannel, type GatewayBootstrap } from '../adapters/hermes-gateway-channel.js';
import type { TuiChannel } from '../adapters/hermes-tui.js';
import { GATEWAY_BOOTSTRAP_SCRIPT } from '../hermes-gateway-bootstrap.js';
import { hermesManagedEnv } from '../hermes-managed-env.js';
import { compareVersions } from '../update-policy.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HUB_TOOL = 'mcp__corehub__tasks_list';

/** The model: asked for the tasks, it calls the hub's `tasks.list`; then it repeats the answer. */
function scriptedModel(said: string[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }] }));
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as {
        messages?: Array<{ role: string; content: unknown }>;
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? '');
      const last = body.messages?.at(-1);
      let message: Record<string, unknown> = { role: 'assistant', content: 'nothing to do' };
      if (last?.role === 'tool') {
        said.push(String(last.content));
        message = { role: 'assistant', content: 'listed' };
      } else if (JSON.stringify(last?.content ?? '').includes('list my tasks')) {
        // Hermes lists MCP tools on demand behind its bridge once there are enough of them.
        const fn = names.includes(HUB_TOOL)
          ? { name: HUB_TOOL, arguments: '{}' }
          : {
              name: 'tool_call',
              arguments: JSON.stringify({ calls: [{ name: HUB_TOOL, arguments: {} }] }),
            };
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_hub_1', type: 'function', function: fn }],
        };
      }
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      if (body.stream) {
        const chunk = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = message.tool_calls
          ? {
              role: 'assistant',
              tool_calls: (message.tool_calls as Array<Record<string, unknown>>).map((c, i) => ({
                index: i,
                ...c,
              })),
            }
          : message;
        res.write(chunk(delta, null));
        res.write(chunk({}, finish));
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
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      );
    });
  });
}

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe.skipIf(!image)(
  "the hub's own tools from a conversation attached to the real gateway (set COREHUB_HERMES_IMAGE)",
  () => {
    const said: string[] = [];
    let model: http.Server;
    let hub: TestHub & { token: string; userId: string };
    let container = '';
    let channel: TuiChannel | null = null;
    /** What the first bootstrap said: `unsupported` on a Hermes that predates the attach. */
    let first: GatewayBootstrap['kind'] = 'unavailable';

    beforeAll(async () => {
      model = scriptedModel(said);
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const modelPort = (model.address() as AddressInfo).port;
      const { uid, gid } = userInfo();
      let home = '';

      /** Hermes's own bootstrap, in the gateway's container, as the gateway's user. */
      const bootstrap = (): Promise<GatewayBootstrap> =>
        new Promise((resolve) => {
          execFile(
            'docker',
            [
              'exec',
              '-e',
              `HERMES_HOME=${home}`,
              '-e',
              'HOME=/tmp',
              container,
              '/opt/hermes/.venv/bin/python',
              '-c',
              GATEWAY_BOOTSTRAP_SCRIPT,
            ],
            { timeout: 60_000, maxBuffer: 1024 * 1024 },
            (_error, stdout, stderr) => {
              const line = `${stdout}${stderr}`.trim().split('\n').pop() ?? '';
              try {
                resolve(JSON.parse(line) as GatewayBootstrap);
              } catch {
                resolve({ kind: 'unavailable', reason: line });
              }
            },
          );
        });

      hub = await signedInHub(
        {},
        {
          agents: {
            adapterOptions: {
              hermes: {
                fetchImpl: healthy,
                ensureProfile: async () => undefined,
                // The hub's conversations attach to the gateway, as `hermes-runtime.ts` does.
                tui: () => {
                  if (channel?.alive) return channel;
                  channel = gatewayTuiChannel({
                    bootstrap,
                    fallback: () => {
                      throw new Error('this Hermes still has its stdio entry');
                    },
                    readyTimeoutMs: 120_000,
                  });
                  return channel;
                },
              },
            },
          },
        },
      );
      home = path.join(hub.dataDir, 'hermes');
      mkdirSync(home, { recursive: true, mode: 0o700 });
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

      // The tools on: the hub writes the block, the key and the hook into the home.
      const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      const hermes = (agents.json().items as Array<{ id: string; kind: string }>).find(
        (agent) => agent.kind === 'hermes',
      )!.id;
      const on = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes}/hub-tools`,
        payload: { enabled: true },
      });
      expect(on.statusCode, on.body).toBe(200);

      // Then the gateway, which loads the hook as it starts; its API server on a port of its own
      // (a Hermes on this machine may hold the default one).
      const apiPort = await freePort();
      const env = {
        ...hermesManagedEnv({ dataDir: hub.dataDir, role: 'gateway', inherited: {} }),
        HERMES_HOME: home,
        HOME: '/tmp',
        COREHUB_FAKE_KEY: 'fake-key-000000000000',
        API_SERVER_ENABLED: 'true',
        API_SERVER_KEY: randomBytes(16).toString('hex'),
        API_SERVER_HOST: '127.0.0.1',
        API_SERVER_PORT: String(apiPort),
        HERMES_DASHBOARD: '0',
      };
      container = execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--network',
          'host',
          '--user',
          `${uid}:${gid}`,
          '-v',
          `${hub.dataDir}:${hub.dataDir}`,
          ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          '--entrypoint',
          '/opt/hermes/.venv/bin/hermes',
          image!,
          'gateway',
          'run',
        ],
        { encoding: 'utf8' },
      ).trim();

      // Attachable once it says so; up to two minutes on a cold runner.
      let found: GatewayBootstrap = { kind: 'unavailable', reason: 'not asked' };
      for (let i = 0; i < 60 && found.kind === 'unavailable'; i += 1) {
        found = await bootstrap();
        if (found.kind === 'unavailable') await sleep(2000);
      }
      expect(found.kind, JSON.stringify(found)).not.toBe('unavailable');
      first = found.kind;
    }, 300_000);

    afterAll(async () => {
      await channel?.close();
      await hub?.close().catch(() => undefined);
      model?.close();
      if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    });

    it("acts for the person whose chat it is, though the hook reports the chat's turn too", async () => {
      // A Hermes older than the attach (v0.22.2) runs the hub's conversations over stdio, outside
      // the gateway: the hook never sees them (`hub-tools.real.test.ts` covers that one).
      const version = imageHermesVersion(image!);
      expect(version, 'the image says which Hermes it carries').toBeTruthy();
      const attaches = !!version && compareVersions(version, '0.22.2') >= 0;
      expect(first === 'attach', `Hermes ${version}: ${first}`).toBe(attaches);
      if (!attaches) return;
      const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      const hermes = (agents.json().items as Array<{ id: string; kind: string }>).find(
        (agent) => agent.kind === 'hermes',
      )!.id;
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
        payload: { content: [{ type: 'text', text: 'list my tasks, please' }] },
      });
      expect(run.statusCode, run.body).toBe(202);
      const runId = run.json().run_id as string;

      let status = '';
      for (let i = 0; i < 240 && !['succeeded', 'failed', 'cancelled'].includes(status); i += 1) {
        await sleep(500);
        const got = await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/runs/${runId}`,
        });
        status = got.json().status as string;
      }
      expect(status).toBe('succeeded');

      // The tool answered (no refusal), as the chat's owner, in that chat.
      expect(said.length, said.join('\n')).toBeGreaterThan(0);
      expect(said.join('\n')).not.toContain('hub_tools_');
      const card = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${hermes}/hub-tools`,
      });
      expect(card.json().recent_calls[0], card.body).toMatchObject({
        tool: 'tasks.list',
        ok: true,
        user_id: hub.userId,
        session_id: sessionId,
      });
    }, 300_000);
  },
);
