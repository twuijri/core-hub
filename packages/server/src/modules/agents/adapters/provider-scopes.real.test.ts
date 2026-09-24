/**
 * The two provider scopes in real Hermes profiles (contract decision §37, ADR 0010, ADR 0014
 * stage 3).
 *
 * Providers are added through the hub's own API, as a person adds them: LM Studio **shared**
 * (every profile) and again as the Design profile's **own** (its own subscription), and
 * LiteLLM as the default profile's own. One `python -m tui_gateway.entry` from the image
 * serves every profile with the environment the hub hands it (the root's keys). The model on
 * this machine answers with the bearer token it received, so the test sees exactly which key
 * Hermes used:
 *
 * - Design uses its own key — its `.env`, which Hermes reads before the environment;
 * - Finance and the default profile use the shared key;
 * - Finance never falls back on the default profile's own LiteLLM key, although Hermes loads
 *   the root `.env` (where that key lives) into its environment;
 * - a profile made from scratch after all of that, prepared as before each turn, uses the
 *   shared key at once.
 *
 *   MAJLIS_HERMES_IMAGE=majlis:local npx vitest run --maxWorkers=1 provider-scopes.real
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { createHermesProfiles, type ProfileRunner } from '../hermes-profiles.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';
import { modelsServiceFor } from '../../models/index.js';

const image = process.env.MAJLIS_HERMES_IMAGE;

/** The model: lists one model, and answers every chat with the bearer token it was sent. */
function keyReportingModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }] }));
        return;
      }
      const body = raw ? (JSON.parse(raw) as { stream?: boolean }) : {};
      const reply = `key=${bearer || 'none'}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of [{ role: 'assistant', content: reply }, {}]) {
          res.write(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] })}\n\n`,
          );
        }
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

describe.skipIf(!image)('provider scopes in real Hermes profiles', () => {
  let model: http.Server;
  let home: string;
  let hub: TestHub & { token: string };
  let channel: TuiChannel;
  let processEnv: Record<string, string> = {};
  const known: string[] = [];

  const docker = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile('docker', args, { timeout: 180_000 }, (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
      );
    });

  const hermes: ProfileRunner = (argv) =>
    docker([
      'run',
      '--rm',
      '-v',
      `${home}:/hh`,
      '-e',
      'HERMES_HOME=/hh',
      '--entrypoint',
      '/opt/hermes/.venv/bin/hermes',
      image!,
      ...argv,
    ]);

  /** The profile folders Hermes made are its user's; let the hub (this user) write them. */
  const openUp = () =>
    docker([
      'run',
      '--rm',
      '-v',
      `${home}:/hh`,
      '--entrypoint',
      'chmod',
      image!,
      '-R',
      'a+rwX',
      '/hh',
    ]);

  const profileHome = (name: string) => path.join(home, 'profiles', name);

  /**
   * The files the hub wrote are this user's, mode 0600; in the image the hub and Hermes are
   * one user, here they are two. Open them to the container's user (test harness only).
   */
  const hostOpen = (dir: string = home) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        const stat = statSync(file);
        if (stat.uid === process.getuid?.()) chmodSync(file, stat.isDirectory() ? 0o777 : 0o666);
        if (stat.isDirectory()) hostOpen(file);
      } catch {
        // the container's own files; `openUp` handles those
      }
    }
  };

  const add = async (profile: string, body: Record<string, unknown>) => {
    const res = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      profile,
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(201);
  };

  beforeAll(async () => {
    model = keyReportingModel();
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1`;
    home = mkdtempSync(path.join(tmpdir(), 'majlis-provider-scopes-'));
    chmodSync(home, 0o777);

    hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: globalThis.fetch,
          restartDelayMs: 0,
          hermes: {
            home: () => home,
            profileHomes: () => [...known],
            restart: () => Promise.resolve(true),
            applyEnvironment: (env) => {
              processEnv = { ...env };
              return true;
            },
          },
        },
      },
    );

    // Hermes makes the two profiles; the hub has a workspace of each name.
    const profiles = createHermesProfiles({ home, run: hermes });
    for (const name of ['design', 'finance']) {
      hostOpen();
      await profiles.create(name, { kind: 'blank' });
      const made = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: name, name },
      });
      expect(made.statusCode).toBe(201);
      known.push(profileHome(name));
    }
    await openUp();

    // Shared LM Studio; Design's own LM Studio (its own key); the default profile's own LiteLLM.
    await add('default', {
      preset: 'lmstudio',
      label: 'LM Studio',
      kind: 'llm',
      base_url: url,
      api_key: 'key-shared-000000',
    });
    await add('design', {
      preset: 'lmstudio',
      label: 'LM Studio',
      kind: 'llm',
      base_url: url,
      api_key: 'key-design-000000',
      scope: 'profile',
    });
    await add('default', {
      preset: 'litellm',
      label: 'LiteLLM',
      kind: 'llm',
      base_url: url,
      api_key: 'key-default-own-0000',
      scope: 'profile',
    });
    await drainJobs(hub.app);

    // A profile made from scratch after all of that.
    hostOpen();
    await profiles.create('later', { kind: 'blank' });
    await openUp();
    hostOpen();

    channel = stdioTuiChannel({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '-v',
        `${home}:/hh`,
        '-e',
        'HERMES_HOME=/hh',
        // The environment the hub hands the gateway.
        ...Object.entries(processEnv).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--entrypoint',
        '/opt/hermes/.venv/bin/python',
        image!,
        '-m',
        'tui_gateway.entry',
      ],
      env: process.env,
      readyTimeoutMs: 120_000,
    });
  }, 600_000);

  afterAll(async () => {
    await channel?.close();
    await hub?.close();
    model?.close();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // partly written by the container's user; the OS reclaims the temp dir
    }
  });

  /** One turn; the reply, or `failed: …` when Hermes refused it. */
  async function ask(profile: string | null, provider: string): Promise<string> {
    const session = await HermesTuiSession.open(channel, null, {
      profile,
      model: 'fake-1',
      provider,
    });
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') return;
      }
    })();
    await session.send({ text: 'which key?' });
    await reading;
    await session.close();
    const last = events.at(-1);
    if (last?.type === 'run.failed') return `failed: ${JSON.stringify(last)}`;
    return events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
  }

  it('Design uses its own key; Finance and the default profile the shared one', async () => {
    expect(await ask('design', 'majlis-lmstudio')).toContain('key=key-design-000000');
    expect(await ask('finance', 'majlis-lmstudio')).toContain('key=key-shared-000000');
    expect(await ask(null, 'majlis-lmstudio')).toContain('key=key-shared-000000');
  }, 300_000);

  it("Finance never falls back on the default profile's own key; the default profile uses it", async () => {
    expect(await ask(null, 'majlis-litellm')).toContain('key=key-default-own-0000');
    const finance = await ask('finance', 'majlis-litellm');
    expect(finance).not.toContain('key-default-own-0000');
  }, 300_000);

  it('a profile made later uses the shared provider as soon as it is prepared', async () => {
    modelsServiceFor(hub.app).prepareProfile(profileHome('later'));
    hostOpen();
    expect(await ask('later', 'majlis-lmstudio')).toContain('key=key-shared-000000');
  }, 240_000);
});
