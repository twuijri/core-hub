// drizzle/0035_device_screen_tasks.sql copies `devices`, `device_requests` and `usage_records`
// to widen three CHECKs (ADR 0033: platform `dsh`, capability `screen_task`, usage origin
// `external`) inside the migrator's transaction, where `PRAGMA foreign_keys=OFF` does nothing —
// so dropping `devices` first would delete every request that points at it (ON DELETE CASCADE).
// The migration points the new requests table at the new devices table instead; this is the check
// that every row survives, the reference still cascades, and the new values are accepted.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { newUlid } from '../../src/db/ids.js';

const TAG = '0035_device_screen_tasks';

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

  it('keeps every device, request and usage row, and accepts the new values', () => {
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
      device: newUlid(now),
      request: newUlid(now),
      usage: newUlid(now),
    };
    const addDevice = sqlite.prepare(
      `INSERT INTO devices (id, owner_id, created_at, updated_at, device_key, name, platform, kind, capabilities, paired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'computer', '[]', ?)`,
    );
    addDevice.run(ids.device, ids.owner, now, now, 'key-1', 'حاسوب طارق', 'macos', now);
    const addRequest = sqlite.prepare(
      `INSERT INTO device_requests (id, owner_id, created_at, updated_at, workspace, device_id, capability, job_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    addRequest.run(ids.request, ids.owner, now, now, ids.ws, ids.device, 'files', newUlid(), now);
    const addUsage = sqlite.prepare(
      `INSERT INTO usage_records (id, owner_id, created_at, updated_at, workspace, run_id, session_id, agent_id, model_label, origin_kind, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gpt', ?, ?)`,
    );
    addUsage.run(
      ids.usage,
      ids.owner,
      now,
      now,
      ids.ws,
      newUlid(),
      newUlid(),
      newUlid(),
      'user',
      now,
    );
    // Before: the new values are refused.
    expect(() => addDevice.run(newUlid(), ids.owner, now, now, 'key-2', 'x', 'dsh', now)).toThrow(
      /CHECK/,
    );

    migrate(db, { migrationsFolder });

    expect(sqlite.prepare('SELECT id, platform FROM devices').all()).toEqual([
      { id: ids.device, platform: 'macos' },
    ]);
    expect(sqlite.prepare('SELECT id, capability FROM device_requests').all()).toEqual([
      { id: ids.request, capability: 'files' },
    ]);
    expect(sqlite.prepare('SELECT id, origin_kind FROM usage_records').all()).toEqual([
      { id: ids.usage, origin_kind: 'user' },
    ]);
    // The requests table points at `devices` again, and still cascades.
    const fks = sqlite
      .prepare('SELECT "table", on_delete FROM pragma_foreign_key_list(\'device_requests\')')
      .all();
    expect(fks).toEqual([{ table: 'devices', on_delete: 'CASCADE' }]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const dsh = newUlid();
    addDevice.run(dsh, ids.owner, now, now, 'key-3', 'DeepSeek Harness', 'dsh', now);
    addRequest.run(newUlid(), ids.owner, now, now, ids.ws, dsh, 'screen_task', newUlid(), now);
    addUsage.run(
      newUlid(),
      ids.owner,
      now,
      now,
      ids.ws,
      newUlid(),
      newUlid(),
      newUlid(),
      'external',
      now,
    );
    expect(() =>
      addRequest.run(newUlid(), ids.owner, now, now, ids.ws, dsh, 'teleport', newUlid(), now),
    ).toThrow(/CHECK/);

    sqlite.prepare('DELETE FROM devices WHERE id = ?').run(dsh);
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM device_requests WHERE device_id = ?').get(dsh),
    ).toEqual({ n: 0 });
    sqlite.close();
  });
});
