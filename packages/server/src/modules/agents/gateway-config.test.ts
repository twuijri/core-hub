/**
 * The block of an agent's own configuration the hub writes for the model gateway (DECISIONS §141,
 * `gateway-config.ts`): only the hub's part, the person's other settings kept as they were, and a
 * refusal — never a half-written file — when the file is not the hub's to change.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayContext } from './catalog/types.js';
import { applyGatewayConfig, type GatewayConfigInput } from './gateway-config.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { home: string; stateDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'corehub-gw-config-'));
  made.push(root);
  const home = path.join(root, 'home');
  mkdirSync(home);
  return { home, stateDir: path.join(root, 'data', 'gateway', 'agents') };
}

const context = (port = 41000): GatewayContext => ({
  anthropicBaseUrl: `http://127.0.0.1:${port}/gateway/anthropic`,
  openaiBaseUrl: `http://127.0.0.1:${port}/gateway/openai/v1`,
  googleBaseUrl: `http://127.0.0.1:${port}/gateway/google`,
  origin: `http://127.0.0.1:${port}`,
  token: 'chgw_secret-token',
  mainModel: 'corehub-main',
  smallModel: 'corehub-small',
  contextWindow: 200_000,
});

function apply(
  kind: GatewayConfigInput['kind'],
  where: { home: string; stateDir: string },
  extra: Partial<GatewayConfigInput> = {},
) {
  return applyGatewayConfig({
    kind,
    context: context(),
    env: { HOME: where.home },
    home: where.home,
    stateDir: where.stateDir,
    platform: 'linux',
    ...extra,
  });
}

describe('Gemini CLI', () => {
  it('needs nothing written when no sign-in is chosen, or an API key is', () => {
    const where = scratch();
    expect(apply('gemini-settings', where)).toEqual({ ok: true, env: {} });
    mkdirSync(path.join(where.home, '.gemini'));
    writeFileSync(
      path.join(where.home, '.gemini', 'settings.json'),
      '{ // mine\n "security": { "auth": { "selectedType": "gemini-api-key" } } }',
    );
    expect(apply('gemini-settings', where)).toEqual({ ok: true, env: {} });
    expect(existsSync(where.stateDir)).toBe(false);
  });

  it('signed in with Google: a home of the hub’s own, the same files, its settings on the gateway', () => {
    const where = scratch();
    const own = path.join(where.home, '.gemini');
    mkdirSync(own);
    const settings = JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
      ui: { theme: 'Default' },
      mcpServers: { mine: { command: 'x' } },
    });
    writeFileSync(path.join(own, 'settings.json'), settings);
    writeFileSync(path.join(own, 'oauth_creds.json'), '{"refresh_token":"the person’s"}');
    writeFileSync(path.join(own, 'GEMINI.md'), 'my memory');
    mkdirSync(path.join(where.home, '.agents'));
    const result = apply('gemini-settings', where);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = result.env.GEMINI_CLI_HOME!;
    expect(home.startsWith(where.stateDir)).toBe(true);
    const lent = path.join(home, '.gemini');
    expect(JSON.parse(readFileSync(path.join(lent, 'settings.json'), 'utf8'))).toEqual({
      security: { auth: { selectedType: 'gateway' } },
      ui: { theme: 'Default' },
      mcpServers: { mine: { command: 'x' } },
    });
    // Everything else is the person's own, by link — sessions (`tmp`) included.
    for (const name of ['oauth_creds.json', 'GEMINI.md', 'tmp']) {
      expect(lstatSync(path.join(lent, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(lent, name))).toBe(path.join(own, name));
    }
    expect(readlinkSync(path.join(home, '.agents'))).toBe(path.join(where.home, '.agents'));
    // The person's settings are untouched, and nothing holds the token.
    expect(readFileSync(path.join(own, 'settings.json'), 'utf8')).toBe(settings);
    expect(readFileSync(path.join(lent, 'settings.json'), 'utf8')).not.toContain('chgw_');
    // A file the person removed loses its link the next time.
    rmSync(path.join(own, 'GEMINI.md'));
    expect(apply('gemini-settings', where).ok).toBe(true);
    expect(existsSync(path.join(lent, 'GEMINI.md'))).toBe(false);
  });

  it('refuses what it may not override: an enforced sign-in, a file that does not parse, Windows', () => {
    const where = scratch();
    const own = path.join(where.home, '.gemini');
    mkdirSync(own);
    writeFileSync(
      path.join(own, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'vertex-ai', enforcedType: 'vertex-ai' } },
      }),
    );
    expect(apply('gemini-settings', where)).toMatchObject({ ok: false, reason: /enforce/ });
    writeFileSync(path.join(own, 'settings.json'), '{ not json');
    expect(apply('gemini-settings', where).ok).toBe(false);
    writeFileSync(
      path.join(own, 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    expect(apply('gemini-settings', where, { platform: 'win32' })).toMatchObject({
      ok: false,
      reason: /Windows/,
    });
  });
});

describe('Grok Build', () => {
  const PERSON = '# mine\n[models]\ndefault = "grok-4.5"\n\n[model.fast]\nmodel = "grok-fast"\n';

  it('adds one table between markers, keeps the rest byte for byte, and picks it by variable', () => {
    const where = scratch();
    const file = path.join(where.home, '.grok', 'config.toml');
    mkdirSync(path.dirname(file));
    writeFileSync(file, PERSON);
    const result = apply('grok-model', where);
    expect(result).toEqual({ ok: true, env: { GROK_DEFAULT_MODEL: 'corehub-gateway' } });
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith(PERSON)).toBe(true);
    expect(text).toContain('[model.corehub-gateway]');
    expect(text).toContain('base_url = "http://127.0.0.1:41000/gateway/openai/v1"');
    expect(text).toContain('env_key = "COREHUB_GATEWAY_TOKEN"');
    expect(text).toContain('api_backend = "chat_completions"');
    expect(text).not.toContain('chgw_');
    // The person's own default is theirs still.
    expect(text).toContain('default = "grok-4.5"');
    // A new port rewrites the block where it is; there is still one.
    applyGatewayConfig({
      kind: 'grok-model',
      context: context(42000),
      env: {},
      home: where.home,
      stateDir: where.stateDir,
    });
    const again = readFileSync(file, 'utf8');
    expect(again.match(/\[model\.corehub-gateway\]/g)).toHaveLength(1);
    expect(again).toContain('127.0.0.1:42000');
    expect(again.startsWith(PERSON)).toBe(true);
  });

  it('writes a new file under GROK_HOME when there is none', () => {
    const where = scratch();
    const grokHome = path.join(where.home, 'elsewhere');
    expect(apply('grok-model', where, { env: { GROK_HOME: grokHome } }).ok).toBe(true);
    expect(readFileSync(path.join(grokHome, 'config.toml'), 'utf8')).toMatch(
      /^# >>> Core Hub model gateway/,
    );
  });

  it('leaves a file alone that already names the model, or whose block is broken', () => {
    const where = scratch();
    const file = path.join(where.home, '.grok', 'config.toml');
    mkdirSync(path.dirname(file));
    const theirs = '[model."corehub-gateway"]\nmodel = "mine"\n';
    writeFileSync(file, theirs);
    expect(apply('grok-model', where)).toMatchObject({ ok: false, reason: /already defines/ });
    expect(readFileSync(file, 'utf8')).toBe(theirs);
    writeFileSync(
      file,
      '# >>> Core Hub model gateway (written by Core Hub; do not edit between these lines)\n',
    );
    expect(apply('grok-model', where)).toMatchObject({ ok: false, reason: /not closed/ });
  });

  it('refuses a link that leads out of the home', () => {
    const where = scratch();
    const outside = mkdtempSync(path.join(tmpdir(), 'corehub-gw-outside-'));
    made.push(outside);
    writeFileSync(path.join(outside, 'config.toml'), 'x = 1\n');
    mkdirSync(path.join(where.home, '.grok'));
    symlinkSync(path.join(outside, 'config.toml'), path.join(where.home, '.grok', 'config.toml'));
    expect(apply('grok-model', where)).toMatchObject({ ok: false, reason: /outside the home/ });
    expect(readFileSync(path.join(outside, 'config.toml'), 'utf8')).toBe('x = 1\n');
  });
});

describe('Pi', () => {
  const PERSON = {
    providers: {
      ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [] },
    },
    modelOverrides: { x: 1 },
  };

  it('keeps one provider of its own beside the person’s, and switches the session to it', () => {
    const where = scratch();
    const file = path.join(where.home, '.pi', 'agent', 'models.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(PERSON));
    const result = apply('pi-models', where);
    expect(result).toEqual({
      ok: true,
      env: {},
      sessionConfig: { model: 'corehub-gateway/corehub-main' },
    });
    const models = JSON.parse(readFileSync(file, 'utf8'));
    expect(models.providers.ollama).toEqual(PERSON.providers.ollama);
    expect(models.modelOverrides).toEqual({ x: 1 });
    expect(models.providers['corehub-gateway']).toMatchObject({
      baseUrl: 'http://127.0.0.1:41000/gateway/openai/v1',
      api: 'openai-completions',
      apiKey: '$COREHUB_GATEWAY_TOKEN',
      models: [{ id: 'corehub-main', contextWindow: 200_000 }, { id: 'corehub-small' }],
    });
    expect(readFileSync(file, 'utf8')).not.toContain('chgw_');
    // Its own entry is rewritten on a new port; the person's are not touched.
    applyGatewayConfig({
      kind: 'pi-models',
      context: context(43000),
      env: {},
      home: where.home,
      stateDir: where.stateDir,
    });
    const again = JSON.parse(readFileSync(file, 'utf8'));
    expect(again.providers['corehub-gateway'].baseUrl).toContain(':43000/');
    expect(again.providers.ollama).toEqual(PERSON.providers.ollama);
  });

  it('refuses a provider of the same name that is the person’s, or a file that does not parse', () => {
    const where = scratch();
    const dir = path.join(where.home, 'pi-home');
    const file = path.join(dir, 'models.json');
    mkdirSync(dir);
    const theirs = JSON.stringify({
      providers: { 'corehub-gateway': { baseUrl: 'https://example.com/v1' } },
    });
    writeFileSync(file, theirs);
    const env = { PI_CODING_AGENT_DIR: dir };
    expect(apply('pi-models', where, { env })).toMatchObject({ ok: false, reason: /already has/ });
    expect(readFileSync(file, 'utf8')).toBe(theirs);
    writeFileSync(file, '{ "providers": ');
    expect(apply('pi-models', where, { env }).ok).toBe(false);
  });
});
