/**
 * Incoming webhooks against **the real Hermes** from the image (contract decision §97).
 *
 * The whole path an outside service takes: the hub writes a route with its prompt through
 * `agents.createWebhook` (the route in `webhook_subscriptions.json`, the listener switched on in
 * `config.yaml`), the image's own `hermes gateway run` listens, and a POST signed with the route's
 * secret reaches **the hub's public door** (`/api/v1/hermes-webhooks/default/<route>`), which passes
 * it to Hermes. Hermes answers `202 accepted` and runs the agent with the route's prompt, the
 * posted values filled in — the scripted model here sees that prompt. A POST with a wrong
 * signature is refused by Hermes, in the hub's envelope; `agents.testWebhook` is accepted too.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hermes-webhooks.real.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

const image = process.env.COREHUB_HERMES_IMAGE;

/** A model that answers every turn with one sentence, and keeps what it was asked. */
function scriptedModel(asked: string[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { stream?: boolean; messages?: unknown }) : {};
      asked.push(JSON.stringify(body.messages ?? []));
      const reply = 'Noted: the deploy is green.';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
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
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

describe.skipIf(!image)(
  'Hermes incoming webhooks (real Hermes gateway; set COREHUB_HERMES_IMAGE)',
  () => {
    const asked: string[] = [];
    let model: http.Server;
    let hub: TestHub & { token: string; userId: string };
    let gateway: ChildProcess | null = null;
    let agent = '';
    let route: { name: string; secret: string; path: string };
    let port = 0;
    const log: string[] = [];
    const container = `corehub-webhooks-real-${process.pid}`;

    beforeAll(async () => {
      model = scriptedModel(asked);
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const modelPort = (model.address() as AddressInfo).port;
      hub = await signedInHub(
        {},
        {
          agents: {
            adapterOptions: {
              hermes: {
                // A gateway that answers its probe: the runtime is `external` and has a home.
                fetchImpl: async () =>
                  new Response('{"status":"ok"}', {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  }),
                ensureProfile: async () => undefined,
              },
            },
          },
        },
      );
      const home = path.join(hub.dataDir, 'hermes');
      mkdirSync(home, { recursive: true });
      chmodSync(hub.dataDir, 0o777);
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
      const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      agent = (agents.json().items as Array<{ id: string; kind: string }>).find(
        (entry) => entry.kind === 'hermes',
      )!.id;

      // The route, through the hub, before the gateway starts: the listener is switched on too.
      const made = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${agent}/webhooks`,
        payload: { name: 'deploys', prompt: 'Deploy of {repo.name} finished: {status}. Say so.' },
      });
      expect(made.statusCode, made.body).toBe(201);
      route = made.json() as typeof route;
      const listed = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${agent}/webhooks`,
      });
      port = (listed.json() as { listener: { port: number } }).listener.port;

      const { uid, gid } = userInfo();
      gateway = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          container,
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
          'COREHUB_FAKE_KEY=fake-key-000000000000',
          '-e',
          'COREHUB_MCP_ORIGIN=gateway',
          '-e',
          'HERMES_DASHBOARD=0',
          '-e',
          'PYTHONUNBUFFERED=1',
          '--entrypoint',
          '/opt/hermes/.venv/bin/hermes',
          image!,
          'gateway',
          'run',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [gateway.stdout, gateway.stderr]) {
        stream?.on('data', (chunk: Buffer) => log.push(...chunk.toString().split('\n')));
      }
      // Ready when Hermes's listener answers its health check, on the port the hub gave it.
      let healthy = false;
      for (let i = 0; i < 240 && !healthy; i += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          healthy = res.ok;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      expect(healthy, log.slice(-60).join('\n')).toBe(true);
    }, 180_000);

    afterAll(async () => {
      try {
        execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
      } catch {
        // gone with --rm
      }
      gateway?.kill();
      await hub?.close().catch(() => undefined);
      model?.close();
      try {
        rmSync(hub?.dataDir ?? '', { recursive: true, force: true });
      } catch {
        // a temp directory
      }
    });

    it('a signed POST to the hub reaches Hermes, which runs the agent with the route’s prompt', async () => {
      const hint = () => `${asked.join('\n')}\n---\n${log.slice(-80).join('\n')}`;
      const body = JSON.stringify({ repo: { name: 'core-hub' }, status: 'green' });
      const signature = `sha256=${createHmac('sha256', route.secret).update(body).digest('hex')}`;
      const received = await hub.app.inject({
        method: 'POST',
        url: route.path,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-event': 'deployment_status',
          'x-github-delivery': `real-${Date.now()}`,
        },
        payload: body,
      });
      expect(received.statusCode, `${received.body}\n${hint()}`).toBe(202);
      expect(received.json()).toMatchObject({ status: 'accepted', route: 'deploys' });

      // The agent ran: the model was asked the route's prompt with the posted values in it.
      const until = Date.now() + 150_000;
      while (
        Date.now() < until &&
        !asked.some((m) => m.includes('Deploy of core-hub finished: green'))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(
        asked.some((m) => m.includes('Deploy of core-hub finished: green')),
        hint(),
      ).toBe(true);

      // A wrong signature is Hermes's refusal, in the hub's envelope.
      const forged = await hub.app.inject({
        method: 'POST',
        url: route.path,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=0000',
          'x-github-event': 'deployment_status',
        },
        payload: body,
      });
      expect(forged.statusCode).toBe(401);
      expect(forged.json()).toMatchObject({
        code: 'unauthorized',
        details: { reason: 'hermes_refused', hermes_status: 401 },
      });

      // The page's Test button: accepted by the same listener.
      const tested = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${agent}/webhooks/deploys/test`,
      });
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json()).toMatchObject({
        status: 202,
        body: { status: 'accepted', event: 'test' },
      });
    }, 200_000);
  },
);
