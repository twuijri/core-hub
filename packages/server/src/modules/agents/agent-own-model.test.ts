/**
 * The model a coding agent's own settings name as its default (owner, 2026-09-29: the picker
 * said "Default model" without saying which).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentOwnModel } from './agent-own-model.js';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-own-model-'));
  homes.push(dir);
  return dir;
}
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("a coding agent's own default model", () => {
  it('reads each agent’s own key', () => {
    const dir = home();
    const at = { env: {}, home: dir };
    put(path.join(dir, '.claude', 'settings.json'), '{"model":"claude-opus-4-1"}');
    put(
      path.join(dir, '.codex', 'config.toml'),
      'model = "gpt-5-codex"\n[profiles.fast]\nmodel = "gpt-5-mini"\n',
    );
    put(
      path.join(dir, '.gemini', 'settings.json'),
      '{\n // mine\n "model": {"name": "gemini-2.5-pro"}}',
    );
    put(
      path.join(dir, '.config', 'goose', 'config.yaml'),
      'GOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt-4o\n',
    );
    put(
      path.join(dir, '.config', 'opencode', 'opencode.json'),
      '{"model":"anthropic/claude-sonnet-4"}',
    );
    expect(agentOwnModel('claude-code', at)).toBe('claude-opus-4-1');
    expect(agentOwnModel('codex', at)).toBe('gpt-5-codex');
    expect(agentOwnModel('gemini-cli', at)).toBe('gemini-2.5-pro');
    expect(agentOwnModel('goose', at)).toBe('gpt-4o');
    expect(agentOwnModel('opencode', at)).toBe('anthropic/claude-sonnet-4');
  });

  it('says nothing when the settings name none, or it cannot read them', () => {
    const dir = home();
    const at = { env: {}, home: dir };
    expect(agentOwnModel('claude-code', at)).toBeNull();
    // A model only inside a profile table is not the default.
    put(path.join(dir, '.codex', 'config.toml'), '[profiles.fast]\nmodel = "gpt-5-mini"\n');
    expect(agentOwnModel('codex', at)).toBeNull();
    put(path.join(dir, '.gemini', 'settings.json'), '{ not json');
    expect(agentOwnModel('gemini-cli', at)).toBeNull();
    expect(agentOwnModel('kimi-code', at)).toBeNull();
  });
});
