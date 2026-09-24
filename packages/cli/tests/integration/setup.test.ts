/**
 * `corehub setup` against a real hub that has no owner and no HUB_ADMIN_PASSWORD (ADR 0011):
 * the claim token is read from the file the server wrote, the password is typed at a prompt,
 * and the command ends signed in. Nothing here is faked — the hub is the real one, built the
 * way `packages/server/tests/unit/helpers.ts` builds it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../server/src/app/config.js';
import { buildServer } from '../../../server/src/app/server.js';
import { createLogger } from '../../../server/src/lib/logger.js';
import { modules as defaultModules } from '../../../server/src/modules/index.js';
import { main } from '../../src/main.js';

const OWNER_PASSWORD = 'cli-first-run-password';

let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let dataDir: string;
let env: NodeJS.ProcessEnv;
const temps: string[] = [];
const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `corehub-cli-${name}-`));
  temps.push(dir);
  return dir;
};

async function cli(args: string[], input: string[] = []) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  for (const line of input) stdin.write(`${line}\n`);
  stdin.end();
  const code = await main(args, { stdin, stdout, stderr, env });
  return { code, stdout: out, stderr: err };
}

const tokenFile = () => path.join(dataDir, 'setup-token.txt');

beforeAll(async () => {
  dataDir = temp('setup-data');
  app = await buildServer({
    // No HUB_ADMIN_PASSWORD: this is the fresh-install case the setup command exists for.
    // Token only (ADR 0019 `0`): these cases are the claim-token path; the open window has its
    // own case below, on a hub of its own.
    config: loadConfig({ DATA_DIR: dataDir, PORT: '0', COREHUB_SETUP_OPEN_MINUTES: '0' }),
    logger: createLogger({ level: 'silent' }),
    modules: defaultModules,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  env = { XDG_CONFIG_HOME: temp('setup-config'), NO_COLOR: '1', LANG: 'en_US.UTF-8' };
});

afterAll(async () => {
  await app.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('corehub setup', () => {
  it('refuses a secret on the command line', async () => {
    const withToken = await cli(['setup', '--server', baseUrl, '--token', 'x'.repeat(48)]);
    expect(withToken.code).toBe(2);
    const withPassword = await cli(['setup', '--server', baseUrl, '--password', OWNER_PASSWORD]);
    expect(withPassword.code).toBe(2);
  });

  it('says where the token is, rejects a wrong one (exit 3) and a password typo (exit 1)', async () => {
    const wrong = await cli(
      ['setup', '--server', baseUrl, '--username', 'tariq'],
      ['0'.repeat(48), '', '', OWNER_PASSWORD, OWNER_PASSWORD],
    );
    expect(wrong.stderr).toContain('setup-token.txt');
    expect(wrong.code).toBe(3);
    expect(wrong.stderr).toMatch(/\[unauthorized, HTTP 401\]/);

    const token = readFileSync(tokenFile(), 'utf8').trim();
    const typo = await cli(
      ['setup', '--server', baseUrl, '--username', 'tariq'],
      [token, '', '', OWNER_PASSWORD, `${OWNER_PASSWORD}x`],
    );
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('not the same');
    // Neither attempt created anything.
    expect(existsSync(tokenFile())).toBe(true);
  });

  it('creates the owner from the token on disk and ends signed in', async () => {
    const token = readFileSync(tokenFile(), 'utf8').trim();
    const result = await cli(
      ['setup', '--server', baseUrl, '--username', 'tariq'],
      [token, 'طارق', 'مساحتي', OWNER_PASSWORD, OWNER_PASSWORD],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Owner account tariq created');
    // The password was asked for, never echoed into the output.
    expect(result.stderr).toContain('Password (8+ characters): ');
    expect(result.stdout).not.toContain(OWNER_PASSWORD);

    // The hub closed first run and deleted the token file.
    expect(existsSync(tokenFile())).toBe(false);
    const state = await fetch(`${baseUrl}/api/v1/auth/setup`);
    expect(await state.json()).toEqual({ required: false });

    const who = await cli(['whoami', '--json']);
    expect(who.code, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      server: baseUrl,
      profile: 'default',
      user: { username: 'tariq', display_name: 'طارق', role: 'owner' },
    });
  });

  it('a second run says the hub is already set up, and login works with the new password', async () => {
    const again = await cli(
      ['setup', '--server', baseUrl, '--username', 'someone'],
      ['0'.repeat(48), '', '', OWNER_PASSWORD, OWNER_PASSWORD],
    );
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already set up');

    const login = await cli(
      ['login', '--server', baseUrl, '--username', 'tariq'],
      [OWNER_PASSWORD],
    );
    expect(login.code, login.stderr).toBe(0);
    expect(login.stdout).toContain('Signed in as tariq (owner)');
  });
});

describe('corehub setup inside the open window (ADR 0019)', () => {
  it('asks for no token: name and password create the owner', async () => {
    const openDir = temp('setup-open-data');
    const openApp = await buildServer({
      // The default window (60 minutes after boot) is open: nobody needs the terminal log.
      config: loadConfig({ DATA_DIR: openDir, PORT: '0' }),
      logger: createLogger({ level: 'silent' }),
      modules: defaultModules,
    });
    try {
      await openApp.listen({ port: 0, host: '127.0.0.1' });
      const address = openApp.server.address();
      const openUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      // No token line in the input: the prompts are display name, profile, password, confirm.
      const result = await cli(
        ['setup', '--server', openUrl, '--username', 'layla'],
        ['', '', OWNER_PASSWORD, OWNER_PASSWORD],
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('setup is OPEN to whoever arrives first');
      expect(result.stderr).not.toContain('Setup token: ');
      expect(result.stdout).toContain('Owner account layla created');
    } finally {
      await openApp.close();
    }
  });
});
