/**
 * MCP servers live in one block of a file the hub does not own. Most of these tests are
 * about what is still there afterwards.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpError,
  STORED,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  putMcpServer,
  prepareOAuthLogin,
  setMcpToolFilter,
} from './mcp.js';

const homes: string[] = [];
function home(config?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-mcp-'));
  homes.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, 'config.yaml'), config, 'utf8');
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (dir: string) => readFileSync(path.join(dir, 'config.yaml'), 'utf8');

/** A config as Hermes writes one, with a comment and a second block that is not ours. */
const CONFIG = `# my hub's hermes
mcp_servers:
  studio-api:
    command: node
    args:
      - /opt/mcp/api.js
    env:
      HERMES_WEB_UI_URL: http://127.0.0.1:8080
      OPENAI_API_KEY: sk-secret-value
    enabled: true
  remote-docs:
    url: https://docs.example/mcp
    type: sse
    enabled: false

platforms:
  webhook:
    enabled: true
    extra: '{}'
`;

describe('reading the block', () => {
  it('reads the servers, their transport and whether they are on', () => {
    const servers = listMcpServers(home(CONFIG));
    expect(servers.map((s) => s.name)).toEqual(['remote-docs', 'studio-api']);
    expect(servers.find((s) => s.name === 'studio-api')?.transport).toBe('stdio');
    expect(servers.find((s) => s.name === 'remote-docs')?.transport).toBe('sse');
    expect(servers.find((s) => s.name === 'remote-docs')?.enabled).toBe(false);
  });

  it('treats a missing `enabled` as on, because that is what the file means', () => {
    const dir = home('mcp_servers:\n  plain:\n    command: node\n');
    expect(listMcpServers(dir)[0]?.enabled).toBe(true);
  });

  it('never hands back a credential', () => {
    const server = getMcpServer(home(CONFIG), 'studio-api');
    const env = server?.config.env as Record<string, unknown>;
    expect(env.OPENAI_API_KEY).toBe(STORED);
    // What is not a credential is still readable: a person editing a command needs to
    // see the URL they set.
    expect(env.HERMES_WEB_UI_URL).toBe('http://127.0.0.1:8080');
    expect(server?.config.command).toBe('node');
  });

  it('says nothing when there is no config file at all', () => {
    expect(listMcpServers(home())).toEqual([]);
  });

  it('refuses to touch a config it cannot parse', () => {
    // Saving would replace the person's file with our idea of it, and their agent would
    // stop where it stood.
    const dir = home('mcp_servers:\n  broken: [unclosed\n');
    expect(() => listMcpServers(dir)).toThrow(McpError);
  });
});

describe('writing one back', () => {
  it('leaves the comment, the other block and the untouched server alone', () => {
    const dir = home(CONFIG);
    putMcpServer(dir, 'remote-docs', { enabled: true });
    const text = read(dir);
    expect(text).toContain("# my hub's hermes");
    expect(text).toContain('platforms:');
    expect(text).toContain('webhook:');
    expect(text).toContain('OPENAI_API_KEY: sk-secret-value');
    expect(text).toContain('- /opt/mcp/api.js');
  });

  it('does not write the mask into the file', () => {
    // Saving a server after looking at it must not replace its key with `[stored]` and
    // break it the next time Hermes starts.
    const dir = home(CONFIG);
    const server = getMcpServer(dir, 'studio-api');
    putMcpServer(dir, 'studio-api', { config: server?.config });
    expect(read(dir)).toContain('OPENAI_API_KEY: sk-secret-value');
    expect(read(dir)).not.toContain(STORED);
  });

  it('keeps a key the person did not retype and takes one they did', () => {
    const dir = home(CONFIG);
    const server = getMcpServer(dir, 'studio-api');
    const env = { ...(server?.config.env as Record<string, unknown>), OPENAI_API_KEY: 'sk-new' };
    putMcpServer(dir, 'studio-api', { config: { ...server?.config, env } });
    expect(read(dir)).toContain('OPENAI_API_KEY: sk-new');
  });

  it('adds a server that was not there', () => {
    const dir = home(CONFIG);
    putMcpServer(dir, 'filesystem', {
      config: { command: 'npx', args: ['-y', 'mcp-server-filesystem'] },
      enabled: true,
    });
    expect(listMcpServers(dir).map((s) => s.name)).toContain('filesystem');
    expect(read(dir)).toContain('mcp-server-filesystem');
  });

  it('creates the file when the agent has none yet', () => {
    const dir = home();
    putMcpServer(dir, 'first', { config: { command: 'node' } });
    expect(listMcpServers(dir)).toHaveLength(1);
  });

  it('refuses a name that is not a name, and an empty server', () => {
    const dir = home(CONFIG);
    expect(() => putMcpServer(dir, 'has spaces', { config: { command: 'x' } })).toThrow(
      /name_invalid/,
    );
    expect(() => putMcpServer(dir, 'hollow', {})).toThrow(/config_empty/);
  });
});

describe('removing one', () => {
  it('takes that server and nothing else', () => {
    const dir = home(CONFIG);
    deleteMcpServer(dir, 'remote-docs');
    expect(listMcpServers(dir).map((s) => s.name)).toEqual(['studio-api']);
    expect(read(dir)).toContain('platforms:');
    expect(read(dir)).toContain("# my hub's hermes");
  });

  it('says so when there is nothing to remove', () => {
    expect(() => deleteMcpServer(home(CONFIG), 'ghost')).toThrow(/not_found/);
  });
});

describe('a remote server that signs in (DECISIONS §122)', () => {
  const REMOTE = `mcp_servers:
  clickup:
    url: https://mcp.clickup.example/mcp
    auth: oauth
    headers:
      Authorization: Bearer abc-secret
      X-Team: sales
    oauth:
      client_id: my-client
      client_secret: cs-secret
`;

  it('masks a header and an OAuth secret one level down, and says `auth: oauth` as it is', () => {
    const server = getMcpServer(home(REMOTE), 'clickup');
    expect(server?.oauth).toBe(true);
    expect(server?.config.auth).toBe('oauth');
    expect(server?.config.headers).toEqual({ Authorization: STORED, 'X-Team': 'sales' });
    expect(server?.config.oauth).toEqual({ client_id: 'my-client', client_secret: STORED });
    expect(JSON.stringify(server)).not.toContain('secret-');
    expect(JSON.stringify(server)).not.toMatch(/abc-secret|cs-secret/);
  });

  it('writes the masked values back as they were', () => {
    const dir = home(REMOTE);
    const server = getMcpServer(dir, 'clickup');
    putMcpServer(dir, 'clickup', { config: server?.config });
    expect(read(dir)).toContain('Authorization: Bearer abc-secret');
    expect(read(dir)).toContain('client_secret: cs-secret');
    expect(read(dir)).not.toContain(STORED);
  });

  it("prepares Hermes's login: `auth: oauth`, the hub's callback and the port; keeps a redirect the person wrote", () => {
    const dir = home(REMOTE);
    const ours = (uri: string) => uri.includes('/api/v1/mcp-oauth/callback/');
    expect(
      prepareOAuthLogin(
        dir,
        'clickup',
        'https://a.example/api/v1/mcp-oauth/callback/clickup',
        40001,
        ours,
      ),
    ).toBe('https://a.example/api/v1/mcp-oauth/callback/clickup');
    expect(read(dir)).toContain('client_secret: cs-secret');
    expect(read(dir)).toContain(
      'redirect_uri: https://a.example/api/v1/mcp-oauth/callback/clickup',
    );
    expect(read(dir)).toContain('redirect_port: 40001');
    prepareOAuthLogin(
      dir,
      'clickup',
      'https://b.example/api/v1/mcp-oauth/callback/clickup',
      40002,
      ours,
    );
    expect(read(dir)).toContain(
      'redirect_uri: https://b.example/api/v1/mcp-oauth/callback/clickup',
    );
    expect(read(dir)).toContain('redirect_port: 40002');
    expect(read(dir)).not.toContain('40001');

    const own = home(
      'mcp_servers:\n  x:\n    url: https://x.example\n    oauth:\n      redirect_uri: https://proxy.example/cb\n',
    );
    expect(
      prepareOAuthLogin(own, 'x', 'https://b.example/api/v1/mcp-oauth/callback/x', 40003, ours),
    ).toBe('https://proxy.example/cb');
    expect(read(own)).toContain('auth: oauth');
    expect(() => prepareOAuthLogin(own, 'ghost', 'https://b.example/', 1, ours)).toThrow(
      /not_found/,
    );
  });
});

describe('which tools Hermes gives the agent (DECISIONS §134)', () => {
  const FILTERED = `# kept
mcp_servers:
  github:
    url: https://mcp.example/github
    tools:
      resources: false
      exclude: [delete_repo]
  local:
    command: node
`;

  it('reads include and exclude as Hermes does; no key is no filter, and `[]` allows none', () => {
    const dir = home(FILTERED + '  none:\n    command: x\n    tools:\n      include: []\n');
    const byName = Object.fromEntries(listMcpServers(dir).map((s) => [s.name, s.toolFilter]));
    expect(byName.github).toEqual({ include: null, exclude: ['delete_repo'] });
    expect(byName.local).toEqual({ include: null, exclude: null });
    expect(byName.none).toEqual({ include: [], exclude: null });
  });

  it("writes Hermes's `tools.include`, drops `exclude`, and keeps the block's other keys", () => {
    const dir = home(FILTERED);
    const written = setMcpToolFilter(dir, 'github', {
      include: ['get_issue', 'list_repos', 'get_issue'],
      exclude: ['ignored'],
    });
    expect(written.toolFilter).toEqual({ include: ['get_issue', 'list_repos'], exclude: null });
    const text = read(dir);
    expect(text).toContain('# kept');
    expect(text).toMatch(
      / {4}tools:\n {6}resources: false\n {6}include:\n {8}- get_issue\n {8}- list_repos\n/,
    );
    expect(text).not.toContain('exclude');
    expect(text).toContain('  local:\n    command: node');
  });

  it('writes `include: []` as it is: Hermes then registers none of the tools', () => {
    const dir = home(FILTERED);
    expect(setMcpToolFilter(dir, 'local', { include: [], exclude: null }).toolFilter).toEqual({
      include: [],
      exclude: null,
    });
    expect(read(dir)).toMatch(/ {2}local:\n {4}command: node\n {4}tools:\n {6}include: \[\]\n/);
  });

  it('writes a block-list, and removes the filter (and an emptied `tools`) with both null', () => {
    const dir = home(FILTERED);
    setMcpToolFilter(dir, 'local', { include: null, exclude: ['run_*'] });
    expect(getMcpServer(dir, 'local')!.toolFilter).toEqual({ include: null, exclude: ['run_*'] });
    setMcpToolFilter(dir, 'local', { include: null, exclude: null });
    expect(read(dir)).toContain('  local:\n    command: node\n');
    expect(read(dir)).not.toMatch(/local:\n {4}command: node\n {4}tools/);
    // github keeps `tools.resources` when its filter goes.
    setMcpToolFilter(dir, 'github', { include: null, exclude: null });
    expect(read(dir)).toMatch(/ {4}tools:\n {6}resources: false\n/);
    expect(getMcpServer(dir, 'github')!.toolFilter).toEqual({ include: null, exclude: null });
  });

  it('refuses a server that is not there and a `tools` that is not a block', () => {
    const dir = home('mcp_servers:\n  odd:\n    command: x\n    tools: yes\n');
    expect(() => setMcpToolFilter(dir, 'nope', { include: [], exclude: null })).toThrow(
      new McpError('mcp_not_found'),
    );
    expect(() => setMcpToolFilter(dir, 'odd', { include: [], exclude: null })).toThrow(
      new McpError('mcp_tools_block_invalid'),
    );
  });

  it('changes the fingerprint for the connection, not for the switch, the filter or the sign-in', () => {
    const dir = home(FILTERED);
    const before = getMcpServer(dir, 'github')!.fingerprint;
    putMcpServer(dir, 'github', { enabled: false });
    setMcpToolFilter(dir, 'github', { include: ['a'], exclude: null });
    prepareOAuthLogin(dir, 'github', 'https://hub.example/cb', 4100, () => true);
    const signIn = getMcpServer(dir, 'github')!;
    // `auth: oauth` is part of how it connects; the `oauth` block (redirect, port) is not.
    const withAuth = signIn.fingerprint;
    expect(withAuth).not.toBe(before);
    prepareOAuthLogin(dir, 'github', 'https://hub.example/cb', 4200, () => true);
    expect(getMcpServer(dir, 'github')!.fingerprint).toBe(withAuth);
    putMcpServer(dir, 'github', {
      config: { ...signIn.config, url: 'https://mcp.example/github/v2' },
    });
    expect(getMcpServer(dir, 'github')!.fingerprint).not.toBe(withAuth);
  });
});
