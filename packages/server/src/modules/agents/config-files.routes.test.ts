/**
 * A coding agent's own config files through the hub's routes (contract decision §77). The
 * three operations were the contract's 501 stubs: every test here fails on that code.
 *
 * The home is a temporary folder handed to the agents module (`agentHome`), so nothing here
 * reads or writes the developer's own `~/.claude`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { sql } from 'drizzle-orm';
import { requireSqlite } from '../../lib/db.js';
import { stripJsonComments } from './config-files.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
let home: string | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

async function boot(): Promise<{ h: Hub; home: string; agentOf: (slug: string) => string }> {
  home = mkdtempSync(path.join(tmpdir(), 'corehub-agent-home-'));
  hub = await signedInHub({}, { agents: { agentHome: home } });
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const items = (list.json() as { items: Array<{ id: string; slug: string }> }).items;
  return {
    h: hub,
    home,
    agentOf: (slug) => items.find((item) => item.slug === slug)!.id,
  };
}

const url = (agent: string, key?: string) =>
  `/api/v1/agents/${agent}/config-files${key ? `/${key}` : ''}`;

describe("coding agents' config files", () => {
  it("lists Claude Code's two files, writes CLAUDE.md where the agent reads it, and reads it back", async () => {
    const { h, home: dir, agentOf } = await boot();
    const claude = agentOf('claude-code');

    const agent = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${claude}` });
    expect(agent.json().capabilities).toContain('config_files');

    const list = await authed(h, h.token, { method: 'GET', url: url(claude) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({
        key: 'instructions',
        path: '~/.claude/CLAUDE.md',
        language: 'markdown',
        exists: false,
        revision: null,
        content: null,
      }),
      expect.objectContaining({ key: 'settings', path: '~/.claude/settings.json', language: 'json' }),
    ]);

    const empty = await authed(h, h.token, { method: 'GET', url: url(claude, 'instructions') });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ exists: false, content: '', revision: null });

    const text = '# ملاحظات\n\nAlways run the tests.\n';
    const put = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'instructions'),
      payload: { content: text, revision: null },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ exists: true, content: text });
    const file = path.join(dir, '.claude', 'CLAUDE.md');
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const read = await authed(h, h.token, { method: 'GET', url: url(claude, 'instructions') });
    expect(read.json()).toMatchObject({ content: text, revision: put.json().revision });

    // Every profile reads the same file: the list is the same from another profile.
    const other = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'work' },
    });
    expect([200, 201]).toContain(other.statusCode);
    const fromWork = await h.app.inject({
      method: 'GET',
      url: url(claude, 'instructions'),
      headers: { authorization: `Bearer ${h.token}`, 'x-hub-profile': 'work' },
    });
    expect(fromWork.json().content).toBe(text);
  });

  it('refuses a stale revision, keeps a backup of what it replaces, and audits the write', async () => {
    const { h, home: dir, agentOf } = await boot();
    const claude = agentOf('claude-code');
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'first\n', { mode: 0o640 });

    const first = await authed(h, h.token, { method: 'GET', url: url(claude, 'instructions') });
    const revision = first.json().revision as string;
    expect(revision).toMatch(/^[0-9a-f]{32}$/);

    // Somebody else changed it after it was read.
    writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'edited by hand\n');
    const stale = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'instructions'),
      payload: { content: 'mine\n', revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toMatchObject({ reason: 'changed' });
    expect(readFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toBe('edited by hand\n');

    const fresh = stale.json().details.revision as string;
    const ok = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'instructions'),
      payload: { content: 'mine\n', revision: fresh },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    // The mode the file had is kept.
    expect(statSync(path.join(dir, '.claude', 'CLAUDE.md')).mode & 0o777).toBe(0o640);

    const backups = path.join(h.dataDir, 'backups', 'agent-config', 'claude-code', 'instructions');
    const kept = readdirSync(backups);
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(backups, kept[0]!), 'utf8')).toBe('edited by hand\n');

    const events = requireSqlite(h.app.hub.database).all<{ action: string; data: string }>(
      sql`SELECT action, data FROM audit_events WHERE action = 'agent_config_file.written'`,
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toMatchObject({
      agent: 'claude-code',
      key: 'instructions',
      path: '~/.claude/CLAUDE.md',
      previous_revision: fresh,
      backup: true,
    });
  });

  it('validates JSON before saving — with comments only where the agent strips them', async () => {
    const { h, home: dir, agentOf } = await boot();
    const claude = agentOf('claude-code');
    const bad = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'settings'),
      payload: { content: '{ "model": "x", }', revision: null },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toMatchObject({ reason: 'invalid_json' });
    expect(() => statSync(path.join(dir, '.claude', 'settings.json'))).toThrow();

    // Claude Code parses strict JSON: a comment is refused there …
    const commented = '{\n  // the default model\n  "model": "sonnet"\n}\n';
    const strict = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'settings'),
      payload: { content: commented, revision: null },
    });
    expect(strict.statusCode).toBe(400);
    // … and accepted by Gemini CLI, which strips comments first.
    const gemini = agentOf('gemini-cli');
    const loose = await authed(h, h.token, {
      method: 'PUT',
      url: url(gemini, 'settings'),
      payload: { content: commented, revision: null },
    });
    expect(loose.statusCode, loose.body).toBe(200);
    expect(readFileSync(path.join(dir, '.gemini', 'settings.json'), 'utf8')).toBe(commented);
  });

  it('knows only its own keys, refuses a link out of the home, a file too large, and members', async () => {
    const { h, home: dir, agentOf } = await boot();
    const claude = agentOf('claude-code');
    const unknown = await authed(h, h.token, { method: 'GET', url: url(claude, 'credentials') });
    expect(unknown.statusCode).toBe(404);

    // Hermes has no config files of this kind: an empty list, and no key answers.
    const hermes = agentOf('hermes');
    const none = await authed(h, h.token, { method: 'GET', url: url(hermes) });
    expect(none.statusCode).toBe(200);
    expect(none.json().items).toEqual([]);

    // A link planted towards the hub's own data is not followed.
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const secret = path.join(h.dataDir, 'secret.txt');
    writeFileSync(secret, 'do not show');
    symlinkSync(secret, path.join(dir, '.claude', 'CLAUDE.md'));
    const linked = await authed(h, h.token, { method: 'GET', url: url(claude, 'instructions') });
    expect(linked.statusCode).toBe(409);
    expect(linked.json().details).toMatchObject({ reason: 'symlink_outside' });
    const through = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'instructions'),
      payload: { content: 'x', revision: null },
    });
    expect(through.statusCode).toBe(409);
    expect(readFileSync(secret, 'utf8')).toBe('do not show');

    // A link that stays inside the home (a dotfiles folder) is followed, and stays a link.
    rmSync(path.join(dir, '.claude', 'CLAUDE.md'));
    mkdirSync(path.join(dir, 'dotfiles'));
    writeFileSync(path.join(dir, 'dotfiles', 'CLAUDE.md'), 'from dotfiles\n');
    symlinkSync(path.join(dir, 'dotfiles', 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'));
    const dotfiles = await authed(h, h.token, { method: 'GET', url: url(claude, 'instructions') });
    expect(dotfiles.json().content).toBe('from dotfiles\n');
    const saved = await authed(h, h.token, {
      method: 'PUT',
      url: url(claude, 'instructions'),
      payload: { content: 'edited\n', revision: dotfiles.json().revision },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(readFileSync(path.join(dir, 'dotfiles', 'CLAUDE.md'), 'utf8')).toBe('edited\n');

    const big = await authed(h, h.token, {
      method: 'PUT',
      url: url(agentOf('pi'), 'instructions'),
      payload: { content: 'x'.repeat(1024 * 1024 + 1), revision: null },
    });
    expect([400, 413]).toContain(big.statusCode);
    expect(() => statSync(path.join(dir, '.pi', 'agent', 'AGENTS.md'))).toThrow();

    const created = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: { username: 'mem', password: 'mem-password-1', role: 'member', profiles: ['default'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'mem', password: 'mem-password-1' },
    });
    const member = login.json().access_token as string;
    for (const request of [
      { method: 'GET' as const, url: url(claude) },
      { method: 'GET' as const, url: url(claude, 'instructions') },
      { method: 'PUT' as const, url: url(claude, 'instructions'), payload: { content: 'x', revision: null } },
    ]) {
      const refused = await authed(h, member, request);
      expect(refused.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
  });

  it("honours the agent's own variable that moves its folder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-agent-home-'));
    home = dir;
    const codexHome = path.join(dir, 'elsewhere', 'codex');
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      hub = await signedInHub({}, { agents: { agentHome: dir } });
      const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      const codex = (list.json() as { items: Array<{ id: string; slug: string }> }).items.find(
        (item) => item.slug === 'codex',
      )!.id;
      const files = await authed(hub, hub.token, { method: 'GET', url: url(codex) });
      expect(files.json().items.map((f: { path: string }) => f.path)).toEqual([
        '$CODEX_HOME/AGENTS.md',
        '$CODEX_HOME/config.toml',
      ]);
      const put = await authed(hub, hub.token, {
        method: 'PUT',
        url: url(codex, 'settings'),
        payload: { content: 'model = "gpt-5"\n', revision: null },
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe('stripJsonComments', () => {
  it('blanks comments outside strings only', () => {
    const text = '{"a": "http://x//y", /* note */ "b": 1 // tail\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'http://x//y', b: 1 });
    expect(JSON.parse(stripJsonComments('{"s": "a\\"//b"}'))).toEqual({ s: 'a"//b' });
  });
});
