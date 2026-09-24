/**
 * Propagation: the owner adds a key once and every agent gets it (ADR 0010).
 *
 * The two halves are tested separately here — the `.env` / `config.yaml` merge against a
 * scripted Hermes home, and the environment a process agent is handed — and end to end
 * in `models-api.test.ts`, which proves a newly installed coding agent starts with the
 * right variables without anybody opening its settings.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_MANAGED_MARKER, MANAGED_MARKER, mergeEnv, parseEnv, quoteValue } from './dotenv.js';
import {
  agentEnvironment,
  hermesEnvPlan,
  writeHermesConfiguration,
  writeHermesEnv,
  writeHermesModel,
  writeHermesProviders,
  writeHermesRoute,
  type HermesProviderRoute,
  type PropagationState,
  type ResolvedCredential,
} from './propagation.js';

const homes: string[] = [];

/** A Hermes home with whatever files the test wants already in it. */
function hermesHome(files: Record<string, string> = {}): string {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
  homes.push(home);
  mkdirSync(home, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(home, name), body);
  }
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const credential = (
  family: string,
  envVar: string,
  value: string,
  hermesEnvVars: string[] = [envVar],
): ResolvedCredential => ({ family, envVar, hermesEnvVars, value });

function state(over: Partial<PropagationState> = {}): PropagationState {
  return {
    credentials: [],
    hermesProviders: [],
    hermesModel: null,
    hermesModelBlocked: null,
    ...over,
  };
}

const route = (over: Partial<HermesProviderRoute> = {}): HermesProviderRoute => ({
  name: 'corehub-lmstudio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiMode: 'chat_completions',
  keyEnv: 'COREHUB_PROVIDER_LMSTUDIO_API_KEY',
  ...over,
});

// ------------------------------------------------------------------ the merge

describe('models: the .env merge', () => {
  it('reads the shapes a dotenv file actually comes in', () => {
    const parsed = parseEnv(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED=exported-value',
        'SPACED = spaced',
        'QUOTED="has spaces and # hash"',
        "SINGLE='single'",
        'TRAILING=bare # trailing comment',
        'not a line at all',
      ].join('\n'),
    );
    expect(Object.fromEntries(parsed)).toEqual({
      PLAIN: 'value',
      EXPORTED: 'exported-value',
      SPACED: 'spaced',
      QUOTED: 'has spaces and # hash',
      SINGLE: 'single',
      TRAILING: 'bare',
    });
  });

  it('quotes only what needs it, the way Hermes’s own writer does', () => {
    expect(quoteValue('sk-ant-api03-plain')).toBe('sk-ant-api03-plain');
    expect(quoteValue('has space')).toBe('"has space"');
    expect(quoteValue('has#hash')).toBe('"has#hash"');
    expect(quoteValue('')).toBe('""');
    expect(quoteValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('replaces only the variables it owns and copies every other line through', () => {
    const before = [
      '# Hermes配置 — do not lose me',
      'HERMES_YOLO_MODE=0',
      'ANTHROPIC_API_KEY=sk-old',
      '',
      '# something a person wrote',
      'TELEGRAM_BOT_TOKEN=12345:abc',
    ].join('\n');

    const merged = mergeEnv(before, { ANTHROPIC_API_KEY: 'sk-new' }, ['ANTHROPIC_API_KEY']);

    expect(merged.changed).toEqual(['ANTHROPIC_API_KEY']);
    expect(merged.removed).toEqual([]);
    expect(merged.text).toContain('# Hermes配置 — do not lose me');
    expect(merged.text).toContain('HERMES_YOLO_MODE=0');
    expect(merged.text).toContain('# something a person wrote');
    expect(merged.text).toContain('TELEGRAM_BOT_TOKEN=12345:abc');
    expect(merged.text).toContain('ANTHROPIC_API_KEY=sk-new');
    expect(merged.text).not.toContain('sk-old');
    // In place: the key keeps its line, so a diff is one line.
    expect(merged.text.split('\n').indexOf('ANTHROPIC_API_KEY=sk-new')).toBe(2);
  });

  it('appends new variables under one marked section', () => {
    const merged = mergeEnv('EXISTING=1\n', { OPENAI_API_KEY: 'sk-a', GROQ_API_KEY: 'gsk-b' }, [
      'OPENAI_API_KEY',
      'GROQ_API_KEY',
    ]);
    expect(merged.text).toBe(
      ['EXISTING=1', '', MANAGED_MARKER, 'GROQ_API_KEY=gsk-b', 'OPENAI_API_KEY=sk-a', ''].join(
        '\n',
      ),
    );
    expect(merged.changed.sort()).toEqual(['GROQ_API_KEY', 'OPENAI_API_KEY']);
  });

  it('removes a variable it owns once the provider has no key, and nothing else', () => {
    const before = [MANAGED_MARKER, 'ANTHROPIC_API_KEY=sk-old', 'KEEP_ME=yes'].join('\n');
    const merged = mergeEnv(before, {}, ['ANTHROPIC_API_KEY']);
    expect(merged.removed).toEqual(['ANTHROPIC_API_KEY']);
    expect(merged.text).toBe('KEEP_ME=yes\n');
  });

  it('leaves a variable alone when it is not one of ours, even with the same name shape', () => {
    const before = 'SOME_OTHER_API_KEY=theirs\n';
    const merged = mergeEnv(before, { ANTHROPIC_API_KEY: 'sk-a' }, ['ANTHROPIC_API_KEY']);
    expect(merged.text).toContain('SOME_OTHER_API_KEY=theirs');
  });
});

// ------------------------------------------------------- the Hermes home itself

describe('models: writing the Hermes home', () => {
  it('writes every name Hermes reads a family from, not just ours', () => {
    const home = hermesHome();
    // Hermes prefers GOOGLE_API_KEY; the Gemini CLI wants GEMINI_API_KEY. One key, both.
    const plan = hermesEnvPlan(
      home,
      state({
        credentials: [
          credential('google', 'GEMINI_API_KEY', 'AIza-scripted', [
            'GOOGLE_API_KEY',
            'GEMINI_API_KEY',
          ]),
        ],
      }),
    );
    expect(plan.owned.sort()).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    writeHermesEnv(plan);
    const written = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
    expect(written.get('GOOGLE_API_KEY')).toBe('AIza-scripted');
    expect(written.get('GEMINI_API_KEY')).toBe('AIza-scripted');
  });

  it('creates the file readable only by its owner and says nothing changed the second time', () => {
    const home = hermesHome();
    const plan = hermesEnvPlan(
      home,
      state({ credentials: [credential('anthropic', 'ANTHROPIC_API_KEY', 'sk-a')] }),
    );

    const first = writeHermesEnv(plan);
    expect(first.dirty).toBe(true);
    expect(first.changed).toEqual(['ANTHROPIC_API_KEY']);
    expect(statSync(first.file).mode & 0o777).toBe(0o600);

    // A hub that restarts must not restart Hermes for nothing.
    const second = writeHermesEnv(plan);
    expect(second.dirty).toBe(false);
    expect(second.changed).toEqual([]);
  });

  it('upgrades the fresh-install `model: ""` sentinel into the mapping Hermes expects', () => {
    const home = hermesHome({ 'config.yaml': 'model: ""\nterminal:\n  backend: local\n' });
    const result = writeHermesModel(home, { provider: 'anthropic', model: 'claude-sonnet-4-5' });

    expect(result.dirty).toBe(true);
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('default: claude-sonnet-4-5');
    expect(text).toContain('provider: anthropic');
    // A sibling section the person configured survives.
    expect(text).toContain('backend: local');
  });

  it('sets one key at a time, keeping comments and sibling keys', () => {
    const home = hermesHome({
      'config.yaml': [
        '# my hermes config',
        'model:',
        '  default: claude-opus-4-1',
        '  provider: anthropic',
        '  context_length: 200000   # mine, keep it',
        'approvals:',
        '  mode: smart',
        '',
      ].join('\n'),
    });
    const result = writeHermesModel(home, { provider: 'anthropic', model: 'claude-sonnet-4-5' });

    expect(result.changed).toEqual(['model.default']);
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('# my hermes config');
    expect(text).toContain('context_length: 200000');
    expect(text).toContain('# mine, keep it');
    expect(text).toContain('mode: smart');
    expect(text).toContain('default: claude-sonnet-4-5');
  });

  it('clears the previous provider’s route when the provider changes', () => {
    const home = hermesHome({
      'config.yaml': [
        'model:',
        '  default: anthropic/claude-opus-4-1',
        '  provider: openrouter',
        '  base_url: https://openrouter.ai/api/v1',
        '  api_mode: chat_completions',
        '',
      ].join('\n'),
    });
    const result = writeHermesModel(home, { provider: 'anthropic', model: 'claude-sonnet-4-5' });

    expect(result.changed.sort()).toEqual(['model.default', 'model.provider']);
    expect(result.removed.sort()).toEqual(['model.api_mode', 'model.base_url']);
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(text).not.toContain('openrouter.ai');
    expect(text).not.toContain('api_mode');
  });

  it('writes nothing when the workspace has no default, rather than clearing Hermes’s own', () => {
    const home = hermesHome({
      'config.yaml': 'model:\n  default: keep-me\n  provider: anthropic\n',
    });
    const result = writeHermesModel(home, null);
    expect(result.dirty).toBe(false);
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('keep-me');
  });

  it('refuses to rewrite a config.yaml it cannot parse', () => {
    const home = hermesHome({ 'config.yaml': 'model:\n  default: [unclosed\n' });
    expect(() => writeHermesModel(home, { provider: 'anthropic', model: 'x' })).toThrow(
      /not valid YAML/,
    );
  });

  it('writes both files in one call and reports one dirty flag', () => {
    const home = hermesHome();
    const result = writeHermesConfiguration(
      home,
      state({
        credentials: [credential('anthropic', 'ANTHROPIC_API_KEY', 'sk-a')],
        hermesModel: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      }),
    );
    expect(result.dirty).toBe(true);
    expect(result.env.changed).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.config.changed).toEqual(['model.default', 'model.provider']);
    expect(readFileSync(path.join(home, '.env'), 'utf8')).toContain('ANTHROPIC_API_KEY=sk-a');
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('provider: anthropic');
  });

  it('creates no config.yaml at all when there is nothing to say', () => {
    // Writing `null` into the file is worse than not writing it: Hermes's own loader then
    // has a document that is not a mapping, and the next write cannot set a key in it.
    const home = hermesHome();
    const result = writeHermesConfiguration(
      home,
      state({ credentials: [credential('anthropic', 'ANTHROPIC_API_KEY', 'sk-a')] }),
    );
    expect(result.config.dirty).toBe(false);
    expect(() => readFileSync(path.join(home, 'config.yaml'), 'utf8')).toThrow();
  });
});

// ----------------------------------------------- the providers: blocks (ADR 0010)

describe('models: OpenAI-compatible endpoints as Hermes providers', () => {
  it('writes a block Hermes understands, with only the keys it documents', () => {
    const home = hermesHome();
    const result = writeHermesProviders(home, [route()]);
    expect(result.changed).toEqual(['providers.corehub-lmstudio']);
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('corehub-lmstudio:');
    expect(text).toContain('base_url: http://127.0.0.1:1234/v1');
    expect(text).toContain('api_mode: chat_completions');
    expect(text).toContain('key_env: COREHUB_PROVIDER_LMSTUDIO_API_KEY');
    // `enabled` is honoured by Hermes but absent from its accepted-keys list, so writing
    // it makes the gateway log "unknown config keys ignored" about our own file.
    expect(text).not.toContain('enabled:');
  });

  it('leaves a transport Hermes should detect out of the block', () => {
    const home = hermesHome();
    writeHermesProviders(home, [route({ apiMode: null })]);
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).not.toContain('api_mode');
  });

  it('keeps blocks somebody else wrote and removes only its own', () => {
    const home = hermesHome({
      'config.yaml': [
        '# a comment the hub must not destroy',
        'providers:',
        '  my-own-proxy:',
        '    base_url: https://proxy.example/v1',
        '  corehub-gone:',
        '    base_url: https://gone.example/v1',
        'model:',
        '  default: keep-me',
        '',
      ].join('\n'),
    });
    const result = writeHermesProviders(home, [route()]);
    expect(result.removed).toEqual(['providers.corehub-gone']);
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('# a comment the hub must not destroy');
    expect(text).toContain('my-own-proxy:');
    expect(text).toContain('default: keep-me');
    expect(text).not.toContain('corehub-gone');
    expect(text).toContain('corehub-lmstudio:');
  });

  it('rewrites nothing when the blocks already say what they should', () => {
    const home = hermesHome();
    writeHermesProviders(home, [route()]);
    const before = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    const again = writeHermesProviders(home, [route()]);
    expect(again.dirty).toBe(false);
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe(before);
  });

  it('drops the providers mapping when the last block of ours goes', () => {
    const home = hermesHome();
    writeHermesProviders(home, [route()]);
    const result = writeHermesProviders(home, []);
    expect(result.removed).toEqual(['providers.corehub-lmstudio']);
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).not.toContain('providers:');
  });
});

// ------------------------------------------------ the rename (Majlis → Core Hub)

describe('models: a Hermes home written before the rename (ADR 0017)', () => {
  const custom = route({
    name: 'corehub-custom-cli-proxy-api',
    baseUrl: 'http://proxy.example:8317/v1',
    keyEnv: 'COREHUB_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY',
  });
  const oldProfile = [
    '# the owner wrote this',
    'model:',
    '  default: gpt-5.4',
    '  provider: majlis-custom-cli-proxy-api',
    'fallback_model:',
    '  provider: majlis-custom-cli-proxy-api',
    '  model: gpt-5.4-mini',
    'providers:',
    '  majlis-custom-cli-proxy-api:',
    '    name: majlis-custom-cli-proxy-api',
    '    base_url: http://proxy.example:8317/v1',
    '    key_env: MAJLIS_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY',
    '    api_mode: chat_completions',
    '  my-own-proxy:',
    '    base_url: https://proxy.example/v1',
    'note: majlis-custom-cli-proxy-api is what I use',
    '',
  ].join('\n');

  it('keeps a profile whose model names an old block working: the block and its references move together', () => {
    const home = hermesHome({ 'config.yaml': oldProfile });
    const result = writeHermesProviders(home, [custom]);
    expect(result.dirty).toBe(true);
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    // The block is the new name, pointing at the new variable…
    expect(text).toContain('corehub-custom-cli-proxy-api:');
    expect(text).toContain('key_env: COREHUB_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY');
    // …what named the old block names the new one, so Hermes resolves it…
    expect(text).toContain('  provider: corehub-custom-cli-proxy-api\n');
    expect(text).not.toMatch(/provider: majlis-/);
    // …and the old block is gone, while everything that was never the hub's stays.
    expect(text).not.toContain('majlis-custom-cli-proxy-api:');
    expect(text).toContain('# the owner wrote this');
    expect(text).toContain('my-own-proxy:');
    expect(text).toContain('note: majlis-custom-cli-proxy-api is what I use');
    expect(result.removed).toContain('providers.majlis-custom-cli-proxy-api');
    expect(result.changed).toEqual(
      expect.arrayContaining(['model.provider', 'fallback_model.provider']),
    );
  });

  it('is done once: the next write finds nothing to change', () => {
    const home = hermesHome({ 'config.yaml': oldProfile });
    writeHermesProviders(home, [custom]);
    expect(writeHermesProviders(home, [custom]).dirty).toBe(false);
  });

  it('moves the reference of a messaging gateway too, where the model is written as well', () => {
    const home = hermesHome({ 'config.yaml': oldProfile });
    writeHermesRoute(
      home,
      state({
        hermesProviders: [custom],
        hermesModel: { provider: 'corehub-custom-cli-proxy-api', model: 'gpt-5.4' },
      }),
    );
    const text = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(text).not.toMatch(/majlis-custom-cli-proxy-api:|provider: majlis-/);
    expect(text).toContain('provider: corehub-custom-cli-proxy-api');
  });

  it('removes an old block the profile no longer has, as it would its own', () => {
    const home = hermesHome({
      'config.yaml': 'providers:\n  majlis-gone:\n    base_url: https://gone.example/v1\n',
    });
    const result = writeHermesProviders(home, [route()]);
    expect(result.removed).toEqual(['providers.majlis-gone']);
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).not.toContain('majlis-gone');
  });

  it('replaces the old key line and marker in the .env with the new ones', () => {
    const home = hermesHome({
      '.env': [
        'OWNER_THING=keep',
        '',
        LEGACY_MANAGED_MARKER,
        'MAJLIS_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY=sk-proxy',
        '',
      ].join('\n'),
    });
    const result = writeHermesEnv(
      hermesEnvPlan(
        home,
        state({
          credentials: [
            credential(
              'custom-cli-proxy-api',
              'COREHUB_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY',
              'sk-proxy',
            ),
          ],
          ownedEnv: [
            'COREHUB_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY',
            'MAJLIS_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY',
          ],
        }),
      ),
    );
    const text = readFileSync(path.join(home, '.env'), 'utf8');
    expect(result.removed).toEqual(['MAJLIS_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY']);
    expect(text).toContain('OWNER_THING=keep');
    expect(text).toContain('COREHUB_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY=sk-proxy');
    expect(text).not.toContain('MAJLIS_');
    expect(text).not.toContain(LEGACY_MANAGED_MARKER);
    expect(text.split(MANAGED_MARKER).length - 1).toBe(1);
  });
});

// ------------------------------------------------------------- process agents

describe('models: the environment a process agent starts with', () => {
  const credentials = [
    credential('anthropic', 'ANTHROPIC_API_KEY', 'sk-ant-shared'),
    credential('openai', 'OPENAI_API_KEY', 'sk-openai-shared'),
    credential('google', 'GEMINI_API_KEY', 'AIza-shared', ['GOOGLE_API_KEY', 'GEMINI_API_KEY']),
  ];

  it('hands an agent exactly the families it declared, under the names it asked for', () => {
    // The Gemini CLI's one catalog line; nobody typed a key for it.
    const env = agentEnvironment({
      credentials,
      declared: { google: 'GEMINI_API_KEY' },
    });
    expect(env).toEqual({ GEMINI_API_KEY: 'AIza-shared' });
  });

  it('gives an agent that declares nothing nothing at all', () => {
    expect(agentEnvironment({ credentials, declared: {} })).toEqual({});
  });

  it('renames a family for the agent that spells it differently', () => {
    const env = agentEnvironment({
      credentials,
      declared: { google: 'GOOGLE_GENERATIVE_AI_API_KEY' },
    });
    expect(env).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-shared' });
  });

  it('lets a per-agent secret_ref override the shared store', () => {
    const env = agentEnvironment({
      credentials,
      declared: { anthropic: 'ANTHROPIC_API_KEY' },
      settingsEnv: { ANTHROPIC_LOG: 'debug' },
      secretRefValues: { ANTHROPIC_API_KEY: 'sk-ant-pinned-to-this-agent' },
    });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-pinned-to-this-agent',
      ANTHROPIC_LOG: 'debug',
    });
  });

  it('gives a multi-provider agent every key it declared, in one step', () => {
    const env = agentEnvironment({
      credentials,
      declared: {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GEMINI_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
      },
    });
    // OpenRouter was declared but no key is stored for it: nothing invented.
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-shared',
      OPENAI_API_KEY: 'sk-openai-shared',
      GEMINI_API_KEY: 'AIza-shared',
    });
  });
});
