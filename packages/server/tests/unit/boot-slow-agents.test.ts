/**
 * A hub starts in moments whatever its volume holds (the owner's hub of 2026-09-29).
 *
 * That hub restarted in a loop — `AVV_ERR_PLUGIN_EXEC_TIMEOUT`, "Plugin did not start in time"
 * — on every image, old and new: mounting the API waited for each installed agent's health
 * check, and Claude Code's (`claude-code-acp --version`) never answered, so it waited its full
 * 30 s while Fastify gives the whole API 10 s. Here the volume holds the same kind of thing: an
 * installed agent whose check hangs, one that answers only once its stdin is closed, hundreds
 * of conversations, and workflow runs a restart cut short (one of them waiting on a
 * conversation with a turn going on). The hub must mount and answer `/health` at once, and the
 * agents are still checked — after it is ready, each bounded. (Since the same day's codex-acp
 * report, a check that runs and says no, or is cut at its deadline, no longer marks an installed
 * agent failed: `HealthCheck` in `catalog/types.ts`.)
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildServer } from '../../src/app/server.js';
import { newUlid } from '../../src/db/ids.js';
import { createLogger } from '../../src/lib/logger.js';
import { overrideAgents } from '../../src/modules/agents/index.js';
import { overrideModels } from '../../src/modules/models/index.js';
import { TEST_ADMIN_PASSWORD, unreachableFetch } from './helpers.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(dataDir: string): Promise<{ app: FastifyInstance; ms: number }> {
  overrideAgents({
    pathValue: path.join(dataDir, 'no-such-bin'),
    adapterOptions: { hermes: { fetchImpl: unreachableFetch } },
    updates: {
      registry: { latest: () => Promise.reject(new Error('no registry in tests')) },
      intervalMs: null,
    },
    // The real installer, reading `<DATA_DIR>/agents`; a short deadline so the test is quick.
    bootHealthTimeoutMs: 300,
  });
  overrideModels({ fetchImpl: unreachableFetch, restartDelayMs: 30 });
  const began = performance.now();
  const app = await buildServer({
    config: loadConfig({
      DATA_DIR: dataDir,
      PORT: '0',
      HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      COREHUB_MODELS_CATALOG_URL: 'off',
      COREHUB_PUSH_RELAY: 'off',
    }),
    logger: createLogger({ level: 'silent' }),
    webDir: null,
  });
  apps.push(app);
  await app.ready();
  return { app, ms: performance.now() - began };
}

function agentBinary(dataDir: string, id: string, binary: string, body: string): void {
  const bin = path.join(dataDir, 'agents', id, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, binary), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, binary), 0o755);
}

/** The package's own `package.json`, where npm puts it under the agent's prefix. */
function agentPackage(dataDir: string, id: string, name: string, version: string): void {
  const dir = path.join(dataDir, 'agents', id, 'lib', 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
}

/** Many conversations, and workflow runs a restart cut short, as the owner's volume had. */
function seed(file: string): void {
  const db = new Database(file);
  try {
    const workspace = (db.prepare('select id from workspaces').get() as { id: string }).id;
    const owner = (db.prepare('select id from users').get() as { id: string }).id;
    const agent = (
      db.prepare("select id from agents where slug = 'hermes'").get() as { id: string }
    ).id;
    const now = Date.now();
    const session = db.prepare(
      `insert into sessions (id, owner_id, created_at, updated_at, workspace, agent_id, title,
         source, channel, last_message_at, message_count) values (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const run = db.prepare(
      `insert into runs (id, owner_id, created_at, updated_at, workspace, session_id, agent_id,
         status, job_id, adapter_kind, started_at) values (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const message = db.prepare(
      `insert into messages (id, owner_id, created_at, updated_at, workspace, session_id, run_id,
         seq, role, author_kind, content) values (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const sessions: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < 400; i++) {
        const id = newUlid();
        const channel = i % 3 === 0;
        session.run(
          id,
          owner,
          now,
          now,
          workspace,
          agent,
          `Conversation ${i}`,
          channel ? 'channel' : 'chat',
          channel ? 'telegram' : null,
          now,
          4,
        );
        sessions.push(id);
        for (let turn = 0; turn < 2; turn++) {
          const runId = newUlid();
          run.run(
            runId,
            owner,
            now,
            now,
            workspace,
            id,
            agent,
            'succeeded',
            newUlid(),
            'hermes',
            now,
          );
          message.run(
            newUlid(),
            owner,
            now,
            now,
            workspace,
            id,
            runId,
            turn * 2 + 1,
            'user',
            'user',
            'hi',
          );
          message.run(
            newUlid(),
            owner,
            now,
            now,
            workspace,
            id,
            runId,
            turn * 2 + 2,
            'assistant',
            'agent',
            'hello',
          );
        }
      }
      // A conversation with a turn going on when the hub stopped.
      const busy = sessions[0]!;
      run.run(
        newUlid(),
        owner,
        now,
        now,
        workspace,
        busy,
        agent,
        'streaming',
        newUlid(),
        'hermes',
        now,
      );
      // A workflow whose agent step talks in that conversation (§136), with runs cut short.
      const definition = JSON.stringify({
        nodes: [
          { id: 'start', kind: 'trigger', title: 'ClickUp' },
          {
            id: 'agent',
            kind: 'agent',
            title: 'Agent',
            agent_id: agent,
            input: 'Task {{trigger.task_id}}',
            conversation: { mode: 'reuse', session_id: busy },
          },
        ],
        edges: [{ from: 'start', to: 'agent' }],
      });
      const workflow = newUlid();
      db.prepare(
        `insert into workflows (id, owner_id, created_at, updated_at, workspace, name, version,
           definition, trigger_kind) values (?,?,?,?,?,?,?,?,?)`,
      ).run(workflow, owner, now, now, workspace, 'ClickUp flow', 1, definition, 'event');
      for (const status of ['running', 'running', 'queued', 'waiting_approval', 'succeeded']) {
        const id = newUlid();
        db.prepare(
          `insert into workflow_runs (id, owner_id, created_at, updated_at, workspace, workflow_id,
             trigger_kind, status, workflow_version, definition_snapshot, input, active_node_keys,
             started_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          owner,
          now,
          now,
          workspace,
          workflow,
          'event',
          status,
          1,
          definition,
          '{"task_id":"1"}',
          status === 'succeeded' ? '[]' : '["agent"]',
          now,
        );
        db.prepare(
          `insert into node_runs (id, owner_id, created_at, updated_at, workspace, workflow_run_id,
             node_key, node_type, status, started_at) values (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          newUlid(),
          owner,
          now,
          now,
          workspace,
          id,
          'agent',
          'agent_run',
          status === 'succeeded' ? 'succeeded' : 'running',
          now,
        );
      }
    })();
  } finally {
    db.close();
  }
}

function agentRow(file: string, slug: string) {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .prepare('select install_state, version, last_error from agents where slug = ?')
      .get(slug) as { install_state: string; version: string | null; last_error: string | null };
  } finally {
    db.close();
  }
}

describe.skipIf(process.platform === 'win32')('a hub booting on a full volume', () => {
  it('mounts and answers /health at once, and checks its agents after, each bounded', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-boot-'));
    dirs.push(dataDir);
    const file = path.join(dataDir, 'hub.sqlite');

    // First boot: the owner account and the catalog's rows.
    const first = await boot(dataDir);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    seed(file);
    // Gemini's version check hangs; Codex's bridge reads its stdin to the end and then refuses
    // `--version` (as codex-acp does, exit 2); Claude Code's bridge would serve ACP forever.
    agentBinary(dataDir, 'gemini-cli', 'gemini', 'exec sleep 600');
    agentBinary(
      dataDir,
      'codex',
      'codex-acp',
      'cat >/dev/null\necho "error: unexpected argument \'--version\' found" >&2\nexit 2',
    );
    agentBinary(dataDir, 'claude-code', 'claude-code-acp', 'exec sleep 600');
    agentPackage(dataDir, 'gemini-cli', '@google/gemini-cli', '0.60.0');
    agentPackage(dataDir, 'codex', '@zed-industries/codex-acp', '0.16.0');

    const { app, ms } = await boot(dataDir);
    // Mounting ran no agent CLI; getting ready waits at most a moment for their checks.
    expect(ms).toBeLessThan(4_000);
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);

    // The checks go on after the hub is ready, and each one ends: the one that hung is cut at
    // its deadline, and none of them is an error — the programs are there, npm says which
    // version, and a bridge without `--version` is not a broken install.
    let gemini = agentRow(file, 'gemini-cli');
    for (let i = 0; i < 100 && gemini.install_state !== 'installed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      gemini = agentRow(file, 'gemini-cli');
    }
    expect(gemini).toMatchObject({
      install_state: 'installed',
      version: '0.60.0',
      last_error: null,
    });
    expect(agentRow(file, 'codex')).toMatchObject({
      install_state: 'installed',
      version: '0.16.0',
      last_error: null,
    });
    expect(agentRow(file, 'claude-code')).toMatchObject({ install_state: 'installed' });
  }, 60_000);
});
