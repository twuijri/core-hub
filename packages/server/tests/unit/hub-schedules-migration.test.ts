// drizzle/0011_hub_schedules_fire.sql rebuilds `approvals` (a workflow step's gate has no
// session run) inside the migrator's transaction, where `PRAGMA foreign_keys=OFF` does
// nothing — so dropping the old table would null every `tool_calls.approval_id`. The
// migration keeps those links aside and puts them back; this is the check that it does.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { newUlid } from '../../src/db/ids.js';

const TAG = '0011_hub_schedules_fire';

function folderBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-migration-'));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalFile = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === tag);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalFile, JSON.stringify(journal));
  return dir;
}

describe(`migration ${TAG}`, () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every approval and every tool call that points at one', () => {
    const before = folderBefore(TAG);
    cleanup.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: before });

    const now = Date.now();
    const ids = {
      owner: newUlid(now),
      ws: newUlid(now),
      agent: newUlid(now),
      session: newUlid(now),
      run: newUlid(now),
      approval: newUlid(now),
      linked: newUlid(now),
      plain: newUlid(now),
    };
    sqlite
      .prepare(
        `INSERT INTO sessions (id, owner_id, created_at, updated_at, workspace, agent_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ids.session, ids.owner, now, now, ids.ws, ids.agent);
    sqlite
      .prepare(
        `INSERT INTO runs (id, owner_id, created_at, updated_at, workspace, session_id, agent_id, job_id, adapter_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hermes')`,
      )
      .run(ids.run, ids.owner, now, now, ids.ws, ids.session, ids.agent, newUlid(now));
    sqlite
      .prepare(
        `INSERT INTO approvals (id, owner_id, created_at, updated_at, workspace, run_id, kind, status, title, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tool_call', 'approved', 'تشغيل أمر', ?)`,
      )
      .run(ids.approval, ids.owner, now, now, ids.ws, ids.run, now);
    const call = sqlite.prepare(
      `INSERT INTO tool_calls (id, owner_id, created_at, updated_at, workspace, run_id, seq, name, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'shell', ?)`,
    );
    call.run(ids.linked, ids.owner, now, now, ids.ws, ids.run, 1, ids.approval);
    call.run(ids.plain, ids.owner, now, now, ids.ws, ids.run, 2, null);

    migrate(db, { migrationsFolder });

    const approval = sqlite.prepare('SELECT * FROM approvals WHERE id = ?').get(ids.approval) as {
      run_id: string;
      workflow_run_id: string | null;
      node_id: string | null;
      status: string;
    };
    expect(approval).toMatchObject({
      run_id: ids.run,
      workflow_run_id: null,
      node_id: null,
      status: 'approved',
    });
    const calls = sqlite.prepare('SELECT id, approval_id FROM tool_calls ORDER BY seq').all() as {
      id: string;
      approval_id: string | null;
    }[];
    expect(calls).toEqual([
      { id: ids.linked, approval_id: ids.approval },
      { id: ids.plain, approval_id: null },
    ]);
    // A gate with no run is now a row the table accepts.
    sqlite
      .prepare(
        `INSERT INTO approvals (id, owner_id, created_at, updated_at, workspace, workflow_run_id, node_id, kind, title, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, 'gate', 'workflow_step', 'انشر؟', ?)`,
      )
      .run(newUlid(now), ids.owner, now, now, ids.ws, newUlid(now), now);
    // The foreign keys are whole after the rebuild.
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = '__keep_tool_call_approvals'")
        .all(),
    ).toEqual([]);
    const columns = (
      sqlite.prepare('PRAGMA table_info(schedule_runs)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['session_id', 'trigger']));
  });
});
