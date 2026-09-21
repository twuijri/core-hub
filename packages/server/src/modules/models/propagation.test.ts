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
import { MANAGED_MARKER, mergeEnv, parseEnv, quoteValue } from './dotenv.js';
import {
  agentEnvironment,
  hermesEnvPlan,
  writeHermesConfiguration,
  writeHermesEnv,
  writeHermesModel,
  type PropagationState,
  type ResolvedCredential,
} from './propagation.js';

const homes: string[] = [];

/** A Hermes home with whatever files the test wants already in it. */
function hermesHome(files: Record<string, string> = {}): string {
  const home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-'));
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
  return { credentials: [], hermesModel: null, hermesModelBlocked: null, ...over };
}

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
    expect(result.model.changed).toEqual(['model.default', 'model.provider']);
    expect(readFileSync(path.join(home, '.env'), 'utf8')).toContain('ANTHROPIC_API_KEY=sk-a');
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('provider: anthropic');
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
