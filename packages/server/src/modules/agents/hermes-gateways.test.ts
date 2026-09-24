/**
 * One messaging gateway per Hermes profile with a channel (`hermes-gateways.ts`), with a fake
 * spawner: which profiles get one, with what argv and environment, that a channel change
 * starts, restarts or stops it, that a crash is restarted, and that the runtime's Restart and
 * stop reach every one of them.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturingLogger, unreachableFetch } from '../../../tests/unit/helpers.js';
import { WHATSAPP_BRIDGE_PORT, whatsappBridgePort } from './channels.js';
import { ProfileGateways, stopOrphanBridge } from './hermes-gateways.js';
import { HermesRuntime, type SpawnedProcess, type Spawner } from './hermes-runtime.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-gateways-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let nextPid = 5000;
class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = nextPid++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
  crash(): void {
    this.emit('exit', 1, null);
  }
}

interface Spawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  child: FakeChild;
  /** `config.yaml` as the gateway would have read it at start. */
  config: string;
}

function fakeSpawner() {
  const spawned: Spawn[] = [];
  const spawnImpl: Spawner = (command, args, options) => {
    const child = new FakeChild();
    let config = '';
    try {
      config = readFileSync(path.join(options.cwd, 'config.yaml'), 'utf8');
    } catch {
      // No file yet.
    }
    spawned.push({ command, args, env: options.env, cwd: options.cwd, child, config });
    return child;
  };
  const of = (profile: string) =>
    spawned.filter((entry) =>
      profile === 'default' ? !entry.args.includes('-p') : entry.args.includes(profile),
    );
  return { spawned, spawnImpl, of };
}

/** Hermes's root home with named profiles, each with the config given. */
function hermesRoot(profiles: Record<string, string>, rootConfig = ''): string {
  const root = tempDir();
  writeFileSync(path.join(root, 'config.yaml'), rootConfig);
  for (const [name, config] of Object.entries(profiles)) {
    mkdirSync(path.join(root, 'profiles', name), { recursive: true });
    writeFileSync(path.join(root, 'profiles', name, 'config.yaml'), config);
  }
  return root;
}

const TELEGRAM_ON = 'platforms:\n  telegram:\n    enabled: true\n    token: 1234:abc\n';
const NOTHING = 'model:\n  default: m\n';

/** A profile whose WhatsApp Hermes paired: the switch in `.env`, the phone in the session. */
function pairWhatsApp(home: string): void {
  writeFileSync(path.join(home, '.env'), 'WHATSAPP_ENABLED=true\nWHATSAPP_MODE=bot\n');
  const session = path.join(home, 'platforms', 'whatsapp', 'session');
  mkdirSync(session, { recursive: true });
  writeFileSync(
    path.join(session, 'creds.json'),
    JSON.stringify({ me: { id: '966500000000:12@s.whatsapp.net', name: 'Office' } }),
  );
}

function gatewaysOver(
  root: string,
  extra: Partial<ConstructorParameters<typeof ProfileGateways>[0]> = {},
) {
  const { logger, lines } = capturingLogger();
  const spawner = fakeSpawner();
  const gateways = new ProfileGateways({
    root: () => root,
    executable: () => '/opt/hermes/bin/hermes',
    env: () => ({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-shared',
      // Must never reach a profile gateway: it would bind the default's port.
      API_SERVER_KEY: 'k'.repeat(40),
      API_SERVER_PORT: '8642',
      HERMES_HOME: root,
    }),
    spawnImpl: spawner.spawnImpl,
    log: logger,
    backoffMs: [5, 5],
    stopGraceMs: 50,
    ...extra,
  });
  return { gateways, ...spawner, lines };
}

describe('a messaging gateway per profile', () => {
  it('starts one only for a profile with a channel switched on and able to sign in', async () => {
    const root = hermesRoot({
      sales: TELEGRAM_ON,
      quiet: NOTHING,
      // Switched on, never told how to sign in: nothing a gateway could serve.
      half: 'platforms:\n  discord:\n    enabled: true\n',
      manger: NOTHING,
    });
    pairWhatsApp(path.join(root, 'profiles', 'manger'));
    const { gateways, spawned } = gatewaysOver(root);
    await gateways.reconcile();

    expect(spawned.map((entry) => entry.args)).toEqual([
      ['-p', 'manger', 'gateway', 'run'],
      ['-p', 'sales', 'gateway', 'run'],
    ]);
    expect(gateways.status().map((entry) => [entry.profile, entry.channels])).toEqual([
      ['manger', ['whatsapp']],
      ['sales', ['telegram']],
    ]);
    await gateways.stopAll();
  });

  it("runs Hermes's own `-p <profile>` against the root, in the profile's folder, without the API server", async () => {
    const root = hermesRoot({ sales: TELEGRAM_ON });
    const { gateways, spawned } = gatewaysOver(root);
    await gateways.reconcile();
    const [entry] = spawned;
    expect(entry?.command).toBe('/opt/hermes/bin/hermes');
    expect(entry?.cwd).toBe(path.join(root, 'profiles', 'sales'));
    expect(entry?.env.HERMES_HOME).toBe(root);
    // The shared keys reach it like every Hermes process (ADR 0010)…
    expect(entry?.env.OPENAI_API_KEY).toBe('sk-shared');
    // …the API server's never: only the default gateway serves 8642.
    expect(entry?.env.API_SERVER_KEY).toBeUndefined();
    expect(entry?.env.API_SERVER_PORT).toBeUndefined();
    expect(entry?.env.HERMES_DASHBOARD).toBe('0');
    await gateways.stopAll();
  });

  it("gives a second profile's WhatsApp bridge a port of its own before its gateway starts", async () => {
    const root = hermesRoot({ manger: NOTHING, sales: NOTHING });
    pairWhatsApp(path.join(root, 'profiles', 'manger'));
    pairWhatsApp(path.join(root, 'profiles', 'sales'));
    const { gateways, spawned } = gatewaysOver(root);
    await gateways.reconcile();

    const manger = whatsappBridgePort(path.join(root, 'profiles', 'manger'));
    const sales = whatsappBridgePort(path.join(root, 'profiles', 'sales'));
    expect(manger).not.toBe(WHATSAPP_BRIDGE_PORT);
    expect(sales).not.toBe(WHATSAPP_BRIDGE_PORT);
    expect(manger).not.toBe(sales);
    // Written where Hermes reads it, and already there when the gateway read its file.
    expect(spawned.find((entry) => entry.args.includes('manger'))?.config).toContain(
      `bridge_port: ${manger}`,
    );
    // Kept on the next start rather than handed out again.
    await gateways.restartAll();
    expect(whatsappBridgePort(path.join(root, 'profiles', 'manger'))).toBe(manger);
    await gateways.stopAll();
  });

  it('prepares the profile (the hub providers and its model) before every start', async () => {
    const root = hermesRoot({ sales: TELEGRAM_ON });
    const prepared: string[] = [];
    const { gateways, spawned } = gatewaysOver(root, {
      prepare: (profile, home) => {
        prepared.push(profile);
        writeFileSync(
          path.join(home, 'config.yaml'),
          `${TELEGRAM_ON}model:\n  provider: majlis-x\n`,
        );
      },
    });
    await gateways.reconcile();
    await gateways.restartAll();
    expect(prepared).toEqual(['sales', 'sales']);
    expect(spawned.every((entry) => entry.config.includes('provider: majlis-x'))).toBe(true);
    await gateways.stopAll();
  });

  it('follows a channel change: starts, restarts, then stops when none is left', async () => {
    const root = hermesRoot({ sales: NOTHING });
    const home = path.join(root, 'profiles', 'sales');
    const { gateways, spawned } = gatewaysOver(root);
    await gateways.reconcile();
    expect(spawned).toHaveLength(0);

    writeFileSync(path.join(home, 'config.yaml'), TELEGRAM_ON);
    await gateways.channelsChanged('sales');
    expect(spawned).toHaveLength(1);

    // Edited while it runs: a gateway reads its channels at start, so it starts again.
    await gateways.channelsChanged('sales');
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(spawned[0]?.child.killed).toEqual(['SIGTERM']);

    writeFileSync(path.join(home, 'config.yaml'), 'platforms:\n  telegram:\n    enabled: false\n');
    await gateways.channelsChanged('sales');
    expect(spawned[1]?.child.killed).toEqual(['SIGTERM']);
    expect(gateways.status()).toEqual([]);
    // The default profile's gateway is not this supervisor's.
    await gateways.channelsChanged('default');
    expect(spawned).toHaveLength(2);
    await gateways.stopAll();
  });

  it('restarts a crashed gateway with backoff, and says it is in error meanwhile', async () => {
    const root = hermesRoot({ sales: TELEGRAM_ON });
    const { gateways, spawned, lines } = gatewaysOver(root, { backoffMs: [40] });
    await gateways.reconcile();
    spawned[0]!.child.crash();
    expect(gateways.status()[0]).toMatchObject({
      profile: 'sales',
      state: 'error',
      restarts: 1,
      lastError: 'hermes gateway exited (code 1)',
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(gateways.status()[0]?.state).toBe('starting');
    expect(lines.some((line) => line.profile === 'sales' && /crashed/.test(String(line.msg)))).toBe(
      true,
    );
    await gateways.stopAll();
  });

  it("says `running` once Hermes's own state file names this process running", async () => {
    const root = hermesRoot({ sales: TELEGRAM_ON });
    const { gateways, spawned } = gatewaysOver(root);
    await gateways.reconcile();
    const home = path.join(root, 'profiles', 'sales');
    // A record another process left behind does not count.
    writeFileSync(
      path.join(home, 'gateway_state.json'),
      JSON.stringify({ pid: 1, gateway_state: 'running', platforms: {} }),
    );
    expect(gateways.status()[0]?.state).toBe('starting');
    writeFileSync(
      path.join(home, 'gateway_state.json'),
      JSON.stringify({
        pid: spawned[0]!.child.pid,
        gateway_state: 'running',
        platforms: { telegram: { state: 'connected' } },
      }),
    );
    expect(gateways.status()[0]?.state).toBe('running');
    expect(gateways.record('sales')?.platforms.telegram?.state).toBe('connected');
    await gateways.stopAll();
  });

  it('holds a gateway down while a channel is changed, and starts it again when still needed', async () => {
    const root = hermesRoot({ sales: TELEGRAM_ON });
    const { gateways, spawned } = gatewaysOver(root);
    await gateways.reconcile();
    const seen: number[] = [];
    await gateways.withStopped('sales', () => {
      seen.push(spawned.length);
      expect(spawned[0]?.child.killed).toEqual(['SIGTERM']);
    });
    expect(seen).toEqual([1]);
    expect(spawned).toHaveLength(2);
    await gateways.stopAll();
  });
});

function binDirWithHermes(): string {
  const dir = tempDir();
  const file = path.join(dir, 'hermes');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return dir;
}

describe('the runtime runs them beside the default gateway', () => {
  async function managed(profiles: Record<string, string>) {
    const dataDir = tempDir();
    const root = path.join(dataDir, 'hermes');
    mkdirSync(root, { recursive: true });
    for (const [name, config] of Object.entries(profiles)) {
      mkdirSync(path.join(root, 'profiles', name), { recursive: true });
      writeFileSync(path.join(root, 'profiles', name, 'config.yaml'), config);
    }
    const { logger } = capturingLogger();
    const spawner = fakeSpawner();
    const prepared: string[] = [];
    const runtime = new HermesRuntime({
      dataDir,
      host: { pathValue: binDirWithHermes() },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl: spawner.spawnImpl,
      healthIntervalMs: 0,
      prepareGateway: (profile) => prepared.push(profile),
    });
    await runtime.start();
    await vi.waitFor(() =>
      expect(runtime.gateways().length).toBe(
        1 + Object.keys(profiles).filter((name) => profiles[name] === TELEGRAM_ON).length,
      ),
    );
    return { runtime, root, prepared, ...spawner };
  }

  it('starts the named profiles with a channel at boot, and lists every gateway', async () => {
    const { runtime, of, prepared } = await managed({ sales: TELEGRAM_ON, quiet: NOTHING });
    expect(of('default')).toHaveLength(1);
    expect(of('sales')).toHaveLength(1);
    expect(of('quiet')).toHaveLength(0);
    // The default one serves the API server; its providers are prepared as well.
    expect(of('default')[0]?.env.API_SERVER_KEY).toBeTruthy();
    expect(prepared).toEqual(expect.arrayContaining(['default', 'sales']));
    expect(runtime.gateways().map((entry) => entry.profile)).toEqual(['default', 'sales']);
    await runtime.stop();
    expect(of('sales')[0]?.child.killed).toEqual(['SIGTERM']);
  });

  it('Restart restarts every messaging gateway, not only the default one', async () => {
    const { runtime, of } = await managed({ sales: TELEGRAM_ON });
    await runtime.restart();
    await vi.waitFor(() => {
      expect(of('default')).toHaveLength(2);
      expect(of('sales')).toHaveLength(2);
    });
    await runtime.stop();
  });

  it('holds the default gateway down while its WhatsApp is unlinked, then starts it again', async () => {
    const { runtime, of } = await managed({});
    const during: number[] = [];
    await runtime.withGatewayStopped('default', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      during.push(of('default').length);
    });
    expect(during).toEqual([1]);
    await vi.waitFor(() => expect(of('default')).toHaveLength(2));
    await runtime.stop();
  });
});

describe('a bridge left behind', () => {
  it('is only stopped when the pid file names a node process of this very session', () => {
    const session = tempDir();
    // Our own pid is a process that exists but is not a bridge of this session.
    writeFileSync(path.join(session, 'bridge.pid'), `${process.pid}\n`);
    expect(stopOrphanBridge(session)).toBe(false);
    writeFileSync(path.join(session, 'bridge.pid'), 'not-a-pid');
    expect(stopOrphanBridge(session)).toBe(false);
    expect(stopOrphanBridge(path.join(session, 'nothing-here'))).toBe(false);
  });
});
