// `cloudflared` as the app's child (DECISIONS §92), against a stand-in that behaves like it: the
// token only in TUNNEL_TOKEN, connected from its readiness endpoint, the dashboard's routes read
// from its log, a refused token not retried, a crash restarted, and stop that ends it.
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Tunnel } from '../../src/main/tunnel.js';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-cloudflared.mjs',
);

const tunnels: Tunnel[] = [];
afterEach(async () => {
  while (tunnels.length > 0) await tunnels.pop()!.stop();
});

function fake(token: string, extra: { restartDelaysMs?: number[] } = {}) {
  const report = path.join(mkdtempSync(path.join(os.tmpdir(), 'corehub-cf-')), 'report.jsonl');
  const changes: number[] = [];
  const tunnel = new Tunnel({
    program: '/opt/cloudflared/cloudflared',
    token,
    onChange: () => changes.push(Date.now()),
    pollMs: 30,
    stopGraceMs: 1_000,
    env: { ...process.env, FAKE_CLOUDFLARED_REPORT: report },
    // Node plays cloudflared: the program path is replaced, its arguments are not.
    spawnImpl: (_program: string, args: string[], options: SpawnOptions) =>
      spawn(process.execPath, [fixture, ...args], options),
    ...extra,
  });
  tunnels.push(tunnel);
  const runs = () =>
    readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; token: string; output: string; pid: number },
      );
  return { tunnel, runs, changes };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const TOKEN = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel', s: 'secret' })).toString(
  'base64',
);

describe('cloudflared as a child', () => {
  it('runs with the token in its environment only, connects, and reports the routes', async () => {
    const { tunnel, runs } = fake(TOKEN);
    await tunnel.start();
    await until(() => tunnel.connected);
    await until(() => tunnel.routes.length > 0);
    const [run] = runs();
    expect(run!.token).toBe(TOKEN);
    expect(run!.output).toBe('json');
    expect(run!.args.slice(0, 3)).toEqual(['tunnel', '--no-autoupdate', '--metrics']);
    expect(run!.args.at(-1)).toBe('run');
    expect(run!.args.join(' ')).not.toContain(TOKEN);
    expect(tunnel.routes).toEqual([
      { hostname: 'hub.example.com', service: 'http://localhost:47113' },
    ]);
    expect(tunnel.connectedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(tunnel.error).toBeNull();
  });

  it('stops it when asked, and it stays stopped', async () => {
    const { tunnel, runs } = fake(TOKEN);
    await tunnel.start();
    await until(() => tunnel.connected);
    const pid = runs()[0]!.pid;
    await tunnel.stop();
    expect(tunnel.connected).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs()).toHaveLength(1);
  });

  it('does not retry a token Cloudflare refuses', async () => {
    const { tunnel, runs } = fake('bad-token-value', { restartDelaysMs: [20] });
    await tunnel.start();
    await until(() => tunnel.error !== null);
    expect(tunnel.error).toEqual({
      code: 'token_invalid',
      detail: 'Provided Tunnel token is not valid.',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runs()).toHaveLength(1);
  });

  it('starts it again after a crash, and never shows the token in the error', async () => {
    const crashing = `crash-${TOKEN}`;
    const { tunnel, runs } = fake(crashing, { restartDelaysMs: [30] });
    await tunnel.start();
    await until(() => tunnel.error?.code === 'tunnel_exited');
    expect(tunnel.error?.detail).toContain('lost the connection');
    expect(tunnel.error?.detail).not.toContain(crashing);
    await until(() => runs().length >= 2);
  });
});
