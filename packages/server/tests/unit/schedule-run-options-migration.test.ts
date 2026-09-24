// drizzle/0013_schedule_run_options.sql gives every schedule the owner's defaults for the two
// run options (2026-09-24): a missed time does not run late (`misfire_policy = skip`), and a
// time that comes while the previous run goes waits for it (`overlap = wait`). It adds
// columns only — no rebuild — so a schedule's history survives it untouched.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { newUlid } from '../../src/db/ids.js';

const TAG = '0013_schedule_run_options';

function folderBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-migration-'));
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

  it("gives existing schedules the owner's defaults and keeps their history", () => {
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
      schedule: newUlid(now),
      line: newUlid(now),
    };
    sqlite
      .prepare(
        `INSERT INTO schedules (id, owner_id, created_at, updated_at, workspace, name, kind, interval_seconds, overlap_policy, misfire_policy)
         VALUES (?, ?, ?, ?, ?, 'تقرير', 'interval', 300, 'skip', 'skip')`,
      )
      .run(ids.schedule, ids.owner, now, now, ids.ws);
    sqlite
      .prepare(
        `INSERT INTO schedule_runs (id, owner_id, created_at, updated_at, workspace, schedule_id, scheduled_for, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded')`,
      )
      .run(ids.line, ids.owner, now, now, ids.ws, ids.schedule, now);

    migrate(db, { migrationsFolder });

    expect(
      sqlite
        .prepare('SELECT misfire_policy, overlap FROM schedules WHERE id = ?')
        .get(ids.schedule),
    ).toEqual({ misfire_policy: 'skip', overlap: 'wait' });
    expect(
      sqlite.prepare('SELECT status, waiting FROM schedule_runs WHERE id = ?').get(ids.line),
    ).toEqual({ status: 'succeeded', waiting: 0 });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
