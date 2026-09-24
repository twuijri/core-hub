// drizzle/0010_member_profiles_explicit.sql: members whose list was empty (which used to mean
// "every workspace") are enrolled explicitly in the workspaces that exist when it runs, so
// they keep today's access and nothing created later.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { ULID_PATTERN, newUlid } from '../../src/db/ids.js';

const TAG = '0010_member_profiles_explicit';

/** The migrations folder as it was just before `TAG`: the hub an upgrade starts from. */
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

  it('enrolls empty-list members in the workspaces that exist now, and nobody else', () => {
    const before = folderBefore(TAG);
    cleanup.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: before });

    const now = Date.now();
    const ids = {
      owner: newUlid(now),
      admin: newUlid(now),
      unlisted: newUlid(now),
      disabled: newUlid(now),
      listed: newUlid(now),
      def: newUlid(now),
      work: newUlid(now),
      gone: newUlid(now),
    };
    const user = sqlite.prepare(
      `INSERT INTO users (id, owner_id, created_at, updated_at, username, role, status, password_hash, locale)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'x', 'ar')`,
    );
    user.run(ids.owner, ids.owner, now, now, 'admin', 'owner', 'active');
    user.run(ids.admin, ids.owner, now, now, 'adm', 'admin', 'active');
    user.run(ids.unlisted, ids.owner, now, now, 'fff', 'member', 'active');
    user.run(ids.disabled, ids.owner, now, now, 'old', 'member', 'disabled');
    user.run(ids.listed, ids.owner, now, now, 'sara', 'member', 'active');
    const workspace = sqlite.prepare(
      `INSERT INTO workspaces (id, owner_id, created_at, updated_at, slug, name, is_default, settings, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    );
    workspace.run(ids.def, ids.owner, now, now, 'default', 'Default', 1, null);
    workspace.run(ids.work, ids.owner, now, now, 'work', 'Work', 0, null);
    workspace.run(ids.gone, ids.owner, now, now, 'gone', 'Gone', 0, now);
    sqlite
      .prepare(
        `INSERT INTO workspace_members (id, owner_id, created_at, updated_at, workspace, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newUlid(now), ids.owner, now, now, ids.work, ids.listed);

    migrate(db, { migrationsFolder });

    const rows = sqlite
      .prepare('SELECT id, owner_id, workspace, user_id, created_at FROM workspace_members')
      .all() as {
      id: string;
      owner_id: string;
      workspace: string;
      user_id: string;
      created_at: number;
    }[];
    const of = (userId: string) =>
      rows
        .filter((row) => row.user_id === userId)
        .map((row) => row.workspace)
        .sort();

    // Everyone who used to enter everything keeps what exists — archived workspaces excluded.
    expect(of(ids.unlisted)).toEqual([ids.def, ids.work].sort());
    expect(of(ids.disabled)).toEqual([ids.def, ids.work].sort());
    // An explicit list is left exactly as it was; owners and admins need no rows.
    expect(of(ids.listed)).toEqual([ids.work]);
    expect(of(ids.admin)).toEqual([]);
    expect(of(ids.owner)).toEqual([]);
    for (const row of rows) {
      expect(row.id).toMatch(ULID_PATTERN);
      expect(row.owner_id).toBe(ids.owner);
      expect(Math.abs(row.created_at - Date.now())).toBeLessThan(60_000);
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);

    // A workspace created after the migration is nobody's until an admin grants it.
    const later = newUlid();
    workspace.run(later, ids.owner, now, now, 'later', 'Later', 0, null);
    const holders = sqlite
      .prepare('SELECT user_id FROM workspace_members WHERE workspace = ?')
      .all(later);
    expect(holders).toEqual([]);
    sqlite.close();
  });

  it('does nothing on a hub with no members', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    const count = sqlite.prepare('SELECT count(*) AS n FROM workspace_members').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
    sqlite.close();
  });
});
