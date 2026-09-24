/**
 * Messaging gateways per profile, and pairing approvals, with **the real Hermes** from the image.
 *
 * 1. Two gateways side by side — the default profile's (`hermes gateway run`, the API server on
 *    its port) and profile «manger»'s (`hermes -p manger gateway run`, started by the hub because
 *    «manger» has a channel switched on) — each with its own pid, lock and state file, neither
 *    refusing the other.
 * 2. Both answer through the owner's custom OpenAI-compatible provider (`majlis-custom-…`), which
 *    their `config.yaml` named **without** its `providers:` block — Hermes's
 *    `Unknown provider` of 2026-09-24 — because the hub writes the block and the model into each
 *    profile right before its gateway starts. A scripted provider on this host answers, and it
 *    sees the key the hub hands every gateway. (To ask «manger»'s gateway at all, this test gives
 *    it an API server on a port of its own; the hub never does.)
 * 3. Hermes's pairing API, in «manger»: two requests Hermes's own `PairingStore` made are listed,
 *    one is approved and revoked through Hermes, the other is denied by the hub's edit of Hermes's
 *    pending file — and the default profile's list stays empty.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   MAJLIS_HERMES_IMAGE=ghcr.io/twuijri/majlis:latest pnpm --filter @majlis/server exec \
 *     vitest run tests/unit/gateways.real.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { capturingLogger, unreachableFetch } from './helpers.js';
import { writeHermesRoute } from '../../src/modules/models/propagation.js';
import {
  HermesDashboard,
  type DashboardSpawner,
} from '../../src/modules/agents/hermes-dashboard.js';
import { readGatewayRecord } from '../../src/modules/agents/hermes-gateways.js';
import {
  approvePairing,
  denyPairing,
  listPairing,
  revokePairing,
} from '../../src/modules/agents/hermes-pairing.js';
import {
  HermesRuntime,
  type SpawnedProcess,
  type Spawner,
} from '../../src/modules/agents/hermes-runtime.js';
import type { HermesApiCall } from '../../src/modules/agents/hermes-tools.js';

const image = process.env.MAJLIS_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const PROVIDER = 'majlis-custom-cli-proxy-api';
const KEY_ENV = 'MAJLIS_CUSTOM_CLI_PROXY_API_API_KEY';
const DEFAULT_PORT = 18642;
const MANGER_PORT = 18643;
const WEBHOOK_PORT = 18644;

describe.skipIf(!image)(
  'messaging gateways per profile (real Hermes; set MAJLIS_HERMES_IMAGE)',
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'majlis-gw-real-data-'));
    // The runtime's own home, mounted at the same path in every container.
    const root = path.join(dataDir, 'hermes');
    const bin = mkdtempSync(path.join(tmpdir(), 'majlis-gw-real-bin-'));
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const containers: string[] = [];
    const seen: Array<{ authorization: string | undefined; model: unknown }> = [];
    let provider: Server;
    let providerPort = 0;
    let runtime: HermesRuntime;
    let dashboard: HermesDashboard;

    /** `docker run` of Hermes as this user, on the host network, the home at the same path. */
    const dockerArgs = (name: string, cwd: string, names: string[]) => [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'host',
      '--user',
      user,
      '-e',
      'HOME=/tmp',
      '-v',
      `${root}:${root}`,
      '-w',
      cwd,
      ...names.flatMap((variable) => ['-e', variable]),
      '--entrypoint',
      HERMES,
      image!,
    ];

    const hermesOnce = (args: string[]) =>
      execFileSync(
        'docker',
        [...dockerArgs(`majlis-gw-once-${process.pid}`, root, ['HERMES_HOME']), ...args],
        {
          env: { ...process.env, HERMES_HOME: root },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

    const python = (code: string) =>
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--user',
          user,
          '-e',
          'HOME=/tmp',
          '-e',
          `HERMES_HOME=${root}`,
          '-v',
          `${root}:${root}`,
          '-w',
          '/opt/hermes/src',
          '--entrypoint',
          '/opt/hermes/.venv/bin/python',
          image!,
          '-c',
          code,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      ).trim();

    /** The hub's gateways, run in the image. «manger» also gets an API server, for this test only. */
    const gatewaySpawn: Spawner = (_command, args, options) => {
      const profile = args[0] === '-p' ? args[1]! : 'default';
      const name = `majlis-gw-real-${process.pid}-${profile}-${containers.length}`;
      containers.push(name);
      const env: NodeJS.ProcessEnv = { ...options.env };
      if (profile !== 'default') {
        env.API_SERVER_KEY = 'm'.repeat(48);
        env.API_SERVER_HOST = '127.0.0.1';
        env.API_SERVER_PORT = String(MANGER_PORT);
      }
      const names = [
        'HERMES_HOME',
        'HERMES_DASHBOARD',
        'PYTHONUNBUFFERED',
        KEY_ENV,
        'API_SERVER_ENABLED',
        'API_SERVER_KEY',
        'API_SERVER_HOST',
        'API_SERVER_PORT',
      ].filter((variable) => env[variable] !== undefined);
      const child = spawn('docker', [...dockerArgs(name, options.cwd, names), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...Object.fromEntries(names.map((n) => [n, env[n]])) },
      });
      return child as unknown as SpawnedProcess;
    };

    const dashboardSpawn: DashboardSpawner = (_command, args, options) => {
      const name = `majlis-gw-real-serve-${process.pid}-${containers.length}`;
      containers.push(name);
      const child = spawn(
        'docker',
        [...dockerArgs(name, root, ['HERMES_HOME', 'HERMES_DASHBOARD_SESSION_TOKEN']), ...args],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HERMES_HOME: root,
            HERMES_DASHBOARD_SESSION_TOKEN: options.env.HERMES_DASHBOARD_SESSION_TOKEN,
          },
        },
      );
      return child as unknown as SpawnedProcess;
    };

    const healthy = async (port: number) => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    };

    const ask = async (port: number, key: string) => {
      const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      const models = (await (
        await fetch(`http://127.0.0.1:${port}/v1/models`, { headers })
      ).json()) as {
        data: Array<{ id: string }>;
      };
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: models.data[0]!.id,
          stream: false,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return {
        status: res.status,
        text: body.choices?.[0]?.message?.content ?? JSON.stringify(body),
      };
    };

    beforeAll(async () => {
      mkdirSync(root, { recursive: true });
      chmodSync(root, 0o777);
      // A scripted OpenAI-compatible endpoint: every chat answers «pong», streamed or not.
      provider = createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => (raw += String(chunk)));
        request.on('end', () => {
          if (request.url?.endsWith('/models')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: [{ id: 'scripted-model', object: 'model' }] }));
            return;
          }
          const body = (raw ? JSON.parse(raw) : {}) as { stream?: boolean; model?: unknown };
          seen.push({ authorization: request.headers.authorization, model: body.model });
          const id = `chatcmpl-${seen.length}`;
          if (body.stream) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            const chunk = (delta: Record<string, unknown>, finish: string | null) =>
              `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'scripted-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            response.write(chunk({ role: 'assistant', content: 'pong' }, null));
            response.write(chunk({}, 'stop'));
            response.end('data: [DONE]\n\n');
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created: 0,
              model: 'scripted-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'pong' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
      providerPort = (provider.address() as { port: number }).port;

      // Hermes's own profile, made by Hermes; then both files name the provider with no block —
      // what a gateway found on 2026-09-24.
      hermesOnce(['profile', 'create', 'manger', '--no-alias']);
      const broken = `model:\n  default: scripted-model\n  provider: ${PROVIDER}\n`;
      writeFileSync(path.join(root, 'config.yaml'), broken);
      writeFileSync(
        path.join(root, 'profiles', 'manger', 'config.yaml'),
        `${broken}platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: ${WEBHOOK_PORT}\n      secret: e2e-webhook-secret\n`,
      );

      // A `hermes` on PATH so the runtime is `managed`; the spawner runs the image instead.
      writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\nexit 0\n');
      chmodSync(path.join(bin, 'hermes'), 0o755);
      const state = {
        credentials: [],
        hermesProviders: [
          {
            name: PROVIDER,
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
            apiMode: 'chat_completions' as const,
            keyEnv: KEY_ENV,
          },
        ],
        hermesModel: { provider: PROVIDER, model: 'scripted-model' },
        hermesModelBlocked: null,
      };
      const { logger } = capturingLogger();
      runtime = new HermesRuntime({
        dataDir,
        host: { pathValue: bin },
        log: logger,
        endpoint: `http://127.0.0.1:${DEFAULT_PORT}`,
        fetchImpl: unreachableFetch,
        spawnImpl: gatewaySpawn,
        healthIntervalMs: 0,
        prepareGateway: (_profile, home) => void writeHermesRoute(home, state),
      });
      runtime.setProviderEnv({ [KEY_ENV]: 'sk-real-test' });

      dashboard = new HermesDashboard({
        host: {
          status: () => ({ mode: 'managed', home: root }),
          executable: () => HERMES,
          cliEnv: () => ({}),
        },
        dataDir,
        log: logger,
        spawnImpl: dashboardSpawn,
        startTimeoutMs: 180_000,
      });
    }, 300_000);

    afterAll(async () => {
      await runtime?.stop();
      await dashboard?.close();
      provider?.close();
      for (const name of containers) {
        try {
          execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
        } catch {
          // already gone with --rm
        }
      }
      for (const dir of [dataDir, bin]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // the OS reclaims the temp dir
        }
      }
    }, 120_000);

    it("runs the default gateway and «manger»'s side by side, each answering through the custom provider", async () => {
      expect(await runtime.start()).toBe('managed');
      await vi.waitFor(
        async () => {
          expect(await healthy(DEFAULT_PORT)).toBe(true);
          expect(await healthy(MANGER_PORT)).toBe(true);
        },
        { timeout: 240_000, interval: 2_000 },
      );
      expect(runtime.gateways().map((gateway) => [gateway.profile, gateway.channels])).toEqual([
        ['default', []],
        ['manger', ['webhook']],
      ]);

      // Each wrote its own state file and holds its own lock: nothing shared, nothing refused.
      await vi.waitFor(
        () => {
          const defaultRecord = readGatewayRecord(root);
          const mangerRecord = readGatewayRecord(path.join(root, 'profiles', 'manger'));
          expect(defaultRecord?.gatewayState).toBe('running');
          expect(mangerRecord?.gatewayState).toBe('running');
          expect(defaultRecord?.pid).not.toBe(mangerRecord?.pid);
        },
        { timeout: 120_000, interval: 2_000 },
      );
      expect(existsSync(path.join(root, 'gateway.lock'))).toBe(true);
      expect(existsSync(path.join(root, 'profiles', 'manger', 'gateway.lock'))).toBe(true);
      // The block the file lacked, written by the hub before each start.
      expect(readFileSync(path.join(root, 'profiles', 'manger', 'config.yaml'), 'utf8')).toContain(
        `${PROVIDER}:`,
      );

      const apiKey = runtime.apiKey()!;
      const fromDefault = await ask(DEFAULT_PORT, apiKey);
      const fromManger = await ask(MANGER_PORT, 'm'.repeat(48));
      expect(fromDefault, JSON.stringify(fromDefault)).toMatchObject({ status: 200 });
      expect(fromManger, JSON.stringify(fromManger)).toMatchObject({ status: 200 });
      expect(fromDefault.text).toContain('pong');
      expect(fromManger.text).toContain('pong');
      // Through the provider the hub named, with the key the hub handed the gateways.
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen.every((request) => request.authorization === 'Bearer sk-real-test')).toBe(true);

      const memory = execFileSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}', ...containers.slice(0, 2)],
        { encoding: 'utf8' },
      ).trim();
      console.log(`gateways side by side:\n${memory}`);
    }, 420_000);

    it("lists, approves, denies and revokes pairing requests in «manger» through Hermes's API", async () => {
      // Two strangers messaged «manger»'s number: Hermes's own store makes their requests.
      python(
        [
          'from gateway.pairing import PairingStore',
          "s = PairingStore(profile='manger')",
          "print(s.generate_code('whatsapp', '966500000001@s.whatsapp.net', 'Sara'))",
          "print(s.generate_code('whatsapp', '966500000002@s.whatsapp.net', 'Omar'))",
        ].join('\n'),
      );
      const api: HermesApiCall = (method, route, body, options) =>
        dashboard.request(method, route, body, options);

      const listed = await listPairing(api, 'manger');
      expect(listed.pending.map((request) => request.user_name).sort()).toEqual(['Omar', 'Sara']);
      expect(listed.pending.every((request) => /^[0-9a-f]{16}$/.test(request.request_id))).toBe(
        true,
      );
      // Scoped: the default profile has none of them.
      expect((await listPairing(api, 'default')).pending).toEqual([]);

      const sara = listed.pending.find((request) => request.user_name === 'Sara')!;
      const omar = listed.pending.find((request) => request.user_name === 'Omar')!;
      const approved = await approvePairing(api, {
        profile: 'manger',
        platform: 'whatsapp',
        requestId: sara.request_id,
      });
      expect(approved).toMatchObject({ user_id: '966500000001@s.whatsapp.net', user_name: 'Sara' });

      // Deny: the hub's edit of Hermes's pending file, seen by Hermes's next list.
      denyPairing(path.join(root, 'profiles', 'manger'), 'whatsapp', omar.request_id);
      const after = await listPairing(api, 'manger');
      expect(after.pending).toEqual([]);
      expect(after.approved.map((sender) => sender.user_id)).toEqual([
        '966500000001@s.whatsapp.net',
      ]);
      // Hermes itself agrees: its store says Sara may talk, and Omar still may not.
      expect(
        python(
          [
            'from gateway.pairing import PairingStore',
            "s = PairingStore(profile='manger')",
            "print(s.is_approved('whatsapp', '966500000001@s.whatsapp.net'), s.is_approved('whatsapp', '966500000002@s.whatsapp.net'))",
          ].join('\n'),
        ),
      ).toBe('True False');

      await revokePairing(api, {
        profile: 'manger',
        platform: 'whatsapp',
        userId: '966500000001@s.whatsapp.net',
      });
      expect((await listPairing(api, 'manger')).approved).toEqual([]);
      await expect(
        approvePairing(api, {
          profile: 'manger',
          platform: 'whatsapp',
          requestId: sara.request_id,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    }, 420_000);
  },
);
