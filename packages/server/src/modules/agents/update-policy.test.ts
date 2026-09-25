/**
 * The update policy (`update-policy.ts`): the registry is asked, never installed from on
 * its own; an update installs an exact version; auto-update is off by default, runs only
 * while the agent is idle, and a run asked for during it waits.
 *
 * The registry, the clock and the runner are fakes throughout — no test reaches npm.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authed,
  capturingLogger,
  drainJobs,
  fakeInstaller,
  signedInHub,
} from '../../../tests/unit/helpers.js';
import { agentEnvironment } from './adapters/acp.js';
import type { AdapterSet } from './adapters/index.js';
import type { AgentEvent } from './adapters/types.js';
import { catalogEntry, pinnedVersion, type CatalogEntry } from './catalog/index.js';
import { agentUpdatesFor, agentsServiceFor } from './index.js';
import { createNpmInstaller } from './installer.js';
import { AgentRunner } from './runner.js';
import type { AgentsService } from './service.js';
import {
  AgentUpdateChecker,
  compareVersions,
  createPackageRegistry,
  isStableVersion,
  newerOf,
  type PackageRegistry,
  type UpdateCandidate,
  type UpdatePolicyStore,
} from './update-policy.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('update policy: versions', () => {
  it('compares dotted versions numerically, a pre-release before its release', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('v2.0.0', '1.99.99')).toBe(1);
    expect(newerOf('0.60.0', '0.61.0')).toBe('0.61.0');
    expect(newerOf('0.60.0', null)).toBe('0.60.0');
    expect(newerOf(null, null)).toBeNull();
  });

  it('offers released versions only: no tag, range or pre-release', () => {
    expect(isStableVersion('0.24.5')).toBe(true);
    for (const value of ['latest', '^1.0.0', '0.1.5-rc.3', '1.0', '', null]) {
      expect(isStableVersion(value)).toBe(false);
    }
  });
});

describe('update policy: asking the registry (installs nothing)', () => {
  const answering = (routes: Record<string, { status: number; body?: unknown }>) => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const route = routes[url];
      if (!route) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
    }) as typeof fetch;
    return { asked, fetchImpl };
  };

  it("reads npm's latest dist-tag, the scoped name as one path segment", async () => {
    const { asked, fetchImpl } = answering({
      'https://registry.npmjs.org/@qwen-code%2fqwen-code/latest': {
        status: 200,
        body: { version: '0.25.0' },
      },
    });
    const registry = createPackageRegistry({ fetchImpl });
    expect(await registry.latest('npm', '@qwen-code/qwen-code')).toBe('0.25.0');
    expect(asked).toEqual(['https://registry.npmjs.org/@qwen-code%2fqwen-code/latest']);
  });

  it("reads PyPI's JSON", async () => {
    const { fetchImpl } = answering({
      'https://pypi.org/pypi/some-agent/json': {
        status: 200,
        body: { info: { version: '1.52.0' } },
      },
    });
    expect(await createPackageRegistry({ fetchImpl }).latest('pypi', 'some-agent')).toBe('1.52.0');
  });

  it('offers nothing for a pre-release tagged latest, or a package it does not know', async () => {
    const { fetchImpl } = answering({
      'https://registry.npmjs.org/@deepseek-ai%2fdsh/latest': {
        status: 200,
        body: { version: '0.1.5-rc.3' },
      },
    });
    const registry = createPackageRegistry({ fetchImpl });
    expect(await registry.latest('npm', '@deepseek-ai/dsh')).toBeNull();
    expect(await registry.latest('npm', 'no-such-package')).toBeNull();
  });

  it('fails loudly when the registry itself fails, so a check is not a silent "up to date"', async () => {
    const { fetchImpl } = answering({
      'https://registry.npmjs.org/pi-acp/latest': { status: 503 },
    });
    await expect(createPackageRegistry({ fetchImpl }).latest('npm', 'pi-acp')).rejects.toThrow(
      /503/,
    );
  });
});

/** A store of candidates held in memory, with the calls the checker made. */
function fakeStore(candidates: UpdateCandidate[], latestFor: Record<string, string | null> = {}) {
  const recorded: Array<[string, string | null]> = [];
  const upgraded: string[] = [];
  const store: UpdatePolicyStore = {
    updateCandidates: () => candidates,
    recordLatest(agentId, latest) {
      recorded.push([agentId, latest]);
      const candidate = candidates.find((c) => c.agentId === agentId)!;
      latestFor[agentId] = latest;
      return !!latest && !!candidate.installed && compareVersions(latest, candidate.installed) > 0;
    },
    autoUpgrade(agentId) {
      upgraded.push(agentId);
      return true;
    },
  };
  return { store, recorded, upgraded };
}

const candidate = (overrides: Partial<UpdateCandidate> = {}): UpdateCandidate => ({
  agentId: 'A1',
  slug: 'qwen-code',
  registry: 'npm',
  package: '@qwen-code/qwen-code',
  pinned: '0.24.5',
  installed: '0.24.5',
  autoUpdate: false,
  ...overrides,
});

const registryOf = (answers: Record<string, string | null | Error>): PackageRegistry => ({
  latest: async (_kind, name) => {
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  },
});

describe('update policy: the periodic check', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  it('records what the registry said and starts nothing when auto-update is off (the default)', async () => {
    const { store, recorded, upgraded } = fakeStore([candidate()]);
    const checker = new AgentUpdateChecker({
      store,
      activity: { busyFor: () => false },
      registry: registryOf({ '@qwen-code/qwen-code': '0.25.0' }),
      log,
    });
    const report = await checker.checkAll();
    expect(recorded).toEqual([['A1', '0.25.0']]);
    expect(report).toMatchObject({ checked: ['qwen-code'], available: ['qwen-code'], started: [] });
    expect(upgraded).toEqual([]);
  });

  it('takes an update on its own only while the agent is idle', async () => {
    const { store, upgraded } = fakeStore([candidate({ autoUpdate: true })]);
    const checker = new AgentUpdateChecker({
      store,
      activity: { busyFor: () => false },
      registry: registryOf({ '@qwen-code/qwen-code': '0.25.0' }),
      log,
    });
    expect((await checker.checkAll()).started).toEqual(['qwen-code']);
    expect(upgraded).toEqual(['A1']);
  });

  it('waits for a busy agent and takes the update once its run has ended', async () => {
    vi.useFakeTimers();
    let busy = true;
    const { store, upgraded } = fakeStore([candidate({ autoUpdate: true })]);
    const checker = new AgentUpdateChecker({
      store,
      activity: { busyFor: () => busy },
      registry: registryOf({ '@qwen-code/qwen-code': '0.25.0' }),
      log,
      idleRetryMs: 1_000,
    });
    const report = await checker.checkAll();
    expect(report.deferred).toEqual(['qwen-code']);
    expect(upgraded).toEqual([]);

    // Still working at the first retry: nothing happens under a running turn.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(upgraded).toEqual([]);

    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(upgraded).toEqual(['A1']);
    checker.stop();
  });

  it('keeps going past an unreachable registry and says which agent it could not check', async () => {
    const { store, recorded } = fakeStore([
      candidate(),
      candidate({ agentId: 'A2', slug: 'pi', package: '@earendil-works/pi-coding-agent' }),
    ]);
    const warn = vi.fn();
    const checker = new AgentUpdateChecker({
      store,
      activity: { busyFor: () => false },
      registry: registryOf({
        '@qwen-code/qwen-code': new Error('ECONNREFUSED'),
        '@earendil-works/pi-coding-agent': '0.87.1',
      }),
      log: { info: vi.fn(), warn },
    });
    const report = await checker.checkAll();
    expect(report.failed).toEqual(['qwen-code']);
    expect(report.checked).toEqual(['pi']);
    expect(recorded).toEqual([['A2', '0.87.1']]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('runs every six hours once started, first shortly after boot', async () => {
    vi.useFakeTimers();
    const latest = vi.fn(async () => '0.24.5');
    const { store } = fakeStore([candidate()]);
    const checker = new AgentUpdateChecker({
      store,
      activity: { busyFor: () => false },
      registry: { latest },
      log,
    });
    checker.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(latest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
    expect(latest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(latest).toHaveBeenCalledTimes(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(latest).toHaveBeenCalledTimes(2);
  });

  it('never runs two passes at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const latest = vi.fn(async () => {
      await gate;
      return '0.25.0';
    });
    const { store } = fakeStore([candidate()]);
    const checker = new AgentUpdateChecker({
      store,
      activity: { busyFor: () => false },
      registry: { latest },
      log,
    });
    const first = checker.checkAll();
    const second = checker.checkAll();
    release();
    await Promise.all([first, second]);
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe('update policy: a run asked for during an update waits for it', () => {
  const session = () => {
    const closed = { value: false };
    return {
      closed,
      session: {
        id: 'S-ref',
        async send() {
          return { stopReason: 'completed' };
        },
        async *stream(): AsyncIterable<AgentEvent> {
          yield { type: 'run.completed', stopReason: 'completed' } as AgentEvent;
        },
        async respond() {},
        async interrupt() {},
        async close() {
          closed.value = true;
        },
      },
    };
  };
  const request = (runId: string) => ({
    runId,
    sessionId: 'S1',
    workspace: 'w',
    agentId: 'agent-1',
    agentSessionRef: null,
    workingDir: null,
    model: null,
    provider: null,
    reasoningEffort: null,
    prompt: [{ type: 'text' as const, text: 'hi' }],
    files: null,
    allowedTools: [],
  });

  it('holds `start` until the update has settled, then runs on the installed agent', async () => {
    let state = 'updating';
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const opened = session();
    const service = {
      loadAgent: () => ({ id: 'agent-1', installState: state, adapterKind: 'acp' }),
      settled: () => settled,
      selectionFor: () => ({ model: null, provider: null, providerId: null }),
      targetFor: () => ({ sessionRef: null }),
    };
    const runner = new AgentRunner({
      service: service as unknown as AgentsService,
      adapters: { byKind: () => ({ start: async () => opened.session }) } as unknown as AdapterSet,
      log: capturingLogger().logger,
    });
    let started = false;
    const pending = runner.start(request('r1')).then((accepted) => {
      started = true;
      return accepted;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(false);

    state = 'installed';
    settle();
    await expect(pending).resolves.toMatchObject({ agentSessionRef: 'S-ref' });
  });

  it('knows which agent is busy, and retires its session once the update ends', async () => {
    const opened = session();
    const service = {
      loadAgent: () => ({ id: 'agent-1', installState: 'installed', adapterKind: 'acp' }),
      selectionFor: () => ({ model: null, provider: null, providerId: null }),
      targetFor: () => ({ sessionRef: null }),
    };
    const runner = new AgentRunner({
      service: service as unknown as AgentsService,
      adapters: { byKind: () => ({ start: async () => opened.session }) } as unknown as AdapterSet,
      log: capturingLogger().logger,
    });
    await runner.start(request('r1'));
    expect(runner.busyFor('agent-1')).toBe(true);
    expect(runner.busyFor('agent-2')).toBe(false);
    for await (const event of runner.stream('r1')) void event;
    expect(runner.busyFor('agent-1')).toBe(false);

    // The update ended: the idle session runs the old CLI and is closed.
    runner.retireSessionsOf('agent-1');
    expect(opened.closed.value).toBe(true);
  });
});

describe('update policy: the child an ACP agent starts', () => {
  it("puts the agent's own directory first on PATH, so an adapter drives the CLI beside it", () => {
    const env = agentEnvironment(
      { PATH: ['/usr/bin', '/data/agents/pi/bin'].join(path.delimiter), HOME: '/home/agent' },
      { executablePath: '/data/agents/pi/bin/pi-acp', env: { OPENAI_API_KEY: 'k' } },
    );
    expect(env.PATH).toBe(['/data/agents/pi/bin', '/usr/bin'].join(path.delimiter));
    expect(env).toMatchObject({ HOME: '/home/agent', OPENAI_API_KEY: 'k' });
    // A bare command found on PATH changes nothing.
    expect(agentEnvironment({ PATH: '/usr/bin' }, { executablePath: null }).PATH).toBe('/usr/bin');
  });
});

describe('update policy: the installer', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses anything but an exact released version before it looks for npm', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-installer-'));
    dirs.push(dataDir);
    const installer = createNpmInstaller({ dataDir, host: { pathValue: '' } as never });
    const qwen = catalogEntry('qwen-code')!;
    await expect(
      installer.install(qwen, async () => undefined, { '@qwen-code/qwen-code': 'latest' }),
    ).rejects.toThrow(/not an exact released version/);
  });

  it("checks Pi's health with the CLI its adapter drives, which is the version it reports", async () => {
    if (process.platform === 'win32') return;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-installer-'));
    dirs.push(dataDir);
    const bin = path.join(dataDir, 'agents', 'pi', 'bin');
    mkdirSync(bin, { recursive: true });
    // `pi-acp --version` prints nothing (observed on 0.0.34); `pi --version` prints Pi's.
    writeFileSync(path.join(bin, 'pi-acp'), '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\necho 0.87.1\n');
    chmodSync(path.join(bin, 'pi-acp'), 0o755);
    chmodSync(path.join(bin, 'pi'), 0o755);
    const installer = createNpmInstaller({ dataDir, host: { pathValue: '' } as never });
    const pi = catalogEntry('pi')!;
    expect(installer.isPresent(pi)).toBe(true);
    await expect(installer.health(pi)).resolves.toEqual({
      ok: true,
      version: '0.87.1',
      error: null,
    });
  });
});

describe('update policy: through the hub', () => {
  /** Gemini CLI installed at its pin, as the volume would hold it after a fresh install. */
  const installedAtPin = (gate: Promise<void> = Promise.resolve()) => {
    const installs: Array<Readonly<Record<string, string>> | undefined> = [];
    const installer = fakeInstaller({
      isPresent: (entry: CatalogEntry) => entry.id === 'gemini-cli',
      health: async (entry: CatalogEntry) => ({
        ok: true,
        version: pinnedVersion(entry),
        error: null,
      }),
      async install(entry, _report, versions) {
        installs.push(versions);
        await gate;
        return {
          version: versions?.['@google/gemini-cli'] ?? pinnedVersion(entry),
          executablePath: `/tmp/corehub-test-agents/${entry.id}/bin/${entry.binary}`,
        };
      },
    });
    return { installer, installs };
  };
  const gemini = catalogEntry('gemini-cli')!;
  const pin = pinnedVersion(gemini)!;
  const next = pin.replace(/^(\d+)\.(\d+)\..*$/, (_m, major, minor) => `${major}.${+minor + 1}.0`);

  const geminiOf = async (hub: Awaited<ReturnType<typeof signedInHub>>) => {
    const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
    return (
      listed.json() as {
        items: Array<{
          id: string;
          slug: string;
          install: Record<string, unknown>;
        }>;
      }
    ).items.find((item) => item.slug === 'gemini-cli')!;
  };

  it('check-update asks the registry and offers the newer version, marked past the tested pin', async () => {
    const { installer } = installedAtPin();
    const hub = await signedInHub(
      {},
      { agents: { installer, updates: { registry: registryOf({ '@google/gemini-cli': next }) } } },
    );
    try {
      const agent = await geminiOf(hub);
      expect(agent.install).toMatchObject({
        version: pin,
        pinned_version: pin,
        latest_version: pin,
        update_available: false,
        newer_than_tested: false,
        auto_update: false,
      });
      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/check-update`,
      });
      expect(accepted.statusCode).toBe(202);
      await drainJobs(hub.app);
      const job = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/jobs/${(accepted.json() as { job_id: string }).job_id}`,
      });
      expect(job.json()).toMatchObject({
        status: 'succeeded',
        result: { latest_version: next, pinned_version: pin, update_available: true },
      });
      expect((await geminiOf(hub)).install).toMatchObject({
        latest_version: next,
        update_available: true,
      });
    } finally {
      await hub.close();
    }
  });

  it('check-update fails, rather than says "up to date", when the registry is unreachable', async () => {
    const { installer } = installedAtPin();
    const hub = await signedInHub({}, { agents: { installer } });
    try {
      const agent = await geminiOf(hub);
      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/check-update`,
      });
      await drainJobs(hub.app);
      const job = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/jobs/${(accepted.json() as { job_id: string }).job_id}`,
      });
      expect(job.json()).toMatchObject({ status: 'failed' });
    } finally {
      await hub.close();
    }
  });

  it('an update installs the exact newer version, and the pin stays the tested baseline', async () => {
    const { installer, installs } = installedAtPin();
    const hub = await signedInHub(
      {},
      { agents: { installer, updates: { registry: registryOf({ '@google/gemini-cli': next }) } } },
    );
    try {
      const agent = await geminiOf(hub);
      await agentUpdatesFor(hub.app).checkAll();
      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/update`,
      });
      expect(accepted.statusCode).toBe(202);
      await drainJobs(hub.app);
      expect(installs).toEqual([{ '@google/gemini-cli': next }]);
      expect((await geminiOf(hub)).install).toMatchObject({
        version: next,
        pinned_version: pin,
        latest_version: next,
        update_available: false,
        newer_than_tested: true,
      });
    } finally {
      await hub.close();
    }
  });

  it('auto-update, once switched on, takes the update from the periodic check', async () => {
    let release!: () => void;
    const { installer, installs } = installedAtPin(new Promise((resolve) => (release = resolve)));
    const hub = await signedInHub(
      {},
      { agents: { installer, updates: { registry: registryOf({ '@google/gemini-cli': next }) } } },
    );
    try {
      const agent = await geminiOf(hub);
      // Off by default: the check only records.
      expect((await agentUpdatesFor(hub.app).checkAll()).started).toEqual([]);
      const patched = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${agent.id}`,
        payload: { auto_update: true },
      });
      expect(patched.statusCode).toBe(200);
      expect((await agentUpdatesFor(hub.app).checkAll()).started).toEqual(['gemini-cli']);
      // While the job runs the agent is `updating`, and `settled` — what a turn asked for
      // now waits on (`AgentRunner.start`) — has not resolved.
      const service = agentsServiceFor(hub.app);
      expect(service.loadAgent(agent.id).installState).toBe('updating');
      let settled = false;
      const waiting = service.settled(agent.id).then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      release();
      await drainJobs(hub.app);
      await waiting;
      expect(service.loadAgent(agent.id).installState).toBe('installed');
      expect(installs).toEqual([{ '@google/gemini-cli': next }]);
      expect((await geminiOf(hub)).install).toMatchObject({
        version: next,
        newer_than_tested: true,
      });
    } finally {
      await hub.close();
    }
  });
});
