/**
 * What a coding agent the hub starts is given of the hub's environment (DECISIONS §139): an
 * allow-list, never the hub's own secrets. The last block starts every ACP agent of the catalog as
 * a fake program — named as the real one, speaking just enough ACP for `initialize` and
 * `session/new` — that writes the environment it got to a file, and checks both sides: nothing of
 * the hub's reaches it, and everything the agent itself reads does.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { credentialVariables } from '../agent-credentials.js';
import {
  assertCatalogIsWellFormed,
  CATALOG,
  entriesFor,
  type CatalogEntry,
} from '../catalog/index.js';
import { CONFIG_FILES } from '../config-files.js';
import { agentEnvironment, createAcpAdapter } from './acp.js';
import { hostEnvNames, pickHostEnv } from './child-env.js';

/** What an operator might have put in the hub's environment that no agent may see. */
const HUB_SECRETS = {
  DATABASE_URL: 'postgres://hub:secret@db/hub',
  HUB_ADMIN_PASSWORD: 'first-owner-password',
  COREHUB_APNS_KEY: '-----BEGIN PRIVATE KEY-----',
  COREHUB_FCM_SERVICE_ACCOUNT: '{"private_key":"x"}',
  COREHUB_PUSH_RELAY_URL: 'https://relay.example',
  MAJLIS_VERSION: '0.9.0',
  TELEGRAM_BOT_TOKEN: '123:telegram-token',
  DATA_DIR: '/data',
  PORT: '8080',
  // Not the hub's by name, and not any agent's either.
  S3_BACKUP_SECRET: 'backup-secret',
  GITHUB_TOKEN: 'ghp_operator',
  NODE_OPTIONS: '--require /hub/instrument.js',
  ELECTRON_RUN_AS_NODE: '1',
};

describe('pickHostEnv', () => {
  it('keeps the base and what the entry names, and never the hub’s own', () => {
    const picked = pickHostEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/agent',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HTTPS_PROXY: 'http://proxy:3128',
        NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
        XDG_CONFIG_HOME: '/home/agent/.config',
        CLAUDE_CONFIG_DIR: '/home/agent/.claude',
        GOOSE_PROVIDER: 'openai',
        ...HUB_SECRETS,
      },
      ['CLAUDE_CONFIG_DIR', 'GOOSE_*', 'COREHUB_*', 'DATABASE_URL'],
      'linux',
    );
    expect(picked).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      XDG_CONFIG_HOME: '/home/agent/.config',
      CLAUDE_CONFIG_DIR: '/home/agent/.claude',
      GOOSE_PROVIDER: 'openai',
    });
  });

  it('matches names case-insensitively on Windows only', () => {
    const host = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', hub_admin_password: 'x' };
    expect(pickHostEnv(host, [], 'win32')).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
    });
    expect(pickHostEnv(host, [], 'linux')).toEqual({});
  });

  it('names an entry’s keys and its own variables', () => {
    expect(
      hostEnvNames({ credentials: { openai: 'OPENAI_API_KEY' }, hostEnv: ['CODEX_*'] }),
    ).toEqual(['CODEX_*', 'OPENAI_API_KEY']);
    expect(hostEnvNames(undefined)).toEqual([]);
  });
});

describe('the catalog', () => {
  it('refuses an entry that asks for the hub’s own variables', () => {
    const [first] = entriesFor('acp');
    const bad: CatalogEntry = { ...first!, hostEnv: ['COREHUB_*'] };
    expect(() => assertCatalogIsWellFormed([bad])).toThrow(/hub's own variable/);
    const wide: CatalogEntry = { ...first!, hostEnv: ['HUB*'] };
    expect(() => assertCatalogIsWellFormed([wide])).toThrow(/hub's own variable/);
    expect(() => assertCatalogIsWellFormed(CATALOG)).not.toThrow();
  });

  it('agentEnvironment puts the hub’s own keys over the host’s and the agent’s folder first', () => {
    const env = agentEnvironment(
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'from-host', DATABASE_URL: 'x' },
      {
        executablePath: '/data/agents/claude-code/bin/claude-agent-acp',
        env: { ANTHROPIC_API_KEY: 'from-hub' },
      },
      ['ANTHROPIC_API_KEY'],
    );
    expect(env).toEqual({
      PATH: `/data/agents/claude-code/bin${path.delimiter}/usr/bin`,
      ANTHROPIC_API_KEY: 'from-hub',
    });
  });
});

/**
 * A program that answers `initialize` and `session/new` and writes its environment beside
 * itself (`env.json`); it knows nothing else.
 */
function fakeAgent(dir: string, binary: string): string {
  const file = path.join(dir, binary);
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'env.json'), JSON.stringify(process.env));
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const result =
      message.method === 'initialize'
        ? { protocolVersion: 1, agentCapabilities: {} }
        : message.method === 'session/new'
          ? { sessionId: 'fake-session' }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** A name a `PREFIX_*` pattern (or an exact one) stands for. */
const sample = (pattern: string) =>
  pattern.endsWith('*') ? `${pattern.slice(0, -1)}PROBE` : pattern;

describe.skipIf(process.platform === 'win32')('every ACP agent of the catalog, spawned', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'corehub-child-env-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const entries = entriesFor('acp');
  // Everything any agent reads, set on the host: each agent must get its own and not the others'.
  const wanted = new Map<string, string[]>();
  for (const entry of entries) {
    wanted.set(entry.id, [
      ...hostEnvNames(entry).map(sample),
      ...credentialVariables(entry.id),
      ...(CONFIG_FILES[entry.id]?.folder.variable
        ? [CONFIG_FILES[entry.id]!.folder.variable!]
        : []),
    ]);
  }
  const host: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    LANG: 'C.UTF-8',
    TZ: 'Asia/Riyadh',
    HTTPS_PROXY: 'http://proxy.internal:3128',
    ...HUB_SECRETS,
  };
  for (const names of wanted.values()) for (const name of names) host[name] ??= `host:${name}`;

  it.each(entries.map((entry) => [entry.id, entry] as const))('%s', async (_id, entry) => {
    const dir = mkdtempSync(path.join(root, `${entry.id}-`));
    const executablePath = fakeAgent(dir, entry.binary);
    const handed = Object.values(entry.credentials)[0];
    const adapter = createAcpAdapter({
      host: { pathValue: dir, inherited: host },
      catalog: entries,
    });
    const session = await adapter.start({
      slug: entry.id,
      name: entry.name,
      command: [entry.binary, ...entry.protocolArgs],
      executablePath,
      endpoint: null,
      cwd: dir,
      // What the hub hands it: the profile's shared key under the agent's own name.
      env: handed ? { [handed]: 'from-the-hub' } : {},
    });
    await session.close();
    const got = JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8')) as Record<
      string,
      string
    >;

    for (const name of Object.keys(HUB_SECRETS)) expect(got[name], name).toBeUndefined();
    expect(got).toMatchObject({ HOME: root, LANG: 'C.UTF-8', TZ: 'Asia/Riyadh' });
    expect(got.HTTPS_PROXY).toBe('http://proxy.internal:3128');
    expect(got.PATH?.split(path.delimiter)[0]).toBe(dir);
    if (handed) expect(got[handed]).toBe('from-the-hub');
    for (const name of wanted.get(entry.id)!) {
      if (name === handed) continue;
      expect(got[name], `${entry.id} reads ${name}`).toBe(`host:${name}`);
    }
    // Another agent's own folder is not this one's business.
    for (const [other, names] of wanted) {
      if (other === entry.id) continue;
      for (const name of names) {
        if (pickHostEnv({ [name]: 'x' }, hostEnvNames(entry))[name] !== undefined) continue;
        expect(got[name], `${entry.id} must not see ${other}'s ${name}`).toBeUndefined();
      }
    }
  });
});
