/**
 * The hub's providers reach every Hermes profile — with the real Hermes (contract decision
 * §34, ADR 0010, ADR 0014 stage 3).
 *
 * One provider is added once, through the hub's own API, as a person adds it. Then, in one
 * `python -m tui_gateway.entry` from the image that holds the key **only in its process
 * environment**, as the hub hands it over:
 *
 * - a profile made from scratch **after** the provider was added — no model, no key, no
 *   endpoint of its own — answers once the hub has prepared it (what it does before each
 *   turn in a named profile);
 * - a profile made as a copy of `default` keeps a copy of the root `.env`, and Hermes reads a
 *   profile's `.env` before the environment: left alone it still sends the key from before the
 *   key was changed (the control). Prepared by the hub, it sends the current key.
 *
 * The model on this machine answers with the bearer token it received, so the test sees
 * exactly which key Hermes used.
 *
 *   MAJLIS_HERMES_IMAGE=majlis:local npx vitest run --maxWorkers=1 providers-shared.real
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { createHermesProfiles, type ProfileRunner } from '../hermes-profiles.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';
import { modelsServiceFor, parseEnv } from '../../models/index.js';

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

describe.skipIf(!image)('the hub providers in every Hermes profile (real Hermes)', () => {
  let model: http.Server;
  let home: string;
  let hub: TestHub & { token: string };
  let channel: TuiChannel;
  let processEnv: Record<string, string> = {};
  let providerName = '';
  let keyEnv = '';
  const known: string[] = [];

  const docker = (args: string[], stdin?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile('docker', args, { timeout: 180_000 }, (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
      );
      if (stdin !== undefined) child.stdin!.end(stdin);
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

  beforeAll(async () => {
    model = keyReportingModel();
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as AddressInfo).port;
    home = mkdtempSync(path.join(tmpdir(), 'majlis-shared-providers-'));
    chmodSync(home, 0o777);

    hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: globalThis.fetch,
          restartDelayMs: 0,
          hermes: {
            home: () => home,
            // Only the profiles the hub already knew at a save; one made later is prepared
            // before its turn instead.
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

    // 1. The provider, added once, with the key it had then.
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: {
        label: 'fake',
        kind: 'llm',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: 'key-before-change',
        api_mode: 'chat_completions',
      },
    });
    expect(created.statusCode).toBe(201);
    const providerId = (created.json() as { id: string }).id;
    await drainJobs(hub.app);
    const rootEnv = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
    keyEnv = [...rootEnv.entries()].find(([, value]) => value === 'key-before-change')![0];
    const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    providerName = /provider: (majlis-[a-z0-9-]+)/.exec(config)![1]!;

    hostOpen();
    // 2. Two profiles made by Hermes while that key was current: a copy of `default` (it
    //    carries a copy of the root `.env`) and the control, made the same way.
    const profiles = createHermesProfiles({ home, run: hermes });
    await profiles.create('copied', { kind: 'clone', source: 'default' });
    await profiles.create('control', { kind: 'clone', source: 'default' });
    await openUp();
    known.push(profileHome('copied'));

    // 3. The key changes, in the hub, from the default profile.
    const changed = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${providerId}`,
      payload: { api_key: 'key-after-change' },
    });
    expect(changed.statusCode).toBe(200);
    await drainJobs(hub.app);
    expect(processEnv[keyEnv]).toBe('key-after-change');
    hostOpen();

    // 4. A profile made from scratch after all of that: nothing of its own.
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
        // The key in the process environment only, as the hub hands it over.
        '-e',
        `${keyEnv}=${processEnv[keyEnv]}`,
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

  async function ask(profile: string): Promise<string> {
    const session = await HermesTuiSession.open(channel, null, {
      profile,
      model: 'fake-1',
      provider: providerName,
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
    expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
    return events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
  }

  it('a profile made after the provider was added runs a turn on it once prepared', async () => {
    modelsServiceFor(hub.app).prepareProfile(profileHome('later'));
    hostOpen();
    const config = readFileSync(path.join(profileHome('later'), 'config.yaml'), 'utf8');
    expect(config).toContain(`${providerName}:`);
    expect(await ask('later')).toContain('key=key-after-change');
  }, 240_000);

  it("a copy of default left alone still sends the old key; the hub's copy sends the current one", async () => {
    // The control: Hermes reads the profile's own `.env` before the process environment.
    expect(
      parseEnv(readFileSync(path.join(profileHome('control'), '.env'), 'utf8')).get(keyEnv),
    ).toBe('key-before-change');
    expect(await ask('control')).toContain('key=key-before-change');

    // The profile the hub knew at the save: its copy of the key was taken out then.
    expect(
      parseEnv(readFileSync(path.join(profileHome('copied'), '.env'), 'utf8')).has(keyEnv),
    ).toBe(false);
    expect(await ask('copied')).toContain('key=key-after-change');

    // And the control, prepared the way every named profile is before its turn.
    modelsServiceFor(hub.app).prepareProfile(profileHome('control'));
    hostOpen();
    expect(await ask('control')).toContain('key=key-after-change');
  }, 300_000);
});
