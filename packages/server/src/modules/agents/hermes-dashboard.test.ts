/**
 * Hermes's dashboard API (ADR 0015) with a fake spawner and a fake `fetch`: one start for
 * many callers, the token on every call and nowhere else, idle stop and restart, a death
 * noticed, managed only, and Hermes's own words when it refuses.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import {
  DASHBOARD_TOKEN_FILE,
  HermesDashboard,
  HermesDashboardRefusal,
  HermesDashboardUnavailable,
  detailOf,
  type DashboardSpawner,
  type HermesDashboardHost,
} from './hermes-dashboard.js';
import type { HermesRuntimeMode, SpawnedProcess } from './hermes-runtime.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-dash-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeChild extends EventEmitter implements SpawnedProcess {
  static nextPid = 5000;
  pid = FakeChild.nextPid++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  exited = false;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false;
    this.killed.push(signal);
    setTimeout(() => this.die(0, null), 1);
    return true;
  }
  die(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}

interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  child: FakeChild;
  port: number;
}

/** Each child announces itself the way `hermes serve` does, after a short start. */
function fakeSpawner(behaviour: 'ready' | 'crash' | 'silent' = 'ready') {
  const spawned: Spawned[] = [];
  let port = 40000;
  const spawnImpl: DashboardSpawner = (command, args, options) => {
    const child = new FakeChild();
    const entry = { command, args, env: options.env, cwd: options.cwd, child, port: ++port };
    spawned.push(entry);
    setTimeout(() => {
      child.stderr.write('Starting Hermes...\n');
      if (behaviour === 'ready') child.stdout.write(`HERMES_BACKEND_READY port=${entry.port}\n`);
      if (behaviour === 'crash') {
        child.stderr.write('ModuleNotFoundError: No module named uvicorn\n');
        child.die(1, null);
      }
    }, 5);
    return child;
  };
  return { spawned, spawnImpl };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers every call with `answer(call)`; records what it was asked. */
function fakeFetch(
  answer: (call: Call) => Response | Promise<Response> = () => json({ ok: true }),
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function hostOf(
  mode: HermesRuntimeMode,
  home: string,
  executable: string | null = '/opt/hermes/bin/hermes',
) {
  const host: HermesDashboardHost = {
    status: () => ({ mode, home: mode === 'absent' || mode === 'undecided' ? null : home }),
    executable: () => executable,
    cliEnv: () => ({
      PATH: '/opt/hermes/bin:/usr/bin',
      OPENROUTER_API_KEY: 'provider-key',
      HERMES_HOME: home,
      // Inherited by accident: must never reach the child (it would tick cron twice).
      HERMES_DESKTOP: '1',
    }),
  };
  return host;
}

function dashboard(
  opts: {
    mode?: HermesRuntimeMode;
    spawner?: ReturnType<typeof fakeSpawner>;
    fetcher?: ReturnType<typeof fakeFetch>;
    idleMs?: number;
    startTimeoutMs?: number;
    executable?: string | null;
  } = {},
) {
  const dataDir = tempDir();
  const home = path.join(dataDir, 'hermes');
  const spawner = opts.spawner ?? fakeSpawner();
  const fetcher = opts.fetcher ?? fakeFetch();
  const { logger, lines } = capturingLogger();
  const service = new HermesDashboard({
    host: hostOf(
      opts.mode ?? 'managed',
      home,
      opts.executable === undefined ? '/opt/hermes/bin/hermes' : opts.executable,
    ),
    dataDir,
    log: logger,
    spawnImpl: spawner.spawnImpl,
    fetchImpl: fetcher.fetchImpl,
    idleMs: opts.idleMs ?? 60_000,
    startTimeoutMs: opts.startTimeoutMs ?? 5_000,
    stopGraceMs: 200,
  });
  return { service, spawner, fetcher, dataDir, home, lines };
}

describe('Hermes dashboard API: starting', () => {
  it('starts once for callers that arrive together, with argv and the token in the environment', async () => {
    const { service, spawner, fetcher, dataDir, home } = dashboard();
    const answers = await Promise.all([
      service.request('GET', '/api/plugins/kanban/board'),
      service.request('GET', '/api/plugins/kanban/board'),
      service.request('GET', '/api/status'),
    ]);
    expect(answers).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(spawner.spawned).toHaveLength(1);
    const [only] = spawner.spawned;
    expect(only!.command).toBe('/opt/hermes/bin/hermes');
    expect(only!.args).toEqual(['serve', '--host', '127.0.0.1', '--port', '0']);
    expect(only!.cwd).toBe(home);

    const token = readFileSync(path.join(dataDir, 'keys', DASHBOARD_TOKEN_FILE), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path.join(dataDir, 'keys', DASHBOARD_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(only!.env.HERMES_DASHBOARD_SESSION_TOKEN).toBe(token);
    expect(only!.env.HERMES_HOME).toBe(home);
    expect(only!.env.OPENROUTER_API_KEY).toBe('provider-key');
    expect(only!.env.HERMES_DESKTOP).toBeUndefined();

    // Every call goes to the port Hermes announced, with the token in Hermes's header.
    expect(fetcher.calls.map((c) => c.url)).toEqual([
      `http://127.0.0.1:${only!.port}/api/plugins/kanban/board`,
      `http://127.0.0.1:${only!.port}/api/plugins/kanban/board`,
      `http://127.0.0.1:${only!.port}/api/status`,
    ]);
    for (const call of fetcher.calls) expect(call.headers['X-Hermes-Session-Token']).toBe(token);
    expect(service.status()).toMatchObject({ running: true, port: only!.port, starts: 1 });
    await service.close();
  });

  it('sends JSON and reads JSON back', async () => {
    const fetcher = fakeFetch((call) =>
      json({ task: { id: 't_1', title: (call.body as { title: string }).title } }),
    );
    const { service } = dashboard({ fetcher });
    const answer = await service.request('PATCH', '/api/plugins/kanban/tasks/t_1', {
      title: 'عنوان جديد',
    });
    expect(answer).toEqual({ task: { id: 't_1', title: 'عنوان جديد' } });
    const [call] = fetcher.calls;
    expect(call!.method).toBe('PATCH');
    expect(call!.headers['content-type']).toBe('application/json');
    expect(call!.body).toEqual({ title: 'عنوان جديد' });
    await service.close();
  });

  it('lets one call wait a time of its own (a profile export takes longer than a card edit)', async () => {
    const hanging = {
      calls: [],
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as typeof fetch,
    } as unknown as ReturnType<typeof fakeFetch>;
    const { service } = dashboard({ fetcher: hanging });
    const began = Date.now();
    await expect(
      service.request('POST', '/api/profiles/work/export', { output: '/x' }, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(HermesDashboardUnavailable);
    expect(Date.now() - began).toBeLessThan(5_000);
    await service.close();
  });

  it('keeps the token across hub restarts and never writes it to the log', async () => {
    const first = dashboard();
    await first.service.request('GET', '/api/status');
    const token = first.spawner.spawned[0]!.env.HERMES_DASHBOARD_SESSION_TOKEN!;
    await first.service.stop();
    const again = new HermesDashboard({
      host: hostOf('managed', first.home),
      dataDir: first.dataDir,
      log: capturingLogger().logger,
      spawnImpl: first.spawner.spawnImpl,
      fetchImpl: first.fetcher.fetchImpl,
    });
    await again.request('GET', '/api/status');
    expect(first.spawner.spawned[1]!.env.HERMES_DASHBOARD_SESSION_TOKEN).toBe(token);
    await again.close();
    expect(JSON.stringify(first.lines)).not.toContain(token);
    expect(first.lines.some((line) => line.msg === 'hermes: dashboard API started')).toBe(true);
  });

  it('says why when the server exits before it is ready', async () => {
    const { service } = dashboard({ spawner: fakeSpawner('crash') });
    const error = await service.request('GET', '/api/status').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HermesDashboardUnavailable);
    expect(String((error as Error).message)).toMatch(/exited before it was ready \(code 1\)/);
    expect(String((error as Error).message)).toMatch(/No module named uvicorn/);
    expect(service.status().running).toBe(false);
  });

  it('gives up a start that never becomes ready, and stops the process', async () => {
    const spawner = fakeSpawner('silent');
    const { service } = dashboard({ spawner, startTimeoutMs: 50 });
    const error = await service.request('GET', '/api/status').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HermesDashboardUnavailable);
    expect(String((error as Error).message)).toMatch(/did not become ready in time/);
    await sleep(10);
    expect(spawner.spawned[0]!.child.killed).toContain('SIGTERM');
  });
});

describe('Hermes dashboard API: only where the hub supervises Hermes', () => {
  for (const mode of ['external', 'absent', 'undecided'] as const) {
    it(`is not available when the runtime is ${mode}, and starts nothing`, async () => {
      const { service, spawner } = dashboard({ mode });
      expect(service.available()).toBe(false);
      await expect(service.request('GET', '/api/status')).rejects.toBeInstanceOf(
        HermesDashboardUnavailable,
      );
      expect(spawner.spawned).toHaveLength(0);
    });
  }

  it('is not available without a `hermes` executable', () => {
    const { service } = dashboard({ executable: null });
    expect(service.available()).toBe(false);
  });

  it('is available when managed', () => {
    expect(dashboard().service.available()).toBe(true);
  });
});

describe('Hermes dashboard API: stopping and starting again', () => {
  it('stops after the idle time and starts again on the next request', async () => {
    const { service, spawner, lines } = dashboard({ idleMs: 40 });
    await service.request('GET', '/api/status');
    const first = spawner.spawned[0]!.child;
    await sleep(120);
    expect(first.killed).toEqual(['SIGTERM']);
    expect(service.status().running).toBe(false);
    expect(
      lines.some(
        (l) => l.msg === 'hermes: dashboard API stopping' && String(l.reason).startsWith('idle'),
      ),
    ).toBe(true);

    await service.request('GET', '/api/status');
    expect(spawner.spawned).toHaveLength(2);
    expect(service.status()).toMatchObject({ running: true, starts: 2 });
    await service.close();
  });

  it('does not stop while a call is still in flight', async () => {
    let release: () => void = () => {};
    const fetcher = fakeFetch(
      () => new Promise<Response>((resolve) => (release = () => resolve(json({ ok: true })))),
    );
    const { service, spawner } = dashboard({ idleMs: 30, fetcher });
    const pending = service.request('POST', '/api/plugins/kanban/tasks/t_1/specify', {});
    await sleep(100);
    expect(spawner.spawned[0]!.child.killed).toEqual([]);
    release();
    await pending;
    await sleep(100);
    expect(spawner.spawned[0]!.child.killed).toEqual(['SIGTERM']);
  });

  it('notices a server that died and starts a new one for the next request', async () => {
    const { service, spawner, lines } = dashboard();
    await service.request('GET', '/api/status');
    spawner.spawned[0]!.child.die(null, 'SIGKILL');
    expect(service.status().running).toBe(false);
    expect(lines.some((l) => l.msg?.toString().includes('dashboard API exited'))).toBe(true);
    await service.request('GET', '/api/status');
    expect(spawner.spawned).toHaveLength(2);
    await service.close();
  });

  it('retries once on a fresh server when the old one died under a call that never landed', async () => {
    let refuse = true;
    const spawner = fakeSpawner();
    const fetcher = fakeFetch(() => {
      if (refuse) {
        refuse = false;
        spawner.spawned[0]!.child.die(null, 'SIGKILL');
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      return json({ ok: true });
    });
    const { service } = dashboard({ spawner, fetcher });
    await expect(service.request('GET', '/api/status')).resolves.toEqual({ ok: true });
    expect(spawner.spawned).toHaveLength(2);
    expect(fetcher.calls[1]!.url).toContain(`:${spawner.spawned[1]!.port}/`);
    await service.close();
  });

  it('stops with the hub and never starts again', async () => {
    const { service, spawner } = dashboard();
    await service.request('GET', '/api/status');
    await service.close();
    expect(spawner.spawned[0]!.child.killed).toEqual(['SIGTERM']);
    expect(service.available()).toBe(false);
    await expect(service.request('GET', '/api/status')).rejects.toBeInstanceOf(
      HermesDashboardUnavailable,
    );
    expect(spawner.spawned).toHaveLength(1);
  });
});

describe("Hermes dashboard API: Hermes's own words", () => {
  it("surfaces Hermes's `detail` verbatim, with the status and the call", async () => {
    const fetcher = fakeFetch(() =>
      json({ detail: "status transition to 'done' not valid from current state" }, 409),
    );
    const { service } = dashboard({ fetcher });
    const error = await service
      .request('PATCH', '/api/plugins/kanban/tasks/t_9', { status: 'done' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HermesDashboardRefusal);
    expect((error as HermesDashboardRefusal).message).toBe(
      "status transition to 'done' not valid from current state",
    );
    expect((error as HermesDashboardRefusal).status).toBe(409);
    expect((error as HermesDashboardRefusal).verb).toBe('PATCH /api/plugins/kanban/tasks/t_9');
    await service.close();
  });

  it('reads the list FastAPI answers for a body it could not validate', () => {
    expect(
      detailOf(
        {
          detail: [
            {
              loc: ['body', 'priority'],
              msg: 'Input should be a valid integer',
              type: 'int_parsing',
            },
          ],
        },
        'x',
      ),
    ).toBe('priority: Input should be a valid integer');
    expect(detailOf({ detail: '' }, 'fallback')).toBe('fallback');
    expect(detailOf('Internal Server Error', 'fallback')).toBe('Internal Server Error');
  });

  it('says Hermes answered with a status when the error body has no sentence', async () => {
    const fetcher = fakeFetch(() => new Response('', { status: 500 }));
    const { service } = dashboard({ fetcher });
    await expect(service.request('DELETE', '/api/plugins/kanban/tasks/t_1')).rejects.toThrow(
      'Hermes answered 500 to DELETE /api/plugins/kanban/tasks/t_1',
    );
    await service.close();
  });
});

describe('Hermes dashboard API: warming', () => {
  it('starts the server in the background without a call, and the next call uses it', async () => {
    const { service, spawner, fetcher } = dashboard();
    service.warm();
    expect(fetcher.calls).toHaveLength(0);
    await sleep(30);
    expect(spawner.spawned).toHaveLength(1);
    expect(service.status().running).toBe(true);
    await service.request('GET', '/api/status');
    expect(spawner.spawned).toHaveLength(1);
    await service.close();
  });

  it('counts as a use: the idle clock starts again from the warm-up', async () => {
    const { service, spawner } = dashboard({ idleMs: 80 });
    await service.request('GET', '/api/status');
    await sleep(50);
    service.warm();
    await sleep(50);
    // 100 ms after the call, but 50 ms after the warm-up: still running.
    expect(spawner.spawned[0]!.child.killed).toEqual([]);
    await sleep(100);
    expect(spawner.spawned[0]!.child.killed).toEqual(['SIGTERM']);
  });

  it('does nothing where the hub does not supervise Hermes, and never throws', async () => {
    const { service, spawner } = dashboard({ mode: 'external' });
    service.warm();
    await sleep(20);
    expect(spawner.spawned).toHaveLength(0);
    const crashing = dashboard({ spawner: fakeSpawner('crash') });
    crashing.service.warm();
    await sleep(30);
    expect(crashing.lines.some((l) => String(l.msg).includes('warm-up failed'))).toBe(true);
  });
});
