/**
 * An installed agent signing in to its own vendor account by device code (catalog `signIn`):
 * the link and code are read from what the CLI prints (Kimi Code's and Grok Build's own words,
 * as observed on 2.1.1 and 1.0.41), and the sign-in's state follows the process.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, fakeInstaller, signedInHub } from '../../../tests/unit/helpers.js';
import { AgentSignIns, parseDeviceCode, type SpawnSignIn } from './agent-sign-in.js';

// What `kimi login --region global` printed on 2.1.1 (stderr), and `grok login --device-auth`
// on 1.0.41 (with its ANSI colour), on 2026-09-26.
const KIMI = [
  '',
  'Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=RL0S-YSZ9',
  'If the browser did not open, paste the URL above and enter code: RL0S-YSZ9',
  'Code expires in 1800s.',
  'Waiting for authorization to complete…',
  '',
].join('\n');
const GROK = [
  '',
  'To sign in, open this URL in your browser:',
  '',
  '  https://accounts.x.ai/oauth2/device?user_code=8AAG-3A6K',
  '',
  'Confirm this code in your browser:',
  '',
  '  8AAG-3A6K',
  '',
  "\u001b[90mOnly continue with a code you requested. Don't share it with anyone.\u001b[0m",
  '',
  'Waiting for authorization...',
  '',
].join('\n');

describe('agent sign-in: reading the device code', () => {
  it("reads Kimi Code's and Grok Build's link, code and lifetime", () => {
    expect(parseDeviceCode(KIMI)).toEqual({
      url: 'https://www.kimi.ai/code/authorize_device?user_code=RL0S-YSZ9',
      userCode: 'RL0S-YSZ9',
      expiresIn: 1800,
    });
    expect(parseDeviceCode(GROK)).toEqual({
      url: 'https://accounts.x.ai/oauth2/device?user_code=8AAG-3A6K',
      userCode: '8AAG-3A6K',
      expiresIn: null,
    });
  });

  it('takes a code printed after "code:" when the link carries none, and no http link at all', () => {
    expect(parseDeviceCode('Open https://example.org/device and enter code: ABCD-1234')).toEqual({
      url: 'https://example.org/device',
      userCode: 'ABCD-1234',
      expiresIn: null,
    });
    expect(parseDeviceCode('Open http://example.org/device, code: ABCD-1234')).toBeNull();
    expect(parseDeviceCode('Waiting…')).toBeNull();
  });
});

/**
 * A stand-in CLI: prints `prompt`, then waits for a file to appear and exits with the code
 * written in it (and prints what the file says after the code, as a CLI's last words).
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCli(prompt: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-signin-'));
  dirs.push(dir);
  const outcome = path.join(dir, 'outcome');
  const program = `
    process.stderr.write(${JSON.stringify(prompt)});
    const fs = require('node:fs');
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(outcome)})) return;
      clearInterval(timer);
      const [code, ...words] = fs.readFileSync(${JSON.stringify(outcome)}, 'utf8').split(' ');
      if (words.length) process.stderr.write(words.join(' ') + '\\n');
      process.exit(Number(code));
    }, 20);
  `;
  const argv = [process.execPath, '-e', program];
  return {
    argv,
    finish: (text: string) => writeFileSync(outcome, text),
  };
}

async function until<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

describe('agent sign-in: following the process', () => {
  it('is pending while the CLI waits and approved when it exits 0', async () => {
    const store = new AgentSignIns();
    const cli = fakeCli(KIMI);
    const started = await store.start('agent-1', cli.argv, process.env);
    expect(started).toMatchObject({
      status: 'pending',
      user_code: 'RL0S-YSZ9',
      verification_url: 'https://www.kimi.ai/code/authorize_device?user_code=RL0S-YSZ9',
      accepts_code: false,
      error: null,
    });
    expect(store.get('agent-1', started.id).status).toBe('pending');
    cli.finish('0');
    const done = await until(
      () => store.get('agent-1', started.id),
      (view) => view.status !== 'pending',
    );
    expect(done.status).toBe('approved');
    store.close();
  });

  it('is denied when the CLI reports a refusal, failed with its last line otherwise', async () => {
    const store = new AgentSignIns();
    const denied = fakeCli(KIMI);
    const first = await store.start('agent-1', denied.argv, process.env);
    denied.finish('1 Login cancelled: access_denied');
    expect(
      await until(
        () => store.get('agent-1', first.id),
        (view) => view.status !== 'pending',
      ),
    ).toMatchObject({ status: 'denied', error: 'Login cancelled: access_denied' });

    const failed = fakeCli(GROK);
    const second = await store.start('agent-2', failed.argv, process.env);
    failed.finish('2 Login failed: network unreachable');
    expect(
      await until(
        () => store.get('agent-2', second.id),
        (view) => view.status !== 'pending',
      ),
    ).toMatchObject({ status: 'failed', error: 'Login failed: network unreachable' });
    store.close();
  });

  it('expires a code that ran out and stops the CLI', async () => {
    let clock = 1_000_000;
    const store = new AgentSignIns({ now: () => clock });
    const cli = fakeCli(GROK);
    const started = await store.start('agent-1', cli.argv, process.env);
    clock += 901_000;
    expect(store.get('agent-1', started.id).status).toBe('expired');
    store.close();
  });

  it('refuses a CLI that ends before it gives a link, and one that never prints one', async () => {
    const store = new AgentSignIns({ promptTimeoutMs: 300 });
    await expect(
      store.start(
        'agent-1',
        [
          process.execPath,
          '-e',
          'process.stderr.write("Not logged in: no network\\n"); process.exit(3)',
        ],
        process.env,
      ),
    ).rejects.toMatchObject({ code: 'agent_error', message: 'Not logged in: no network' });
    await expect(
      store.start('agent-1', [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], process.env),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    store.close();
  });

  it('keeps one sign-in per agent: starting again forgets the one before', async () => {
    const store = new AgentSignIns();
    const first = await store.start('agent-1', fakeCli(KIMI).argv, process.env);
    const second = await store.start('agent-1', fakeCli(KIMI).argv, process.env);
    expect(() => store.get('agent-1', first.id)).toThrow();
    expect(store.get('agent-1', second.id).status).toBe('pending');
    // Another agent's id does not reach it.
    expect(() => store.get('agent-2', second.id)).toThrow();
    store.close();
  });
});

describe('agent sign-in: through the hub', () => {
  it('starts the catalog command of an installed agent, and polls it; refuses the others', async () => {
    const argvSeen: string[][] = [];
    const cli = fakeCli(KIMI);
    const spawnImpl: SpawnSignIn = (command, args, options) => {
      argvSeen.push([command, ...args]);
      const [node, ...rest] = cli.argv;
      return spawn(node!, rest, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const hub = await signedInHub(
      {},
      { agents: { installer: fakeInstaller(), signIn: { spawnImpl } } },
    );
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string; install: { sign_in?: boolean } }[];
        }
      ).items;
      const kimi = items.find((item) => item.slug === 'kimi-code')!;
      const codex = items.find((item) => item.slug === 'codex')!;
      expect(kimi.install.sign_in).toBe(true);
      expect(items.find((item) => item.slug === 'grok-build')!.install.sign_in).toBe(true);
      expect(codex.install.sign_in).toBeUndefined();

      // Not installed yet: nothing to run.
      const early = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${kimi.id}/sign-in`,
      });
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ details: { reason: 'not_installed' } });

      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/agents/${kimi.id}/install` });
      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/agents/${codex.id}/install` });
      await drainJobs(hub.app);

      const unsupported = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${codex.id}/sign-in`,
      });
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json()).toMatchObject({ details: { reason: 'sign_in_unsupported' } });

      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${kimi.id}/sign-in`,
      });
      expect(started.statusCode).toBe(201);
      const body = started.json() as { id: string; user_code: string; status: string };
      expect(body).toMatchObject({ status: 'pending', user_code: 'RL0S-YSZ9' });
      expect(argvSeen).toEqual([
        ['/tmp/corehub-test-agents/kimi-code/bin/kimi', 'login', '--region', 'global'],
      ]);

      cli.finish('0');
      let polled: { code: number; view: { status: string } } | null = null;
      for (let i = 0; i < 100 && !polled; i += 1) {
        const response = await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/agents/${kimi.id}/sign-in/${body.id}`,
        });
        const view = response.json() as { status: string };
        if (view.status !== 'pending') polled = { code: response.statusCode, view };
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(polled).toEqual({ code: 200, view: expect.objectContaining({ status: 'approved' }) });

      const gone = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${kimi.id}/sign-in/01J8QK3ZR2W7M5N4P6T8V9X0SN`,
      });
      expect(gone.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  }, 30_000);
});
