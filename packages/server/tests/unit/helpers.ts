import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { loadConfig, type EnvSource } from '../../src/app/config.js';
import { buildServer, type BuildOptions } from '../../src/app/server.js';
import { packageRoot } from '../../src/app/db.js';
import type { ModuleDatabase } from '../../src/db/handle.js';
import { createLogger } from '../../src/lib/logger.js';
import type { HubModule } from '../../src/lib/module.js';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import {
  overrideAgents,
  type AgentInstaller,
  type AgentsOverrides,
} from '../../src/modules/agents/index.js';
import { overrideModels, type ModelsOverrides } from '../../src/modules/models/index.js';
import { jobRunnerFor } from '../../src/modules/audit/index.js';
import type { AdapterSet } from '../../src/modules/agents/adapters/index.js';
import type { AgentAdapter, AgentProbe } from '../../src/modules/agents/adapters/types.js';

export const TEST_ADMIN_PASSWORD = 'owner-password-1';

/**
 * The debounce the suite runs with: long enough that the several writes one save makes
 * still coalesce into one restart (which is the behaviour under test), short enough that
 * no test waits for it.
 */
export const TEST_RESTART_DELAY_MS = 30;

/** Lets the debounced Hermes restart fire. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, TEST_RESTART_DELAY_MS * 4));

/** Every request refuses to connect, like a port with nothing behind it. */
export const unreachableFetch: typeof fetch = () =>
  Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

export interface TestHub {
  app: FastifyInstance;
  dataDir: string;
  close(): Promise<void>;
}

/**
 * Builds the hub on a fresh SQLite file in a temp DATA_DIR with a silent logger. Pass
 * `logger` (see `capturingLogger`) when the test asserts on what the hub logged at boot.
 */
export interface TestHubOptions extends Omit<BuildOptions, 'config'> {
  /** Fakes for the agents module; see `overrideAgents`. */
  agents?: AgentsOverrides;
  /** Fakes for the models module: a scripted provider `fetch`; see `overrideModels`. */
  models?: ModelsOverrides;
}

export async function testHub(env: EnvSource = {}, options: TestHubOptions = {}): Promise<TestHub> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', ...env });
  const { agents: agentOverrides, models: modelOverrides, ...build } = options;
  // The suite must say the same thing on every machine: a PATH with nothing on it, and a
  // Hermes gateway probe that always fails, so a Hermes running on the developer's own
  // box cannot change a result.
  overrideAgents({
    pathValue: path.join(dataDir, 'no-such-bin'),
    adapterOptions: { hermes: { fetchImpl: unreachableFetch } },
    ...agentOverrides,
  });
  // No provider adapter may reach the network from a test, for the same reason: the
  // suite must say the same thing on every machine.
  // A restart is debounced in production (a save is several writes); in a test it must
  // be one macrotask away, or every assertion about it would need a sleep.
  overrideModels({
    fetchImpl: unreachableFetch,
    restartDelayMs: TEST_RESTART_DELAY_MS,
    ...modelOverrides,
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

/**
 * A bare module database: the real schema on an in-memory SQLite file, with no hub in
 * front of it. For the rules a module can state without a request — a report's sums, a
 * store's ordering — where booting a whole hub would only make the test slower and the
 * failure harder to read.
 */
export function memoryDb(): ModuleDatabase {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  migrateSqlite(db, { migrationsFolder: path.join(packageRoot, 'drizzle') });
  return db;
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
    root: '/tmp/corehub-test-agents',
    binDirFor: (id: string) => `/tmp/corehub-test-agents/${id}/bin`,
    isPresent: () => false,
    async install(entry, report) {
      calls.push(`install:${entry.id}`);
      await report(50, 'downloading');
      return {
        version: '1.2.3',
        executablePath: `/tmp/corehub-test-agents/${entry.id}/bin/${entry.binary}`,
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
