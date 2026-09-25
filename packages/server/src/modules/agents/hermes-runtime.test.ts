/**
 * The Hermes runtime supervisor (ADR 0008) with a fake spawner: which mode it picks, what
 * environment the child gets, that a crash restarts it and that stop stops it.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { capturingLogger, unreachableFetch } from '../../../tests/unit/helpers.js';
import { HermesTuiSession, type Spawned } from './adapters/hermes-tui.js';
import { HubError } from '../../lib/errors.js';
import {
  HermesRuntime,
  loadOrCreateHermesApiKey,
  type HermesRuntimeOptions,
  type SpawnedProcess,
  type Spawner,
} from './hermes-runtime.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    // A well-behaved gateway exits on SIGTERM.
    if (signal === 'SIGTERM') setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

function fakeSpawner() {
  const spawned: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    child: FakeChild;
  }[] = [];
  const spawnImpl: Spawner = (command, args, options) => {
    const child = new FakeChild();
    spawned.push({ command, args, env: options.env, cwd: options.cwd, child });
    return child;
  };
  return { spawned, spawnImpl };
}

function binDirWithHermes(): string {
  const dir = tempDir();
  const file = path.join(dir, 'hermes');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return dir;
}

const healthyFetch: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

describe('Hermes runtime: choosing a mode', () => {
  it('is `absent` when no gateway answers and no binary is on PATH', async () => {
    const { logger } = capturingLogger();
    const { spawned, spawnImpl } = fakeSpawner();
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: '/nowhere-at-all' },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      healthIntervalMs: 0,
    });
    expect(await runtime.start()).toBe('absent');
    expect(spawned).toHaveLength(0);
    expect(runtime.status()).toMatchObject({ mode: 'absent', state: 'stopped', pid: null });
    expect(runtime.apiKey()).toBeNull();
    await runtime.stop();
  });

  it('is `external` when a gateway already answers, and spawns nothing', async () => {
    const { logger } = capturingLogger();
    const { spawned, spawnImpl } = fakeSpawner();
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: binDirWithHermes() },
      log: logger,
      fetchImpl: healthyFetch,
      spawnImpl,
      healthIntervalMs: 0,
    });
    expect(await runtime.start()).toBe('external');
    expect(spawned).toHaveLength(0);
    // A home is still reported. `external` means a gateway answers **on this host**, and
    // the home this hub prepared is the one it would be using; the screens that read
    // files there show the path, so a gateway somebody else started with a different
    // home reads as the wrong folder rather than as an agent with nothing in it.
    expect(runtime.status()).toMatchObject({ mode: 'external', state: 'running' });
    expect(runtime.status().home).not.toBeNull();
    await runtime.stop();
  });

  it('is `managed` when only the binary is there: spawns `hermes gateway run` with its own home and key', async () => {
    const dataDir = tempDir();
    const { logger, lines } = capturingLogger();
    const { spawned, spawnImpl } = fakeSpawner();
    const states: string[] = [];
    const runtime = new HermesRuntime({
      dataDir,
      host: { pathValue: binDirWithHermes(), inherited: { PATH: '/usr/bin', SECRET_THING: 'x' } },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      healthIntervalMs: 0,
      onState: (status) => states.push(status.state),
    });
    expect(await runtime.start()).toBe('managed');
    expect(spawned).toHaveLength(1);
    const launch = spawned[0]!;
    expect(launch.command).toMatch(/\/hermes$/);
    expect(launch.args).toEqual(['gateway', 'run']);
    expect(launch.cwd).toBe(path.join(dataDir, 'hermes'));
    expect(launch.env).toMatchObject({
      HERMES_HOME: path.join(dataDir, 'hermes'),
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: '8642',
      HERMES_DASHBOARD: '0',
      PATH: '/usr/bin',
    });
    // The key is the one on disk, strong enough for Hermes's guard, and 0600.
    const key = readFileSync(path.join(dataDir, 'keys', 'hermes-api.secret'), 'utf8').trim();
    expect(launch.env.API_SERVER_KEY).toBe(key);
    expect(key).toHaveLength(64);
    expect(runtime.apiKey()).toBe(key);
    expect(loadOrCreateHermesApiKey(dataDir)).toBe(key);

    // Its output lands in the hub's log, never on the wire.
    launch.child.stdout.write('[API Server] API server listening on http://127.0.0.1:8642\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lines.some((line) => String(line.msg).includes('API server listening'))).toBe(true);
    expect(lines.every((line) => !JSON.stringify(line).includes(key))).toBe(true);

    expect(states).toEqual(['starting']);
    await runtime.stop();
    expect(launch.child.killed).toEqual(['SIGTERM']);
    expect(runtime.status()).toMatchObject({ mode: 'managed', state: 'stopped', pid: null });
  });

  it('restarts a crashed child with backoff and stops restarting on stop()', async () => {
    const { logger } = capturingLogger();
    const { spawned, spawnImpl } = fakeSpawner();
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: binDirWithHermes() },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      healthIntervalMs: 0,
    });
    await runtime.start();
    spawned[0]!.child.emit('exit', 1, null);
    expect(runtime.status()).toMatchObject({ state: 'error', restarts: 1 });
    // First backoff is one second; the relaunch happens after it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(spawned).toHaveLength(2);
    expect(runtime.status()).toMatchObject({ state: 'starting', pid: 4242 });
    await runtime.stop();
    spawned[1]!.child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned).toHaveLength(2);
  });

  it('restart() recycles the managed child and refuses for other modes', async () => {
    const { logger } = capturingLogger();
    const { spawned, spawnImpl } = fakeSpawner();
    const managed = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: binDirWithHermes() },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      healthIntervalMs: 0,
    });
    await managed.start();
    await managed.restart();
    // A requested restart relaunches at once, without backoff and without counting as a crash.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned).toHaveLength(2);
    expect(managed.status()).toMatchObject({ state: 'starting', restarts: 0, pid: 4242 });
    await managed.stop();

    const external = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: '/nowhere-at-all' },
      log: logger,
      fetchImpl: healthyFetch,
      spawnImpl,
      healthIntervalMs: 0,
    });
    await external.start();
    await expect(external.restart()).rejects.toThrow(/not managed/);
    await external.stop();
  });
});

/**
 * A scripted `tui_gateway` per spawn: creates sessions, accepts a turn and leaves it
 * running until the test finishes it — the owner's case of 2026-09-23, a run waiting on
 * a question when a provider was saved.
 */
function tuiGateways() {
  const started: Array<{
    env: NodeJS.ProcessEnv;
    killed: boolean;
    complete(sessionId: string): void;
  }> = [];
  const tuiSpawn = (
    _command: string,
    _args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Spawned => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exits = new EventEmitter();
    const send = (frame: Record<string, unknown>) =>
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
    const n = started.length + 1;
    const gateway = {
      env,
      killed: false,
      complete(sessionId: string) {
        send({
          method: 'event',
          params: {
            type: 'message.complete',
            session_id: sessionId,
            payload: { status: 'complete' },
          },
        });
      },
    };
    started.push(gateway);
    createInterface({ input: stdin }).on('line', (line) => {
      const frame = JSON.parse(line) as { id?: number; method?: string };
      if (frame.method === 'session.create') {
        send({
          id: frame.id,
          result: { session_id: `live-${n}`, stored_session_id: `stored-${n}` },
        });
      } else if (frame.method) {
        send({ id: frame.id, result: {} });
      }
    });
    setImmediate(() => send({ method: 'event', params: { type: 'gateway.ready', payload: {} } }));
    return {
      stdin,
      stdout,
      kill: () => {
        gateway.killed = true;
        exits.emit('exit', null, 'SIGTERM');
      },
      on: (event, listener) => exits.on(event, listener),
    };
  };
  return { started, tuiSpawn };
}

describe('Hermes runtime: the TUI gateway and changing keys', () => {
  it('keeps a gateway carrying a turn alive when the keys change, and gives new conversations a new one', async () => {
    const { logger } = capturingLogger();
    const { spawnImpl } = fakeSpawner();
    const { started, tuiSpawn } = tuiGateways();
    const bin = binDirWithHermes();
    writeFileSync(path.join(bin, 'python'), '');
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: bin },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      tuiSpawn,
      healthIntervalMs: 0,
      tuiRetireIntervalMs: 5,
    });
    await runtime.start();
    runtime.setProviderEnv({ OPENROUTER_API_KEY: 'old-key' });

    const first = runtime.tuiChannel()!;
    const session = await HermesTuiSession.open(first, null);
    const turn = session.send({ text: 'forty-five tool calls, then a question' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.busy).toBe(true);

    // A provider saved mid-turn.
    expect(runtime.setProviderEnv({ OPENROUTER_API_KEY: 'new-key' })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.alive).toBe(true);
    expect(session.closed).toBe(false);
    expect(started[0]!.killed).toBe(false);

    // A new conversation gets a gateway started with the new key.
    const second = runtime.tuiChannel()!;
    expect(second).not.toBe(first);
    expect(started).toHaveLength(2);
    expect(started[1]!.env.OPENROUTER_API_KEY).toBe('new-key');
    expect(runtime.tuiChannel()).toBe(second);

    // The turn finishes on the gateway it started on; then the old gateway is closed.
    started[0]!.complete('live-1');
    expect(await turn).toEqual({ stopReason: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.alive).toBe(false);
    expect(started[0]!.killed).toBe(true);
    expect(second.alive).toBe(true);
    await runtime.stop();
    expect(second.alive).toBe(false);
  });

  it('closes an idle gateway at once when the keys change', async () => {
    const { logger } = capturingLogger();
    const { spawnImpl } = fakeSpawner();
    const { started, tuiSpawn } = tuiGateways();
    const bin = binDirWithHermes();
    writeFileSync(path.join(bin, 'python'), '');
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: bin },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      tuiSpawn,
      healthIntervalMs: 0,
    });
    await runtime.start();
    const first = runtime.tuiChannel()!;
    await HermesTuiSession.open(first, null);
    runtime.setProviderEnv({ OPENROUTER_API_KEY: 'new-key' });
    expect(first.alive).toBe(false);
    expect(started[0]!.killed).toBe(true);
    expect(runtime.tuiChannel()).not.toBe(first);
    await runtime.stop();
  });
});

describe("Hermes runtime: Hermes's settings changed (contract decision §56)", () => {
  it('retires the TUI gateway so the next message reads the new values, and leaves an external Hermes alone', async () => {
    const { logger } = capturingLogger();
    const { spawnImpl } = fakeSpawner();
    const { started, tuiSpawn } = tuiGateways();
    const bin = binDirWithHermes();
    writeFileSync(path.join(bin, 'python'), '');
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: bin },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      tuiSpawn,
      healthIntervalMs: 0,
    });
    await runtime.start();
    const first = runtime.tuiChannel()!;
    await HermesTuiSession.open(first, null);
    await runtime.settingsChanged('default');
    expect(first.alive).toBe(false);
    expect(started[0]!.killed).toBe(true);
    // The next conversation gets a fresh one, which reads the profile's files as it builds.
    const second = runtime.tuiChannel()!;
    expect(second).not.toBe(first);
    await runtime.stop();

    const external = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: bin },
      log: logger,
      fetchImpl: async () => new Response('{"status":"ok"}', { status: 200 }),
      spawnImpl,
      healthIntervalMs: 0,
    });
    expect(await external.start()).toBe('external');
    await expect(external.settingsChanged('work')).resolves.toBeUndefined();
    await external.stop();
  });
});

describe('Hermes runtime: the profile a conversation runs in (ADR 0014 stage 3)', () => {
  async function managedRuntime(profileRun: HermesRuntimeOptions['profileRun']) {
    const { logger } = capturingLogger();
    const { spawnImpl } = fakeSpawner();
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: binDirWithHermes() },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      healthIntervalMs: 0,
      ...(profileRun ? { profileRun } : {}),
    });
    await runtime.start();
    return runtime;
  }

  it('makes a missing profile once, as a copy of default, however many turns ask at once', async () => {
    const runs: string[][] = [];
    let home = '';
    const runtime = await managedRuntime(async (argv) => {
      runs.push([...argv]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      mkdirSync(path.join(home, 'profiles', 'design'), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    });
    home = runtime.home;
    await Promise.all([runtime.ensureProfile('design'), runtime.ensureProfile('design')]);
    expect(runs).toEqual([
      ['profile', 'create', 'design', '--no-alias', '--clone-from', 'default'],
    ]);
    // It is there now: nothing more is run.
    await runtime.ensureProfile('design');
    expect(runs).toHaveLength(1);
    await runtime.stop();
  });

  it('leaves `default` and an existing profile alone', async () => {
    const runs: string[][] = [];
    const runtime = await managedRuntime(async (argv) => {
      runs.push([...argv]);
      return { code: 0, stdout: '', stderr: '' };
    });
    mkdirSync(path.join(runtime.home, 'profiles', 'ops'), { recursive: true });
    await runtime.ensureProfile('default');
    await runtime.ensureProfile('ops');
    expect(runs).toEqual([]);
    await runtime.stop();
  });

  it("refuses the turn in Hermes's words when the profile cannot be made", async () => {
    const runtime = await managedRuntime(async () => ({
      code: 1,
      stdout: '',
      stderr: "Traceback …\nError: Source profile 'default' does not exist\n",
    }));
    const refusal = await runtime.ensureProfile('design').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HubError);
    expect(refusal).toMatchObject({
      code: 'agent_unavailable',
      details: { reason: 'hermes_profile_unavailable', profile: 'design' },
    });
    expect((refusal as Error).message).toContain("Source profile 'default' does not exist");
    await runtime.stop();
  });

  it('serves conversations in different profiles from the one TUI gateway it supervises', async () => {
    const { logger } = capturingLogger();
    const { spawnImpl } = fakeSpawner();
    const { started, tuiSpawn } = tuiGateways();
    const bin = binDirWithHermes();
    writeFileSync(path.join(bin, 'python'), '');
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: bin },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      tuiSpawn,
      healthIntervalMs: 0,
    });
    await runtime.start();
    const a = await HermesTuiSession.open(runtime.tuiChannel()!, null, { profile: 'design' });
    const b = await HermesTuiSession.open(runtime.tuiChannel()!, null, { profile: 'ops' });
    const c = await HermesTuiSession.open(runtime.tuiChannel()!, null, { profile: 'default' });
    expect([a.id, b.id, c.id]).toHaveLength(3);
    // A profile is a parameter of the session, not a process: one child for all three.
    expect(started).toHaveLength(1);
    await runtime.stop();
  });
});
