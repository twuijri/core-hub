/**
 * Claude Code's Skills page (DECISIONS §139). It answered `409 state_invalid`,
 * `skills_are_hermes_only` — the same class as its MCP page before §138 — although the catalog
 * offers Claude Code the page. Its skills are `SKILL.md` folders in its own folder
 * (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`), the format Hermes's page already edits, so
 * the skill operations now act there: listed without Core Hub's library (Hermes's), switched off by
 * renaming `SKILL.md` (Claude Code only loads that name) — never a Hermes `config.yaml`.
 *
 * The agents' home is a temporary folder: nothing here touches the developer's own `~/.claude`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
let home: string | null = null;
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await hub?.close();
  hub = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

/** The managed bridge as npm leaves it (the successor package, §139). */
function installBridge(dataDir: string): void {
  const prefix = path.join(dataDir, 'agents', 'claude-code');
  const pkg = path.join(prefix, 'lib', 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@agentclientprotocol/claude-agent-acp', version: '0.84.0' }),
  );
  writeFileSync(path.join(pkg, 'dist', 'index.js'), '#!/bin/sh\ncat >/dev/null\n');
  chmodSync(path.join(pkg, 'dist', 'index.js'), 0o755);
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  symlinkSync(
    '../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    path.join(prefix, 'bin', 'claude-agent-acp'),
  );
}

async function boot(configDir?: (home: string) => string) {
  home = mkdtempSync(path.join(tmpdir(), 'corehub-claude-skills-'));
  if (configDir) vi.stubEnv('CLAUDE_CONFIG_DIR', configDir(home));
  const dataDir = path.join(home, 'data');
  installBridge(dataDir);
  hub = await signedInHub(
    { DATA_DIR: dataDir },
    { agents: { agentHome: home, adapterOptions: { hermes: { fetchImpl: healthy } } } },
  );
  const h = hub;
  let items: Array<{ id: string; slug: string; status: string }> = [];
  for (let i = 0; i < 100; i++) {
    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
    items = (list.json() as { items: typeof items }).items;
    if (items.find((item) => item.slug === 'claude-code')?.status === 'available') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const idOf = (slug: string) => items.find((item) => item.slug === slug)!.id;
  return { h, dir: home, claude: idOf('claude-code'), codex: idOf('codex') };
}

const SKILL = `---
name: release-notes
description: Writes release notes from the merged pull requests
---

Read the merged pull requests and write the notes.
`;

describe.skipIf(process.platform === 'win32')('Claude Code’s skills', () => {
  it('lists, writes, switches and deletes the skills in ~/.claude/skills', async () => {
    const { h, dir, claude } = await boot();
    const skills = path.join(dir, '.claude', 'skills');
    // One the person already had.
    mkdirSync(path.join(skills, 'pdf-tools'), { recursive: true });
    writeFileSync(
      path.join(skills, 'pdf-tools', 'SKILL.md'),
      '---\nname: pdf-tools\ndescription: Reads PDFs\n---\nUse pdftotext.\n',
    );

    const list = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${claude}/skills`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      home: string;
      library?: unknown;
      categories: Array<{ skills: Array<{ key: string; enabled: boolean; source: string }> }>;
    };
    expect(body.home).toBe(skills);
    // Core Hub's library is Hermes's; it is not offered here.
    expect(body.library).toBeUndefined();
    expect(body.categories.flatMap((category) => category.skills)).toEqual([
      expect.objectContaining({ key: 'pdf-tools', enabled: true, source: 'user' }),
    ]);

    const put = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${claude}/skills/release-notes`,
      payload: { content: SKILL },
    });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(path.join(skills, 'release-notes', 'SKILL.md'), 'utf8')).toBe(SKILL);

    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${claude}/skills/release-notes`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ key: 'release-notes', enabled: false });
    // Off is the rename Claude Code honours; no Hermes list is written into its folder.
    expect(existsSync(path.join(skills, 'release-notes', 'SKILL.md'))).toBe(false);
    expect(existsSync(path.join(skills, 'release-notes', 'SKILL.md.off'))).toBe(true);
    expect(existsSync(path.join(dir, '.claude', 'config.yaml'))).toBe(false);

    const on = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${claude}/skills/release-notes`,
      payload: { enabled: true, pinned: true },
    });
    expect(on.json()).toMatchObject({ enabled: true, pinned: true });
    expect(existsSync(path.join(skills, 'release-notes', 'SKILL.md'))).toBe(true);

    const got = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${claude}/skills/release-notes`,
    });
    expect(got.json()).toMatchObject({ content: SKILL, pinned: true });

    const gone = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${claude}/skills/release-notes`,
    });
    expect(gone.statusCode).toBeLessThan(300);
    expect(existsSync(path.join(skills, 'release-notes'))).toBe(false);
    expect(existsSync(path.join(skills, 'pdf-tools', 'SKILL.md'))).toBe(true);
  });

  it('follows $CLAUDE_CONFIG_DIR, and other coding agents still have no skills page', async () => {
    const { h, dir, claude, codex } = await boot((home) => path.join(home, 'claude-config'));
    const list = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${claude}/skills`,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { home: string }).home).toBe(path.join(dir, 'claude-config', 'skills'));
    const other = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${codex}/skills`,
    });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ details: { reason: 'skills_are_hermes_only' } });
    // The library stays Hermes's.
    const library = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${claude}/skill-library`,
      payload: { enabled: false },
    });
    expect(library.statusCode).toBe(409);
  });
});
