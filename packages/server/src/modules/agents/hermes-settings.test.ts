/**
 * Hermes's own settings, round-tripped through the profile's files (contract decision §58): every
 * key is written where Hermes reads it, read back as the form shows it, and put back to Hermes's
 * default by `null`. The real Hermes reading the same files is `hermes-settings.real.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  HERMES_SECTION_KEYS,
  HermesSettingError,
  readHermesSettings,
  writeHermesSettings,
} from './hermes-settings.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(config?: string, env?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-settings-'));
  homes.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, 'config.yaml'), config);
  if (env !== undefined) writeFileSync(path.join(dir, '.env'), env);
  return dir;
}

const config = (dir: string) => readFileSync(path.join(dir, 'config.yaml'), 'utf8');
const dotenv = (dir: string) => readFileSync(path.join(dir, '.env'), 'utf8');

function field(dir: string, section: string, key: string, isDefault = true) {
  const found = readHermesSettings(dir, isDefault)
    .find((candidate) => candidate.key === section)!
    .fields.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no ${section}.${key}`);
  return found;
}

/**
 * Each option: what the form sends, where Hermes reads it and what the file must hold there, and
 * what the form shows afterwards.
 */
const ROUND_TRIPS: Array<{
  section: string;
  key: string;
  input: unknown;
  at: string[];
  file: unknown;
  shown?: unknown;
}> = [
  { section: 'agent', key: 'max_turns', input: 60, at: ['agent', 'max_turns'], file: 60 },
  { section: 'agent', key: 'max_turns', input: 0, at: ['agent', 'max_turns'], file: 0 },
  {
    section: 'agent',
    key: 'run_budget_seconds',
    input: 900,
    at: ['agent', 'run_budget_seconds'],
    file: 900,
  },
  {
    section: 'agent',
    key: 'tool_use_enforcement',
    input: 'on',
    at: ['agent', 'tool_use_enforcement'],
    file: true,
  },
  {
    section: 'agent',
    key: 'tool_use_enforcement',
    input: 'off',
    at: ['agent', 'tool_use_enforcement'],
    file: false,
  },
  {
    section: 'agent',
    key: 'reasoning_effort',
    input: 'high',
    at: ['agent', 'reasoning_effort'],
    file: 'high',
  },
  {
    section: 'memory',
    key: 'memory_char_limit',
    input: 4000,
    at: ['memory', 'memory_char_limit'],
    file: 4000,
  },
  {
    section: 'memory',
    key: 'user_char_limit',
    input: 2000,
    at: ['memory', 'user_char_limit'],
    file: 2000,
  },
  {
    section: 'approvals',
    key: 'approvals_mode',
    input: 'off',
    at: ['approvals', 'mode'],
    file: 'off',
  },
  {
    section: 'approvals',
    key: 'memory_write_approval',
    input: true,
    at: ['memory', 'write_approval'],
    file: true,
  },
  {
    section: 'approvals',
    key: 'skills_write_approval',
    input: true,
    at: ['skills', 'write_approval'],
    file: true,
  },
  { section: 'privacy', key: 'redact_pii', input: true, at: ['privacy', 'redact_pii'], file: true },
];

describe('Hermes settings round trip (config.yaml)', () => {
  it.each(
    ROUND_TRIPS.map((trip) => [`${trip.key} = ${JSON.stringify(trip.input)}`, trip] as const),
  )('%s', (_label, trip) => {
    const dir = home();
    const section = writeHermesSettings(dir, true, trip.section, { [trip.key]: trip.input });
    const parsed = parse(config(dir)) as Record<string, Record<string, unknown>>;
    let node: unknown = parsed;
    for (const step of trip.at) node = (node as Record<string, unknown>)[step];
    expect(node).toEqual(trip.file);
    expect(section.fields.find((f) => f.key === trip.key)?.value).toEqual(trip.shown ?? trip.input);
    // And back to Hermes's default: the key is gone, the value is `null`.
    writeHermesSettings(dir, true, trip.section, { [trip.key]: null });
    let after: unknown = parse(config(dir)) ?? {};
    for (const step of trip.at) after = (after as Record<string, unknown> | undefined)?.[step];
    expect(after).toBeUndefined();
    expect(field(dir, trip.section, trip.key).value).toBeNull();
  });

  it("shows Hermes's defaults while nothing is written", () => {
    const sections = readHermesSettings(home(), true);
    expect(sections.map((s) => s.key)).toEqual([...HERMES_SECTION_KEYS]);
    const defaults = Object.fromEntries(
      sections.flatMap((s) => s.fields.map((f) => [f.key, { value: f.value, default: f.default }])),
    );
    expect(defaults).toEqual({
      max_turns: { value: null, default: null },
      run_budget_seconds: { value: null, default: null },
      tool_use_enforcement: { value: null, default: 'auto' },
      reasoning_effort: { value: null, default: null },
      memory_char_limit: { value: null, default: 2200 },
      user_char_limit: { value: null, default: 1375 },
      approvals_mode: { value: null, default: 'smart' },
      memory_write_approval: { value: null, default: false },
      skills_write_approval: { value: null, default: false },
      https_proxy: { value: null, default: null },
      http_proxy: { value: null, default: null },
      no_proxy: { value: null, default: null },
      redact_pii: { value: null, default: false },
    });
    // Every field says what it does in both languages, and every section when it applies.
    for (const section of sections) {
      expect(section.applies).toMatch(/^(next_message|restart)$/);
      expect(section.note?.ar && section.note.en).toBeTruthy();
      for (const f of section.fields) expect(f.help?.ar && f.help.en).toBeTruthy();
    }
    expect(field(home(), 'agent', 'max_turns').default_text?.en).toContain('500');
  });

  it('edits only its keys: comments, order and every other key survive', () => {
    const dir = home(
      [
        '# my Hermes',
        'model:',
        '  default: gpt-5 # the one I like',
        'agent:',
        '  # keep the budget warning',
        '  budget_warning_ratio: 0.75',
        'mcp_servers:',
        '  files:',
        '    command: npx',
        '',
      ].join('\n'),
    );
    writeHermesSettings(dir, true, 'agent', { max_turns: 80, reasoning_effort: 'low' });
    const text = config(dir);
    expect(text).toContain('# my Hermes');
    expect(text).toContain('default: gpt-5 # the one I like');
    expect(text).toContain('# keep the budget warning');
    expect(text).toContain('budget_warning_ratio: 0.75');
    expect(text).toContain('command: npx');
    expect(parse(text).agent).toEqual({
      budget_warning_ratio: 0.75,
      max_turns: 80,
      reasoning_effort: 'low',
    });
  });

  it('reads the spellings Hermes itself accepts', () => {
    const dir = home(
      [
        'max_turns: unlimited', // the legacy root key, moved under agent by Hermes
        'agent:',
        '  tool_use_enforcement: [gpt, gemini]',
        '  reasoning_effort: false',
        'approvals:',
        '  mode: off', // YAML 1.1: a bare off is false
        'memory:',
        '  write_approval: "yes"',
        '',
      ].join('\n'),
    );
    expect(field(dir, 'agent', 'max_turns').value).toBe(0);
    const enforcement = field(dir, 'agent', 'tool_use_enforcement');
    expect(enforcement.value).toBe('custom');
    expect(enforcement.options.map((o) => o.value)).toEqual(['auto', 'on', 'off', 'custom']);
    expect(field(dir, 'agent', 'reasoning_effort').value).toBe('none');
    expect(field(dir, 'approvals', 'approvals_mode').value).toBe('off');
    expect(field(dir, 'approvals', 'memory_write_approval').value).toBe(true);
    // The list is a choice only while the file holds one; the form never writes it.
    expect(field(home(), 'agent', 'tool_use_enforcement').options.map((o) => o.value)).toEqual([
      'auto',
      'on',
      'off',
    ]);
  });

  it('writes a word YAML 1.1 reads as a boolean in quotes', () => {
    const dir = home();
    writeHermesSettings(dir, true, 'approvals', { approvals_mode: 'off' });
    expect(config(dir)).toContain("mode: 'off'");
  });

  it('moves a legacy root max_turns under agent instead of leaving two', () => {
    const dir = home('max_turns: 30\n');
    writeHermesSettings(dir, true, 'agent', { max_turns: 45 });
    expect(parse(config(dir))).toEqual({ agent: { max_turns: 45 } });
  });

  it('a run time limit of 0 means none, which is no key at all', () => {
    const dir = home('agent:\n  run_budget_seconds: 600\n');
    writeHermesSettings(dir, true, 'agent', { run_budget_seconds: 0 });
    expect(parse(config(dir))).toEqual({ agent: {} });
    expect(field(dir, 'agent', 'run_budget_seconds').value).toBeNull();
  });
});

describe('Hermes settings round trip (.env)', () => {
  it('writes the proxy to the profile .env, every other line kept', () => {
    const dir = home(undefined, '# keys\nOPENAI_API_KEY=sk-test\nhttps_proxy=http://old:1\n');
    writeHermesSettings(dir, true, 'network', {
      https_proxy: 'http://proxy.local:3128',
      http_proxy: 'socks5://proxy.local:1080',
      no_proxy: 'localhost, 127.0.0.1,.internal',
    });
    const text = dotenv(dir);
    expect(text).toContain('# keys');
    expect(text).toContain('OPENAI_API_KEY=sk-test');
    expect(text).toContain('HTTPS_PROXY=http://proxy.local:3128');
    expect(text).toContain('HTTP_PROXY=socks5://proxy.local:1080');
    // A value with spaces is written quoted, the way Hermes's dotenv reads it (`profile-env.ts`).
    expect(text).toContain('NO_PROXY="localhost, 127.0.0.1,.internal"');
    // The other spelling Hermes also reads would have kept the old one alive.
    expect(text).not.toContain('https_proxy=');
    expect(field(dir, 'network', 'https_proxy').value).toBe('http://proxy.local:3128');
    expect(field(dir, 'network', 'no_proxy').value).toBe('localhost, 127.0.0.1,.internal');

    writeHermesSettings(dir, true, 'network', { https_proxy: null, http_proxy: '' });
    expect(dotenv(dir)).not.toContain('HTTPS_PROXY');
    expect(dotenv(dir)).not.toContain('HTTP_PROXY');
    expect(field(dir, 'network', 'https_proxy').value).toBeNull();
  });

  it('reads a lower-case proxy Hermes would use', () => {
    const dir = home(undefined, 'https_proxy=http://lower:8080\n');
    expect(field(dir, 'network', 'https_proxy').value).toBe('http://lower:8080');
  });

  it('says where the proxy reaches, for the default profile and for a named one', () => {
    const dir = home();
    const note = (isDefault: boolean) =>
      readHermesSettings(dir, isDefault).find((s) => s.key === 'network')!;
    expect(note(true)).toMatchObject({ applies: 'restart', restart_required: true });
    expect(note(true).note?.en).toContain('every Core Hub conversation');
    expect(note(false).note?.en).toContain(
      "Core Hub's conversations use the default profile's proxy",
    );
    expect(note(true).note?.en).toContain('not Core Hub itself');
  });
});

describe('Hermes settings refusals', () => {
  const refused = (section: string, values: Record<string, unknown>) => {
    try {
      writeHermesSettings(home(), true, section, values);
    } catch (error) {
      expect(error).toBeInstanceOf(HermesSettingError);
      return (error as HermesSettingError).reason;
    }
    throw new Error('not refused');
  };

  it.each([
    ['agent', { max_turns: -1 }, 'out_of_range'],
    ['agent', { max_turns: 1.5 }, 'integer_expected'],
    ['agent', { max_turns: '60' }, 'integer_expected'],
    ['agent', { tool_use_enforcement: 'custom' }, 'choice_invalid'],
    ['agent', { reasoning_effort: 'extreme' }, 'choice_invalid'],
    ['memory', { memory_char_limit: 10 }, 'out_of_range'],
    ['approvals', { memory_write_approval: 'yes' }, 'boolean_expected'],
    ['network', { https_proxy: 'proxy.local:3128' }, 'format_invalid'],
    ['network', { https_proxy: 'http://a\nB=1' }, 'text_invalid'],
    ['network', { no_proxy: 'a b' }, 'format_invalid'],
    ['agent', { redact_pii: true }, 'setting_unknown'],
    ['session', { anything: 1 }, 'section_unknown'],
  ] as const)('%s %j → %s', (section, values, reason) => {
    expect(refused(section, values)).toBe(reason);
  });

  it('writes nothing when one value of the section is wrong', () => {
    const dir = home('agent:\n  max_turns: 10\n');
    expect(() =>
      writeHermesSettings(dir, true, 'agent', { max_turns: 20, reasoning_effort: 'extreme' }),
    ).toThrow(HermesSettingError);
    expect(config(dir)).toBe('agent:\n  max_turns: 10\n');
  });

  it('never rewrites a config.yaml it cannot parse', () => {
    const dir = home('agent: [unclosed\n');
    expect(() => writeHermesSettings(dir, true, 'agent', { max_turns: 5 })).toThrow(
      'config_unreadable',
    );
    expect(config(dir)).toBe('agent: [unclosed\n');
  });
});
