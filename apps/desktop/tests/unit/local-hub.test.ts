// Supervising the embedded hub: its port, its data folder, its failures, its stop.
import { fork, type ForkOptions } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalHubError, startLocalHub } from '../../src/main/local-hub.js';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-hub.mjs');
const dataDir = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'corehub-local-')), 'hub');
// Node plays Electron's Node here: ELECTRON_RUN_AS_NODE means nothing to it.
const forkImpl = (module: string, args: string[], options: ForkOptions) =>
  fork(module, args, { ...options, execPath: process.execPath });

describe('local hub', () => {
  it('starts on the port it reports, with its data folder and the given PATH', async () => {
    const dir = dataDir();
    const lines: string[] = [];
    const hub = await startLocalHub({
      entry,
      dataDir: dir,
      pathEnv: '/opt/hermes/bin:/usr/bin',
      env: { FAKE_HUB_MODE: 'ok' },
      onLog: (line) => lines.push(line),
      forkImpl,
    });
    expect(hub.origin).toBe('http://127.0.0.1:45678');
    expect(existsSync(dir)).toBe(true);
    await hub.stop();
    expect(lines.join('\n')).toContain(`in ${dir} with PATH /opt/hermes/bin:/usr/bin`);
  });

  it('fails with the hub’s last words when it exits before listening', async () => {
    const error = await startLocalHub({
      entry,
      dataDir: dataDir(),
      pathEnv: '',
      env: { FAKE_HUB_MODE: 'crash' },
      forkImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalHubError);
    expect((error as LocalHubError).message).toContain('exit 3');
    expect((error as LocalHubError).log.join('\n')).toContain('cannot open the database');
  });

  it('gives up on a hub that never says it is listening', async () => {
    const error = await startLocalHub({
      entry,
      dataDir: dataDir(),
      pathEnv: '',
      env: { FAKE_HUB_MODE: 'silent' },
      startTimeoutMs: 300,
      stopGraceMs: 200,
      forkImpl,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('did not start in time');
  });

  it('kills a hub that ignores SIGTERM after the grace period', async () => {
    const hub = await startLocalHub({
      entry,
      dataDir: dataDir(),
      pathEnv: '',
      env: { FAKE_HUB_MODE: 'stubborn' },
      stopGraceMs: 200,
      forkImpl,
    });
    const started = Date.now();
    await hub.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('asks for the port used last, and carries the way-in questions both ways', async () => {
    const lines: string[] = [];
    const asked: unknown[] = [];
    let reply: ((message: unknown) => void) | null = null;
    const hub = await startLocalHub({
      entry,
      dataDir: dataDir(),
      pathEnv: '',
      env: { FAKE_HUB_MODE: 'relay' },
      preferredPort: 47113,
      onLog: (line) => lines.push(line),
      onMessage: (message) => {
        asked.push(message);
        reply?.(message);
      },
      forkImpl,
    });
    expect(hub.port).toBe(47113);
    const state = {
      enabled: true,
      connected: true,
      route: 'cloudflare' as const,
      relay_url: 'https://hub.example.com',
      hub_port: 47113,
      token_set: true,
      tunnel_id: 't',
      hostname: 'hub.example.com',
      hostnames: [],
      tailnet: null,
      error: null,
      error_detail: null,
      connected_at: null,
    };
    reply = () => hub.send({ type: 'relay-answer', id: 7, ok: true, state });
    // The question may have come before `reply` was set: answer it now as well.
    if (asked.length > 0) hub.send({ type: 'relay-answer', id: 7, ok: true, state });
    hub.send({ type: 'relay-state', state });
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !(
        lines.some((l) => l.includes('relay answer 7 connected=true')) &&
        lines.some((l) => l.includes('relay state url=https://hub.example.com'))
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    await hub.stop();
    expect(asked).toContainEqual({ type: 'relay', id: 7, op: 'get' });
    expect(lines.join('\n')).toContain('relay answer 7 connected=true');
    expect(lines.join('\n')).toContain('relay state url=https://hub.example.com');
    // Once the hub is gone, telling it anything is a no-op, not a crash.
    hub.send({ type: 'relay-state', state });
  });
});
