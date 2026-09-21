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

export interface TestHub {
  app: FastifyInstance;
  dataDir: string;
  close(): Promise<void>;
}

/** Builds the hub on a fresh SQLite file in a temp DATA_DIR with a silent logger. */
export async function testHub(
  env: EnvSource = {},
  options: Omit<BuildOptions, 'config' | 'logger'> = {},
): Promise<TestHub> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'majlis-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', ...env });
  const app = await buildServer({ config, logger: createLogger({ level: 'silent' }), ...options });
  return {
    app,
    dataDir,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
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
