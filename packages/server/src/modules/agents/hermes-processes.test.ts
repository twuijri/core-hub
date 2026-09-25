// What the Performance and Logs screens learn from the supervised Hermes (DECISIONS §51):
// every process it runs, by pid, and the TUI gateway's own log lines — which reach the Logs
// ring but never the hub's log.
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { capturingLogger, unreachableFetch } from '../../../tests/unit/helpers.js';
import type { Spawned } from './adapters/hermes-tui.js';
import { HermesRuntime, type SpawnedProcess, type Spawner } from './hermes-runtime.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-procs-'));
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
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (signal === 'SIGTERM') setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

const spawnImpl: Spawner = () => new FakeChild();

/** A TUI gateway that is ready at once and writes to stderr on demand. */
function tuiGateway() {
  const stderr = new PassThrough();
  const tuiSpawn = (): Spawned => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exits = new EventEmitter();
    createInterface({ input: stdin }).on('line', () => undefined);
    setImmediate(() =>
      stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } })}\n`,
      ),
    );
    return {
      pid: 777,
      stdin,
      stdout,
      stderr,
      kill: () => exits.emit('exit', null, 'SIGTERM'),
      on: (event, listener) => exits.on(event, listener),
    };
  };
  return { stderr, tuiSpawn };
}

function binWithHermes(): string {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'hermes'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(dir, 'hermes'), 0o755);
  writeFileSync(path.join(dir, 'python'), '');
  return dir;
}

describe('Hermes processes and the TUI log', () => {
  it('lists the TUI gateway and the messaging gateway by pid, and hands on the TUI log', async () => {
    const { logger, lines } = capturingLogger();
    const { stderr, tuiSpawn } = tuiGateway();
    const tuiLines: string[] = [];
    const runtime = new HermesRuntime({
      dataDir: tempDir(),
      host: { pathValue: binWithHermes() },
      log: logger,
      fetchImpl: unreachableFetch,
      spawnImpl,
      tuiSpawn,
      healthIntervalMs: 0,
      gatewayRescanMs: 0,
      tuiLogLine: (line) => tuiLines.push(line),
    });
    // Nothing runs before the hub decides it supervises Hermes.
    expect(runtime.processes()).toEqual([]);
    expect(await runtime.start()).toBe('managed');
    expect(runtime.processes()).toEqual([
      { kind: 'gateway', profile: 'default', pid: 4242, state: 'starting' },
    ]);

    const channel = runtime.tuiChannel()!;
    expect(channel.pid).toBe(777);
    expect(runtime.processes()).toEqual([
      { kind: 'tui_gateway', profile: null, pid: 777, state: 'running' },
      { kind: 'gateway', profile: 'default', pid: 4242, state: 'starting' },
    ]);

    stderr.write('2026-09-25 10:00:00 - WARNING - provider slow\nplain line\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tuiLines).toEqual(['2026-09-25 10:00:00 - WARNING - provider slow', 'plain line']);
    // Still kept out of the hub's own log volume.
    expect(lines.some((line) => String(line.msg).includes('provider slow'))).toBe(false);

    await runtime.stop();
    expect(runtime.processes().filter((process) => process.kind === 'tui_gateway')).toEqual([]);
  });
});
