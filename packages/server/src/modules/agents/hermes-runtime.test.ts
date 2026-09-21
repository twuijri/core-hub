/**
 * The Hermes runtime supervisor (ADR 0008) with a fake spawner: which mode it picks, what
 * environment the child gets, that a crash restarts it and that stop stops it.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { capturingLogger, unreachableFetch } from '../../../tests/unit/helpers.js';
import {
  HermesRuntime,
  loadOrCreateHermesApiKey,
  type SpawnedProcess,
  type Spawner,
} from './hermes-runtime.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-'));
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
    expect(runtime.status()).toMatchObject({ mode: 'external', state: 'running', home: null });
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
