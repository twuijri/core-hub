// drizzle/0012_provider_scope.sql (contract decision §38): providers gain a scope. Every row
// older than it — each profile had its own until then — stays its profile's own, where it
// was, with its key: nothing merged, nothing lost. The same preset may now be a profile's
// own and shared at once.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { newUlid } from '../../src/db/ids.js';

const TAG = '0012_provider_scope';

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

  it("keeps every existing provider as its own profile's, key included", () => {
    const before = folderBefore(TAG);
    cleanup.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: before });

    const now = Date.now();
    const owner = newUlid(now);
    const ws = { def: newUlid(now), design: newUlid(now) };
    const workspace = sqlite.prepare(
      `INSERT INTO workspaces (id, owner_id, created_at, updated_at, slug, name, is_default, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    );
    workspace.run(ws.def, owner, now, now, 'default', 'Default', 1);
    workspace.run(ws.design, owner, now, now, 'design', 'Design', 0);
    const secret = sqlite.prepare(
      `INSERT INTO secrets (id, owner_id, created_at, updated_at, workspace, name, kind, ciphertext, nonce, key_id)
       VALUES (?, ?, ?, ?, ?, 'provider:openai', 'api_key', 'c', 'n', 'k1')`,
    );
    const provider = sqlite.prepare(
      `INSERT INTO providers (id, owner_id, created_at, updated_at, workspace, slug, label, kind, family, api_key_secret_id)
       VALUES (?, ?, ?, ?, ?, 'openai', 'OpenAI', 'llm', 'openai', ?)`,
    );
    const ids = {
      def: newUlid(now),
      design: newUlid(now),
      sDef: newUlid(now),
      sDesign: newUlid(now),
    };
    secret.run(ids.sDef, owner, now, now, ws.def);
    secret.run(ids.sDesign, owner, now, now, ws.design);
    provider.run(ids.def, owner, now, now, ws.def, ids.sDef);
    provider.run(ids.design, owner, now, now, ws.design, ids.sDesign);

    migrate(db, { migrationsFolder });

    const rows = sqlite
      .prepare('SELECT id, workspace, shared, api_key_secret_id FROM providers ORDER BY workspace')
      .all() as { id: string; workspace: string; shared: number; api_key_secret_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === ids.def)).toMatchObject({
      workspace: ws.def,
      shared: 0,
      api_key_secret_id: ids.sDef,
    });
    expect(rows.find((row) => row.id === ids.design)).toMatchObject({
      workspace: ws.design,
      shared: 0,
      api_key_secret_id: ids.sDesign,
    });
    // The same preset may now be shared as well as a profile's own, in the same profile.
    sqlite
      .prepare(
        `INSERT INTO providers (id, owner_id, created_at, updated_at, workspace, slug, label, kind, family, shared)
         VALUES (?, ?, ?, ?, ?, 'openai', 'OpenAI', 'llm', 'openai', 1)`,
      )
      .run(newUlid(now), owner, now, now, ws.def);
    // But not twice in one scope.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO providers (id, owner_id, created_at, updated_at, workspace, slug, label, kind, family, shared)
           VALUES (?, ?, ?, ?, ?, 'openai', 'OpenAI', 'llm', 'openai', 0)`,
        )
        .run(newUlid(now), owner, now, now, ws.def),
    ).toThrow(/UNIQUE/);
    sqlite.close();
  });
});
