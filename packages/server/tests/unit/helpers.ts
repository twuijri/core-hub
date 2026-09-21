import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { loadConfig, type EnvSource } from '../../src/app/config.js';
import { buildServer, type BuildOptions } from '../../src/app/server.js';
import { createLogger } from '../../src/lib/logger.js';
import type { HubModule } from '../../src/lib/module.js';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import {
  overrideAgents,
  type AgentInstaller,
  type AgentsOverrides,
} from '../../src/modules/agents/index.js';
import { jobRunnerFor } from '../../src/modules/audit/index.js';
import type { AdapterSet } from '../../src/modules/agents/adapters/index.js';
import type { AgentAdapter, AgentProbe } from '../../src/modules/agents/adapters/types.js';

export const TEST_ADMIN_PASSWORD = 'owner-password-1';

/** Every request refuses to connect, like a port with nothing behind it. */
export const unreachableFetch: typeof fetch = () =>
  Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

export interface TestHub {
  app: FastifyInstance;
  dataDir: string;
  close(): Promise<void>;
}

/** Builds the hub on a fresh SQLite file in a temp DATA_DIR with a silent logger. */
export interface TestHubOptions extends Omit<BuildOptions, 'config' | 'logger'> {
  /** Fakes for the agents module; see `overrideAgents`. */
  agents?: AgentsOverrides;
}

export async function testHub(env: EnvSource = {}, options: TestHubOptions = {}): Promise<TestHub> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'majlis-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', ...env });
  const { agents: agentOverrides, ...build } = options;
  // The suite must say the same thing on every machine: a PATH with nothing on it, and a
  // Hermes gateway probe that always fails, so a Hermes running on the developer's own
  // box cannot change a result.
  overrideAgents({
    pathValue: path.join(dataDir, 'no-such-bin'),
    adapterOptions: { hermes: { fetchImpl: unreachableFetch } },
    ...agentOverrides,
  });
  const app = await buildServer({
    config,
    logger: createLogger({ level: 'silent' }),
    webDir: null,
    ...build,
  });
  return {
    app,
    dataDir,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A hub with the owner account already created, plus a signed-in access token. */
export async function signedInHub(
  env: EnvSource = {},
  options: TestHubOptions = {},
): Promise<TestHub & { token: string; refreshToken: string; userId: string }> {
  const hub = await testHub({ HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD, ...env }, options);
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`test sign-in failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as {
    access_token: string;
    refresh_token: string;
    user: { id: string };
  };
  return {
    ...hub,
    token: body.access_token,
    refreshToken: body.refresh_token,
    userId: body.user.id,
  };
}

/** Authenticated `inject` with the workspace header every scoped operation needs. */
export function authed(
  hub: { app: FastifyInstance },
  token: string,
  init: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    url: string;
    payload?: unknown;
    profile?: string;
    headers?: Record<string, string>;
  },
) {
  return hub.app.inject({
    method: init.method,
    url: init.url,
    ...(init.payload !== undefined ? { payload: init.payload } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      'x-hub-profile': init.profile ?? 'default',
      ...init.headers,
    },
  });
}

/** An installer that records what it was asked to do instead of touching npm. */
export function fakeInstaller(
  overrides: Partial<AgentInstaller> = {},
): AgentInstaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    root: '/tmp/majlis-test-agents',
    binDirFor: (id: string) => `/tmp/majlis-test-agents/${id}/bin`,
    isPresent: () => false,
    async install(entry, report) {
      calls.push(`install:${entry.id}`);
      await report(50, 'downloading');
      return {
        version: '1.2.3',
        executablePath: `/tmp/majlis-test-agents/${entry.id}/bin/${entry.binary}`,
      };
    },
    async uninstall(entry) {
      calls.push(`uninstall:${entry.id}`);
    },
    async health(entry) {
      calls.push(`health:${entry.id}`);
      return { ok: true, version: '1.2.3', error: null };
    },
    ...overrides,
  } as AgentInstaller & { calls: string[] };
}

/** An adapter set that finds nothing, so a test never depends on the developer's machine. */
export function emptyAdapterSet(probe?: () => AgentProbe): AdapterSet {
  const answer =
    probe ??
    (() => ({
      installed: false,
      source: 'none' as const,
      executablePath: null,
      version: null,
      runtime: { state: 'not_applicable' as const, url: null, error: null },
      error: null,
    }));
  const make = (kind: AgentAdapter['kind'], selectable: boolean): AgentAdapter => ({
    kind,
    name: kind,
    version: 'test',
    selectable,
    capabilities: () => [],
    discover: async () => [],
    probe: async () => answer(),
    settings: () => [],
    start: async () => {
      throw new Error('not in this test');
    },
  });
  const adapters: Partial<Record<AgentAdapter['kind'], AgentAdapter>> = {
    hermes: make('hermes', true),
    acp: make('acp', true),
    harness: make('harness', false),
  };
  return {
    ...adapters,
    byKind(kind) {
      const adapter = adapters[kind];
      if (!adapter) throw new Error(`no adapter ${kind}`);
      return adapter;
    },
    all: () => Object.values(adapters).filter((a): a is AgentAdapter => !!a),
  } as AdapterSet;
}

/** Waits for every background job worker of this hub to settle. */
export function drainJobs(app: FastifyInstance): Promise<void> {
  return jobRunnerFor(app).drain();
}

/** Collects log lines written by a logger for assertions. */
export function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      callback();
    },
  });
  return { logger: createLogger({ level: 'debug', destination }), lines };
}

/** Shared assertion for the per-module tests: the app composes the module and calls both hooks. */
export async function expectModuleRegistered(module: HubModule): Promise<void> {
  const routes = vi.spyOn(module, 'registerRoutes');
  const events = vi.spyOn(module, 'registerEvents');
  const hub = await testHub();
  try {
    expect(hub.app.hub.modules).toContain(module.name);
    expect(routes).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(1);
    const namespace = (REALTIME_NAMESPACES as Partial<Record<string, string>>)[module.name];
    if (namespace) expect(hub.app.hub.namespaces).toContain(namespace);
  } finally {
    routes.mockRestore();
    events.mockRestore();
    await hub.close();
  }
}
