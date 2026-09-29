/**
 * The MCP page of every agent on a hub booted the way the owner's was on 2026-09-29 (after
 * PR #226: the installed agents are checked once the hub is ready, and Claude Code's ACP
 * bridge ignores `--version`). That page answered "That is not allowed in the current state."
 * (`409 state_invalid`, `skills_are_hermes_only`) for Claude Code — in its server list and in
 * its "Core Hub tools" card — although the agent was Available: the MCP operations and the
 * card's read only knew Hermes, while the catalog offers the page to the coding agents.
 *
 * Claude Code is installed here as npm lays out the managed bridge
 * (`<DATA_DIR>/agents/claude-code/bin/claude-code-acp` linking into
 * `lib/node_modules/@zed-industries/claude-code-acp`), whose "version" check prints nothing and
 * reads its stdin to the end like the real one. The agents' home is a temporary folder, so
 * nothing here reads or writes the developer's own `~/.claude.json`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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
  // The developer's own variables must not move the files under test.
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('GEMINI_CLI_HOME', '');
  vi.stubEnv('QWEN_HOME', '');
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    vi.stubEnv(name, '');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await hub?.close();
  hub = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

/** A gateway that answers its health probe, so Hermes's runtime has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

/** The managed bridge as `npm install --global --prefix <DATA_DIR>/agents/claude-code` leaves it. */
function installBridge(dataDir: string): void {
  const prefix = path.join(dataDir, 'agents', 'claude-code');
  const pkg = path.join(prefix, 'lib', 'node_modules', '@zed-industries', 'claude-code-acp');
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: '@zed-industries/claude-code-acp',
      version: '0.16.2',
      bin: { 'claude-code-acp': './dist/index.js' },
    }),
  );
  // `--version` is not a flag it knows: it serves ACP on stdin and prints no version.
  writeFileSync(path.join(pkg, 'dist', 'index.js'), '#!/bin/sh\ncat >/dev/null\n');
  chmodSync(path.join(pkg, 'dist', 'index.js'), 0o755);
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  symlinkSync(
    '../lib/node_modules/@zed-industries/claude-code-acp/dist/index.js',
    path.join(prefix, 'bin', 'claude-code-acp'),
  );
}

async function boot(): Promise<{
  h: Hub;
  dir: string;
  dataDir: string;
  agentOf: (slug: string) => string;
}> {
  home = mkdtempSync(path.join(tmpdir(), 'corehub-agent-home-'));
  // The bridge is on the volume before the hub starts, as on the owner's.
  const dataDir = path.join(home, 'data');
  installBridge(dataDir);
  hub = await signedInHub(
    { DATA_DIR: dataDir },
    { agents: { agentHome: home, adapterOptions: { hermes: { fetchImpl: healthy } } } },
  );
  const h = hub;
  // The check runs once the hub is ready (#226); wait until Claude Code reads as Available.
  let items: Array<{ id: string; slug: string; status: string }> = [];
  for (let i = 0; i < 100; i++) {
    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
    items = (list.json() as { items: typeof items }).items;
    if (items.find((item) => item.slug === 'claude-code')?.status === 'available') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(items.find((item) => item.slug === 'claude-code')?.status).toBe('available');
  return {
    h,
    dir: home,
    dataDir,
    agentOf: (slug) => items.find((item) => item.slug === slug)!.id,
  };
}

const servers = (agent: string, name?: string) =>
  `/api/v1/agents/${agent}/mcp-servers${name ? `/${name}` : ''}`;

/** A global config as Claude Code keeps one: its own state around the servers. */
const CLAUDE_JSON = {
  numStartups: 42,
  projects: { '/data/work': { allowedTools: [], hasTrustDialogAccepted: true } },
  mcpServers: {
    github: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret' },
    },
  },
};

describe('the MCP page of every agent, on a hub booted like the owner’s', () => {
  it('answers for Hermes and for Claude Code — both the server list and the Core Hub tools', async () => {
    const { h, agentOf } = await boot();
    for (const slug of ['hermes', 'claude-code']) {
      const list = await authed(h, h.token, { method: 'GET', url: servers(agentOf(slug)) });
      expect(list.statusCode, `${slug}: ${list.body}`).toBe(200);
      const card = await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/agents/${agentOf(slug)}/hub-tools`,
      });
      expect(card.statusCode, `${slug}: ${card.body}`).toBe(200);
      expect(card.json()).toMatchObject({ server_name: 'corehub', available: true });
    }
    // The card's settings are the profile's, and are changed from Claude Code's page too.
    const on = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agentOf('claude-code')}/hub-tools`,
      payload: { enabled: false },
    });
    expect(on.statusCode, on.body).toBe(200);
  }, 30_000);

  it('says on the card when an installed agent has no key or sign-in to answer with', async () => {
    const { h, dir, agentOf } = await boot();
    const card = async () =>
      (
        await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agentOf('claude-code')}` })
      ).json() as { status: string; credentials?: string };
    expect(await card()).toMatchObject({ status: 'available', credentials: 'missing' });
    // `claude login` done on the hub's home.
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', '.credentials.json'), '{}');
    expect(await card()).toMatchObject({ credentials: 'ready' });
    // Hermes, and an agent not installed, say nothing either way.
    const hermes = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agentOf('hermes')}`,
    });
    expect(hermes.json()).not.toHaveProperty('credentials');
    const codex = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agentOf('codex')}`,
    });
    expect(codex.json()).not.toHaveProperty('credentials');
  }, 30_000);

  it("lists, adds, switches and deletes Claude Code's own servers in ~/.claude.json", async () => {
    const { h, dir, dataDir, agentOf } = await boot();
    const claude = agentOf('claude-code');
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify(CLAUDE_JSON, null, 2), { mode: 0o600 });

    const list = await authed(h, h.token, { method: 'GET', url: servers(claude) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({
        name: 'github',
        transport: 'stdio',
        enabled: true,
        config: expect.objectContaining({ env: { GITHUB_TOKEN: '[stored]' } }),
      }),
    ]);
    // Nothing of Hermes's own on a coding agent's row: no test, sign-in or tool filter.
    expect(list.json().items[0]).not.toHaveProperty('last_test');
    expect(list.json().items[0]).not.toHaveProperty('tool_filter');

    // A socket, added as the page adds one: Claude Code needs its `type`, which is written.
    const added = await authed(h, h.token, {
      method: 'POST',
      url: servers(claude),
      payload: {
        name: 'docs',
        transport: 'http',
        enabled: true,
        config: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer k' } },
      },
    });
    expect(added.statusCode, added.body).toBeLessThan(300);
    let doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.mcpServers.docs).toEqual({
      type: 'http',
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer k' },
    });
    // Claude Code's own state is written back as it was, and the mode is kept.
    expect(doc.numStartups).toBe(42);
    expect(doc.projects).toEqual(CLAUDE_JSON.projects);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Saving the row as the page shows it keeps the key it cannot see.
    const edited = await authed(h, h.token, {
      method: 'PATCH',
      url: servers(claude, 'github'),
      payload: {
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github', '--read-only'],
          env: { GITHUB_TOKEN: '[stored]' },
        },
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(doc.mcpServers.github.args).toContain('--read-only');

    // Off: out of Claude Code's file, kept by the hub, still on the page.
    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: servers(claude, 'github'),
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ name: 'github', enabled: false });
    doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.mcpServers).not.toHaveProperty('github');
    const parked = path.join(dataDir, 'agent-mcp', 'claude-code.json');
    expect(statSync(parked).mode & 0o777).toBe(0o600);
    const afterOff = await authed(h, h.token, { method: 'GET', url: servers(claude) });
    expect(afterOff.json().items.map((s: { name: string; enabled: boolean }) => s)).toEqual([
      expect.objectContaining({ name: 'docs', enabled: true }),
      expect.objectContaining({ name: 'github', enabled: false }),
    ]);

    // On again: back in the file with its key.
    const back = await authed(h, h.token, {
      method: 'PATCH',
      url: servers(claude, 'github'),
      payload: { enabled: true },
    });
    expect(back.statusCode, back.body).toBe(200);
    doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(existsSync(parked)).toBe(false);

    // The hub's own server is not a row to edit here either.
    const managed = await authed(h, h.token, {
      method: 'POST',
      url: servers(claude),
      payload: { name: 'corehub', transport: 'stdio', config: { command: 'x' } },
    });
    expect(managed.statusCode).toBe(409);

    const gone = await authed(h, h.token, { method: 'DELETE', url: servers(claude, 'docs') });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(doc.mcpServers)).toEqual(['github']);
    expect(doc.numStartups).toBe(42);
  }, 30_000);

  it("takes Claude Code's lock on its config, and clears one left stale", async () => {
    const { h, dir, agentOf } = await boot();
    const claude = agentOf('claude-code');
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify(CLAUDE_JSON));
    // A lock a Claude Code that died left behind, older than its ten seconds.
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const added = await authed(h, h.token, {
      method: 'POST',
      url: servers(claude),
      payload: { name: 'fs', transport: 'stdio', config: { command: 'mcp-fs' } },
    });
    expect(added.statusCode, added.body).toBeLessThan(300);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.fs).toEqual({ command: 'mcp-fs' });
    // Released after the write.
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 30_000);

  it("reads Gemini CLI's servers, and never rewrites its settings when they carry comments", async () => {
    const { h, dir, agentOf } = await boot();
    const gemini = agentOf('gemini-cli');
    mkdirSync(path.join(dir, '.gemini'));
    const file = path.join(dir, '.gemini', 'settings.json');
    const text = `{
  // mine
  "mcpServers": { "search": { "httpUrl": "https://search.example/mcp" }, "old": { "url": "https://old.example/sse" } }
}
`;
    writeFileSync(file, text);
    const list = await authed(h, h.token, { method: 'GET', url: servers(gemini) });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list.json().items.map((s: { name: string; transport: string }) => [s.name, s.transport]),
    ).toEqual([
      ['old', 'sse'],
      ['search', 'http'],
    ]);
    const write = await authed(h, h.token, {
      method: 'PATCH',
      url: servers(gemini, 'search'),
      payload: { enabled: false },
    });
    expect(write.statusCode).toBe(400);
    expect(write.json()).toMatchObject({ details: { reason: 'config_has_comments' } });
    expect(readFileSync(file, 'utf8')).toBe(text);
  }, 30_000);

  it('says which coding agents it does not edit yet, and still offers them the Core Hub tools', async () => {
    const { h, agentOf } = await boot();
    for (const slug of ['codex', 'goose', 'opencode']) {
      const list = await authed(h, h.token, { method: 'GET', url: servers(agentOf(slug)) });
      expect(list.statusCode, slug).toBe(409);
      expect(list.json()).toMatchObject({
        code: 'state_invalid',
        details: { reason: 'mcp_not_managed' },
      });
      const card = await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/agents/${agentOf(slug)}/hub-tools`,
      });
      expect(card.statusCode, slug).toBe(200);
    }
  }, 30_000);
});
