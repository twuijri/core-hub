// drizzle/0011_providers_shared.sql: providers, their keys and their models move from every
// profile into the default profile, which every profile reads them from (contract decision
// §34). Nothing is deleted; a duplicate keeps the default profile's row, else the oldest
// profile's, and says so in the audit trail.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../src/app/db.js';
import { ULID_PATTERN, newUlid } from '../../src/db/ids.js';

const TAG = '0011_providers_shared';

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

interface ProviderRow {
  id: string;
  workspace: string;
  slug: string;
  archived_at: number | null;
  enabled: number;
  api_key_secret_id: string | null;
}

describe(`migration ${TAG}`, () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('merges every profile’s providers into the default profile without losing a row or a key', () => {
    const before = folderBefore(TAG);
    cleanup.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: before });

    const t0 = Date.now() - 100_000;
    const owner = newUlid(t0);
    sqlite
      .prepare(
        `INSERT INTO users (id, owner_id, created_at, updated_at, username, role, status, password_hash, locale)
         VALUES (?, ?, ?, ?, 'admin', 'owner', 'active', 'x', 'ar')`,
      )
      .run(owner, owner, t0, t0);
    const ws = {
      def: newUlid(t0),
      old: newUlid(t0 + 1),
      work: newUlid(t0 + 2),
      gone: newUlid(t0 + 3),
    };
    const workspace = sqlite.prepare(
      `INSERT INTO workspaces (id, owner_id, created_at, updated_at, slug, name, is_default, settings, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    );
    workspace.run(ws.def, owner, t0, t0, 'default', 'Default', 1, null);
    workspace.run(ws.old, owner, t0 + 10, t0, 'old', 'Old', 0, null);
    workspace.run(ws.work, owner, t0 + 20, t0, 'work', 'Work', 0, null);
    workspace.run(ws.gone, owner, t0 + 30, t0, 'gone', 'Gone', 0, t0 + 40);

    const secret = (id: string, w: string, name: string, wiped = false) =>
      sqlite
        .prepare(
          `INSERT INTO secrets (id, owner_id, created_at, updated_at, workspace, name, kind, ciphertext, nonce, key_id, wiped_at)
           VALUES (?, ?, ?, ?, ?, ?, 'api_key', ?, ?, 'k1', ?)`,
        )
        .run(id, owner, t0, t0, w, name, wiped ? null : 'c', wiped ? null : 'n', wiped ? t0 : null);
    const provider = (
      id: string,
      w: string,
      slug: string,
      family: string,
      secretId: string | null,
      archived = false,
    ) =>
      sqlite
        .prepare(
          `INSERT INTO providers (id, owner_id, created_at, updated_at, workspace, slug, label, kind, family, api_key_secret_id, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'llm', ?, ?, ?)`,
        )
        .run(id, owner, t0, t0, w, slug, slug, family, secretId, archived ? t0 : null);
    const model = (id: string, w: string, providerId: string, key: string) =>
      sqlite
        .prepare(
          `INSERT INTO models (id, owner_id, created_at, updated_at, workspace, provider_id, model_key, label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, owner, t0, t0, w, providerId, key, key);

    const id = () => newUlid(t0);
    const s = {
      defAnthropic: id(),
      workAnthropic: id(),
      workGroq: id(),
      oldCustom: id(),
      workCustom: id(),
      defRouterWiped: id(),
      workRouter: id(),
      goneMistral: id(),
      workOpenai: id(),
    };
    secret(s.defAnthropic, ws.def, 'provider:anthropic');
    secret(s.workAnthropic, ws.work, 'provider:anthropic');
    secret(s.workGroq, ws.work, 'provider:groq');
    secret(s.oldCustom, ws.old, 'provider:custom:custom-lm');
    secret(s.workCustom, ws.work, 'provider:custom:custom-lm');
    secret(s.defRouterWiped, ws.def, 'provider:openrouter', true);
    secret(s.workRouter, ws.work, 'provider:openrouter');
    secret(s.goneMistral, ws.gone, 'provider:mistral');
    secret(s.workOpenai, ws.work, 'provider:openai');

    const p = {
      defAnthropic: id(),
      workAnthropic: id(),
      workGroq: id(),
      oldCustom: id(),
      workCustom: id(),
      defRouterRemoved: id(),
      workRouter: id(),
      goneMistral: id(),
      defOpenai: id(),
      workOpenai: id(),
    };
    provider(p.defAnthropic, ws.def, 'anthropic', 'anthropic', s.defAnthropic);
    provider(p.workAnthropic, ws.work, 'anthropic', 'anthropic', s.workAnthropic);
    provider(p.workGroq, ws.work, 'groq', 'groq', s.workGroq);
    provider(p.oldCustom, ws.old, 'custom-lm', 'custom:custom-lm', s.oldCustom);
    provider(p.workCustom, ws.work, 'custom-lm', 'custom:custom-lm', s.workCustom);
    provider(p.defRouterRemoved, ws.def, 'openrouter', 'openrouter', null, true);
    provider(p.workRouter, ws.work, 'openrouter', 'openrouter', s.workRouter);
    provider(p.goneMistral, ws.gone, 'mistral', 'mistral', s.goneMistral);
    // The default profile added OpenAI without a key; the work profile typed one.
    provider(p.defOpenai, ws.def, 'openai', 'openai', null);
    provider(p.workOpenai, ws.work, 'openai', 'openai', s.workOpenai);

    const m = {
      defSonnet: id(),
      workSonnet: id(),
      workOnly: id(),
      groqLlama: id(),
    };
    model(m.defSonnet, ws.def, p.defAnthropic, 'claude-sonnet-4-5');
    model(m.workSonnet, ws.work, p.workAnthropic, 'claude-sonnet-4-5');
    model(m.workOnly, ws.work, p.workAnthropic, 'claude-typed-in-work');
    model(m.groqLlama, ws.work, p.workGroq, 'llama');
    // The work profile's own choice of chat model, on its (duplicate) Anthropic row.
    const workDefault = id();
    sqlite
      .prepare(
        `INSERT INTO model_defaults (id, owner_id, created_at, updated_at, workspace, role, model_id)
         VALUES (?, ?, ?, ?, ?, 'chat', ?)`,
      )
      .run(workDefault, owner, t0, t0, ws.work, m.workSonnet);

    migrate(db, { migrationsFolder });

    const providers = sqlite.prepare('SELECT * FROM providers').all() as ProviderRow[];
    const byId = new Map(providers.map((row) => [row.id, row]));
    const live = providers.filter((row) => row.archived_at === null);
    const liveInDefault = live.filter((row) => row.workspace === ws.def).map((row) => row.slug);

    // One live row per provider, all in the default profile — except the archived profile's.
    expect(liveInDefault.sort()).toEqual([
      'anthropic',
      'custom-lm',
      'groq',
      'openai',
      'openrouter',
    ]);
    expect(byId.get(p.goneMistral)).toMatchObject({ workspace: ws.gone, archived_at: null });

    // Duplicates: the default profile's row, else the oldest profile's, is kept.
    expect(byId.get(p.defAnthropic)!.archived_at).toBeNull();
    expect(byId.get(p.workAnthropic)!.archived_at).not.toBeNull();
    expect(byId.get(p.workAnthropic)!.workspace).toBe(ws.work);
    expect(byId.get(p.oldCustom)).toMatchObject({ workspace: ws.def, archived_at: null });
    expect(byId.get(p.workCustom)!.archived_at).not.toBeNull();
    // A removed row in the default profile stepped aside for the live one moving in.
    expect(byId.get(p.workRouter)).toMatchObject({ workspace: ws.def, archived_at: null });
    expect(byId.get(p.defRouterRemoved)!.slug).toBe(`openrouter~${p.defRouterRemoved}`);

    // Keys: the default profile's when it has one; otherwise the one another profile typed.
    expect(byId.get(p.defAnthropic)!.api_key_secret_id).toBe(s.defAnthropic);
    expect(byId.get(p.workGroq)!.api_key_secret_id).toBe(s.workGroq);
    expect(byId.get(p.defOpenai)!.api_key_secret_id).toBe(s.workOpenai);
    expect(byId.get(p.oldCustom)!.api_key_secret_id).toBe(s.oldCustom);
    expect(byId.get(p.workRouter)!.api_key_secret_id).toBe(s.workRouter);
    const secrets = sqlite.prepare('SELECT id, workspace, name FROM secrets').all() as {
      id: string;
      workspace: string;
      name: string;
    }[];
    const secretOf = new Map(secrets.map((row) => [row.id, row]));
    for (const chosen of [s.defAnthropic, s.workGroq, s.workOpenai, s.oldCustom, s.workRouter]) {
      expect(secretOf.get(chosen)!.workspace).toBe(ws.def);
    }
    // The keys not chosen are still there, where they were.
    expect(secretOf.get(s.workAnthropic)!.workspace).toBe(ws.work);
    expect(secretOf.get(s.workCustom)!.workspace).toBe(ws.work);
    expect(secretOf.get(s.defRouterWiped)!.name).toBe(`provider:openrouter~${s.defRouterWiped}`);
    expect(secrets).toHaveLength(9);

    // Models: the kept rows' models moved; a model only the duplicate had moved onto the kept row.
    const models = sqlite
      .prepare('SELECT id, workspace, provider_id, model_key FROM models')
      .all() as { id: string; workspace: string; provider_id: string; model_key: string }[];
    const modelOf = new Map(models.map((row) => [row.id, row]));
    expect(modelOf.get(m.groqLlama)).toMatchObject({ workspace: ws.def, provider_id: p.workGroq });
    expect(modelOf.get(m.workOnly)).toMatchObject({
      workspace: ws.def,
      provider_id: p.defAnthropic,
    });
    expect(modelOf.get(m.workSonnet)).toMatchObject({
      workspace: ws.work,
      provider_id: p.workAnthropic,
    });
    expect(models).toHaveLength(4);

    // The work profile keeps its own choice of model, now naming the kept row's model.
    const defaults = sqlite.prepare('SELECT workspace, model_id FROM model_defaults').all();
    expect(defaults).toEqual([{ workspace: ws.work, model_id: m.defSonnet }]);

    // Every choice is in the audit trail, with both profiles named.
    const audit = sqlite
      .prepare(
        `SELECT id, entity_id, data, actor_kind FROM audit_events WHERE action = 'provider.merged'`,
      )
      .all() as { id: string; entity_id: string; data: string; actor_kind: string }[];
    expect(audit.map((row) => row.entity_id).sort()).toEqual(
      [p.workAnthropic, p.workCustom, p.workOpenai].sort(),
    );
    const custom = audit.find((row) => row.entity_id === p.workCustom)!;
    expect(JSON.parse(custom.data)).toMatchObject({
      slug: 'custom-lm',
      archived_profile: 'work',
      kept_profile: 'old',
      kept_provider_id: p.oldCustom,
    });
    for (const row of audit) {
      expect(row.id).toMatch(ULID_PATTERN);
      expect(row.actor_kind).toBe('system');
    }
    sqlite.close();
  });

  it('does nothing on a hub with no providers', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    const count = sqlite.prepare('SELECT count(*) AS n FROM providers').get() as { n: number };
    expect(count.n).toBe(0);
    sqlite.close();
  });
});
