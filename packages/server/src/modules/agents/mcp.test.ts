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
} from './mcp.js';

const homes: string[] = [];
function home(config?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-mcp-'));
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
