/**
 * Whether an installed coding agent has a key or a sign-in (owner, 2026-09-29): Goose with no
 * config and Claude Code signed in nowhere looked ready and failed the first message.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialState } from './agent-credentials.js';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-cred-'));
  homes.push(dir);
  return dir;
}
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe('an installed coding agent’s credentials', () => {
  it('Claude Code: missing with nothing; ready with a handed key, a sign-in or a key setting', () => {
    const dir = home();
    const options = { env: {}, home: dir };
    expect(credentialState('claude-code', ['ANTHROPIC_API_KEY'], {}, options)).toBe('missing');
    expect(
      credentialState('claude-code', ['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: 'k' }, options),
    ).toBe('ready');
    put(path.join(dir, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_AUTH_TOKEN":"x"}}');
    expect(credentialState('claude-code', [], {}, options)).toBe('ready');
    rmSync(path.join(dir, '.claude', 'settings.json'));
    put(path.join(dir, '.claude', '.credentials.json'), '{}');
    expect(credentialState('claude-code', [], {}, options)).toBe('ready');
  });

  it('follows the agent’s own folder variable', () => {
    const dir = home();
    const moved = path.join(dir, 'elsewhere');
    put(path.join(moved, 'auth.json'), '{}');
    expect(credentialState('codex', ['OPENAI_API_KEY'], {}, { env: {}, home: dir })).toBe(
      'missing',
    );
    expect(
      credentialState('codex', ['OPENAI_API_KEY'], {}, { env: { CODEX_HOME: moved }, home: dir }),
    ).toBe('ready');
  });

  it('Goose: a key alone is not enough; its config must name a provider', () => {
    const dir = home();
    const options = { env: {}, home: dir };
    expect(credentialState('goose', ['OPENAI_API_KEY'], { OPENAI_API_KEY: 'k' }, options)).toBe(
      'missing',
    );
    put(
      path.join(dir, '.config', 'goose', 'config.yaml'),
      'GOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt\n',
    );
    expect(credentialState('goose', ['OPENAI_API_KEY'], {}, options)).toBe('ready');
  });

  it('Gemini CLI: a Google sign-in or a key in its own .env', () => {
    const dir = home();
    const options = { env: {}, home: dir };
    expect(credentialState('gemini-cli', ['GEMINI_API_KEY'], {}, options)).toBe('missing');
    put(path.join(dir, '.gemini', '.env'), 'GEMINI_API_KEY=abc\n');
    expect(credentialState('gemini-cli', ['GEMINI_API_KEY'], {}, options)).toBe('ready');
  });

  it('says nothing about an agent whose sign-in it does not know', () => {
    expect(credentialState('kimi-code', [], {}, { env: {}, home: home() })).toBeNull();
    expect(credentialState('opencode', [], {}, { env: {}, home: home() })).toBeNull();
  });
});
