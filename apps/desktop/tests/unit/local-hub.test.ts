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
});
