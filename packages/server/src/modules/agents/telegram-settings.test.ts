/**
 * Telegram's settings, round-tripped through the profile's files one group at a time: each value
 * lands where Hermes reads it, reads back the same, and the rest of the file is left as it was.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readEnv, writeEnvValue } from './channels.js';
import {
  SettingError,
  TELEGRAM_OPTIONS,
  readTelegramSettings,
  writeTelegramSettings,
} from './telegram-settings.js';

const homes: string[] = [];
function home(config?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-tg-settings-'));
  homes.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, 'config.yaml'), config, 'utf8');
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const text = (dir: string) => readFileSync(path.join(dir, 'config.yaml'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed YAML document, read by path in assertions
const yaml = (dir: string) => parse(text(dir)) as Record<string, any>;
const option = (dir: string, key: string) =>
  readTelegramSettings(dir).find((entry) => entry.key === key)!;

const CONFIG = `# the owner's notes
model:
  default: gpt-5
platforms:
  telegram:
    enabled: true # linked from the hub
`;

describe('reading', () => {
  it('lists every option with Hermes’s default while nothing is set', () => {
    const dir = home();
    const options = readTelegramSettings(dir);
    expect(options.map((entry) => entry.section)).toEqual(
      TELEGRAM_OPTIONS.map((spec) => spec.section),
    );
    expect(option(dir, 'show_reasoning')).toMatchObject({
      kind: 'toggle',
      value: null,
      default: false,
      source: null,
      shared: false,
    });
    expect(option(dir, 'tool_progress')).toMatchObject({
      default: 'off',
      choices: ['off', 'new', 'all', 'verbose'],
    });
    expect(option(dir, 'command_menu_max')).toMatchObject({ default: 60, min: 1, max: 100 });
    expect(option(dir, 'stt_enabled')).toMatchObject({ shared: true, default: true });
  });

  it('shows the profile-wide display value as the default Telegram inherits', () => {
    const dir = home('display:\n  show_reasoning: true\nstreaming:\n  enabled: true\n');
    expect(option(dir, 'show_reasoning')).toMatchObject({ value: null, default: true });
    expect(option(dir, 'streaming')).toMatchObject({ value: null, default: true });
  });

  it('reads a bare YAML `off` the way Hermes does', () => {
    const dir = home('display:\n  platforms:\n    telegram:\n      tool_progress: off\n');
    expect(option(dir, 'tool_progress')).toMatchObject({ value: 'off', source: 'config' });
  });
});

describe('replies', () => {
  it('writes the display options per platform, so only Telegram changes', () => {
    const dir = home(CONFIG);
    writeTelegramSettings(dir, {
      show_reasoning: true,
      reasoning_style: 'blockquote',
      tool_progress: 'off',
      streaming: true,
      cleanup_progress: true,
      notifications: 'all',
    });
    expect(yaml(dir).display.platforms.telegram).toEqual({
      show_reasoning: true,
      reasoning_style: 'blockquote',
      tool_progress: 'off',
      streaming: true,
      cleanup_progress: true,
      notifications: 'all',
    });
    // Quoted, or Hermes's YAML 1.1 reader would see a boolean.
    expect(text(dir)).toContain("tool_progress: 'off'");
    expect(text(dir)).toContain("# the owner's notes");
    expect(text(dir)).toContain('enabled: true # linked from the hub');
    expect(option(dir, 'show_reasoning')).toMatchObject({ value: true, source: 'config' });
  });

  it('writes the platform keys into the Telegram block', () => {
    const dir = home(CONFIG);
    writeTelegramSettings(dir, {
      reply_to_mode: 'off',
      reactions: true,
      typing_indicator: false,
      disable_link_previews: true,
    });
    expect(yaml(dir).platforms.telegram).toMatchObject({
      enabled: true,
      reply_to_mode: 'off',
      reactions: true,
      typing_indicator: false,
      disable_link_previews: true,
    });
    expect(text(dir)).toContain("reply_to_mode: 'off'");
  });

  it('changes a key where it already is, `extra` included', () => {
    const dir = home('platforms:\n  telegram:\n    extra:\n      reactions: false\n');
    writeTelegramSettings(dir, { reactions: true });
    expect(yaml(dir).platforms.telegram).toEqual({ extra: { reactions: true } });
  });
});

describe('groups and access', () => {
  it('writes into .env what Hermes already reads from there, the file otherwise', () => {
    const dir = home(CONFIG);
    writeEnvValue(dir, 'TELEGRAM_REQUIRE_MENTION', 'false');
    writeTelegramSettings(dir, {
      require_mention: true,
      allowed_chats: ['-1001234567890', '-1001234567890', '-42'],
      observe_unmentioned_group_messages: true,
      exclusive_bot_mentions: false,
      allow_bots: 'all',
      guest_mode: true,
      group_allowed_users: ['111', '222'],
      allowed_users: ['333'],
      unauthorized_dm_behavior: 'ignore',
    });
    expect(readEnv(dir)).toMatchObject({
      TELEGRAM_REQUIRE_MENTION: 'true',
      TELEGRAM_GROUP_ALLOWED_USERS: '111,222',
      TELEGRAM_ALLOWED_USERS: '333',
    });
    const telegram = yaml(dir).platforms.telegram;
    expect(telegram.require_mention).toBeUndefined();
    // Chat ids stay strings in the file, each once.
    expect(telegram.allowed_chats).toEqual(['-1001234567890', '-42']);
    expect(telegram).toMatchObject({
      observe_unmentioned_group_messages: true,
      exclusive_bot_mentions: false,
      allow_bots: 'all',
      guest_mode: true,
      unauthorized_dm_behavior: 'ignore',
    });
    expect(option(dir, 'require_mention')).toMatchObject({ value: true, source: 'env' });
    expect(option(dir, 'allowed_chats')).toMatchObject({
      value: ['-1001234567890', '-42'],
      source: 'config',
    });
    expect(option(dir, 'allowed_users')).toMatchObject({ value: ['333'], source: 'env' });
  });
});

describe('media and voice', () => {
  it('writes the profile-wide speech settings, marked as shared', () => {
    const dir = home(CONFIG);
    writeTelegramSettings(dir, {
      stt_enabled: false,
      stt_echo_transcripts: false,
      voice_auto_tts: true,
    });
    expect(yaml(dir)).toMatchObject({
      stt: { enabled: false, echo_transcripts: false },
      voice: { auto_tts: true },
    });
    expect(option(dir, 'voice_auto_tts')).toMatchObject({ value: true, shared: true });
  });
});

describe('advanced', () => {
  it('writes the home chat in Hermes’s shape, the menu size and a proxy', () => {
    const dir = home(CONFIG);
    writeTelegramSettings(dir, {
      home_channel: '-1005550000',
      command_menu_max: 30,
      proxy_url: 'socks5://127.0.0.1:1080',
      gateway_restart_notification: false,
    });
    const telegram = yaml(dir).platforms.telegram;
    expect(telegram.home_channel).toEqual({
      platform: 'telegram',
      name: 'Home',
      chat_id: '-1005550000',
    });
    expect(telegram.extra.command_menu.max_commands).toBe(30);
    expect(telegram.proxy_url).toBe('socks5://127.0.0.1:1080');
    expect(telegram.gateway_restart_notification).toBe(false);
    expect(option(dir, 'home_channel')).toMatchObject({ value: '-1005550000' });
  });

  it('goes back to the default on null, from the file and from .env', () => {
    const dir = home(CONFIG);
    writeEnvValue(dir, 'TELEGRAM_REACTIONS', 'true');
    writeTelegramSettings(dir, { show_reasoning: true, home_channel: '-1', command_menu_max: 5 });
    writeTelegramSettings(dir, {
      show_reasoning: null,
      home_channel: null,
      command_menu_max: null,
      reactions: null,
    });
    expect(option(dir, 'show_reasoning')).toMatchObject({ value: null, source: null });
    expect(option(dir, 'reactions')).toMatchObject({ value: null });
    expect(readEnv(dir).TELEGRAM_REACTIONS).toBeUndefined();
    expect(yaml(dir).platforms.telegram.home_channel).toBeUndefined();
    expect(text(dir)).toContain("# the owner's notes");
  });
});

describe('refusing', () => {
  it('writes nothing when one value is wrong', () => {
    const dir = home(CONFIG);
    const before = text(dir);
    const attempt = (values: Record<string, unknown>) => {
      try {
        writeTelegramSettings(dir, values);
        return null;
      } catch (error) {
        return error instanceof SettingError ? [error.key, error.reason] : error;
      }
    };
    expect(attempt({ show_reasoning: true, no_such_thing: 1 })).toEqual([
      'no_such_thing',
      'setting_unknown',
    ]);
    expect(attempt({ show_reasoning: 'yes' })).toEqual(['show_reasoning', 'boolean_expected']);
    expect(attempt({ tool_progress: 'log' })).toEqual(['tool_progress', 'choice_invalid']);
    expect(attempt({ command_menu_max: 101 })).toEqual(['command_menu_max', 'number_invalid']);
    expect(attempt({ allowed_users: ['-5'] })).toEqual(['allowed_users', 'item_invalid']);
    expect(attempt({ proxy_url: 'not a url' })).toEqual(['proxy_url', 'url_invalid']);
    expect(text(dir)).toBe(before);
    expect(readEnv(dir)).toEqual({});
  });
});
