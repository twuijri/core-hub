// drizzle/0013_attachments_shared_bytes.sql (contract decision §39): `attachments.storage_key`
// stops being unique. The key is the content hash, so every upload of the same bytes in a
// workspace points at it; the unique index turned a second upload (after a delete, or under
// another name) into a 500. Every existing row — live or deleted — survives unchanged.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { newUlid } from '../../src/db/ids.js';

const TAG = '0013_attachments_shared_bytes';

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

  it('keeps every attachment row and lets two rows share a storage key', () => {
    const before = folderBefore(TAG);
    cleanup.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: before });

    const now = Date.now();
    const owner = newUlid(now);
    const ws = { def: newUlid(now), design: newUlid(now) };
    const sha = 'ab'.repeat(32);
    const key = (workspace: string) => `${workspace}/ab/${sha}`;
    const insert = sqlite.prepare(
      `INSERT INTO attachments (id, owner_id, created_at, updated_at, workspace, filename, mime,
         size_bytes, sha256, storage_key, kind, source_kind, meta, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'image/png', 32, ?, ?, 'image', 'upload', '{"purpose":"message"}', ?)`,
    );
    const ids = { live: newUlid(now), deleted: newUlid(now), other: newUlid(now) };
    insert.run(ids.live, owner, now, now, ws.def, 'shot.png', sha, key(ws.def), null);
    insert.run(ids.deleted, owner, now, now, ws.design, 'gone.png', sha, key(ws.design), now);
    insert.run(ids.other, owner, now, now, ws.design, 'report.pdf', 'cd'.repeat(32), 'k', null);

    // Before: the second row for the same bytes is refused — the bug.
    expect(() =>
      insert.run(newUlid(now), owner, now, now, ws.def, 'copy.png', sha, key(ws.def), null),
    ).toThrow(/UNIQUE/);

    migrate(db, { migrationsFolder });

    const rows = sqlite
      .prepare('SELECT id, workspace, filename, storage_key, deleted_at FROM attachments ORDER BY id')
      .all() as {
      id: string;
      workspace: string;
      filename: string;
      storage_key: string;
      deleted_at: number | null;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === ids.live)).toMatchObject({
      workspace: ws.def,
      filename: 'shot.png',
      storage_key: key(ws.def),
      deleted_at: null,
    });
    expect(rows.find((row) => row.id === ids.deleted)).toMatchObject({
      workspace: ws.design,
      storage_key: key(ws.design),
      deleted_at: now,
    });

    // After: the same bytes again, under another name and over a deleted row.
    insert.run(newUlid(now), owner, now, now, ws.def, 'copy.png', sha, key(ws.def), null);
    insert.run(newUlid(now), owner, now, now, ws.design, 'gone.png', sha, key(ws.design), null);
    expect(
      (
        sqlite
          .prepare('SELECT count(*) AS n FROM attachments WHERE storage_key = ?')
          .get(key(ws.def)) as { n: number }
      ).n,
    ).toBe(2);

    const indexes = (
      sqlite.prepare("PRAGMA index_list('attachments')").all() as { name: string; unique: number }[]
    ).map((index) => `${index.name}:${index.unique}`);
    expect(indexes).toContain('attachments_workspace_storage_key_idx:0');
    expect(indexes.some((name) => name.startsWith('attachments_storage_key_uq'))).toBe(false);
    sqlite.close();
  });
});
