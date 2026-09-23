/**
 * Channels are the other block of the same file. The tests are about what the file still
 * says afterwards, and about a credential that must not come back.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelError, clearChannel, getChannel, listChannels, putChannel } from './channels.js';
import { STORED } from './mcp.js';

const homes: string[] = [];
function home(config?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-channels-'));
  homes.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, 'config.yaml'), config, 'utf8');
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (dir: string) => readFileSync(path.join(dir, 'config.yaml'), 'utf8');

const CONFIG = `# hermes
mcp_servers:
  studio-api:
    command: node

platforms:
  telegram:
    enabled: true
    token: 1234:secret-bot-token
    require_mention: false
    extra:
      allowed_chat_id: '9911'
      webhook_secret: hush
  webhook:
    enabled: true
    extra: '{}'
`;

describe('reading the block', () => {
  it('lists the platforms in the file, and says which are exclusive', () => {
    const channels = listChannels(home(CONFIG));
    expect(channels.map((c) => c.platform)).toEqual(['telegram', 'webhook']);
    // One identity, one place: Telegram will not let two things poll one bot token.
    expect(channels.find((c) => c.platform === 'telegram')?.exclusive).toBe(true);
    expect(channels.find((c) => c.platform === 'webhook')?.exclusive).toBe(false);
  });

  it('takes the fields from the file rather than from a form we wrote', () => {
    // Hermes's platform list grows; a form per platform would be wrong for the next one.
    const telegram = getChannel(home(CONFIG), 'telegram');
    expect(telegram?.fields.map((f) => f.key)).toEqual([
      'extra.allowed_chat_id',
      'extra.webhook_secret',
      'require_mention',
      'token',
    ]);
  });

  it('types a field by what it looks like', () => {
    const telegram = getChannel(home(CONFIG), 'telegram');
    const byKey = Object.fromEntries((telegram?.fields ?? []).map((f) => [f.key, f]));
    expect(byKey.token?.kind).toBe('secret');
    expect(byKey.require_mention?.kind).toBe('boolean');
    expect(byKey['extra.allowed_chat_id']?.kind).toBe('text');
  });

  it('never hands back a credential, including one nested in `extra`', () => {
    const telegram = getChannel(home(CONFIG), 'telegram');
    const byKey = Object.fromEntries((telegram?.fields ?? []).map((f) => [f.key, f]));
    expect(byKey.token?.value).toBe(STORED);
    expect(byKey['extra.webhook_secret']?.value).toBe(STORED);
    expect(byKey['extra.allowed_chat_id']?.value).toBe('9911');
  });

  it('does not call a platform configured when all it has is a switch', () => {
    // Saying it is configured is a lie the agent finds out at the worst moment.
    const dir = home('platforms:\n  discord:\n    enabled: true\n');
    expect(listChannels(dir)[0]?.configured).toBe(false);
  });

  it('says nothing when the file has no platforms at all', () => {
    expect(listChannels(home('mcp_servers: {}\n'))).toEqual([]);
    expect(listChannels(home())).toEqual([]);
  });

  it('refuses to touch a config it cannot parse', () => {
    expect(() => listChannels(home('platforms:\n  x: [oops\n'))).toThrow(ChannelError);
  });
});

describe('writing one back', () => {
  it('leaves the comment, the MCP block and the other platform alone', () => {
    const dir = home(CONFIG);
    putChannel(dir, 'telegram', { values: { require_mention: true } });
    const text = read(dir);
    expect(text).toContain('# hermes');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain('webhook:');
    expect(text).toContain('require_mention: true');
  });

  it('does not write the mask into the file', () => {
    const dir = home(CONFIG);
    const telegram = getChannel(dir, 'telegram');
    const values = Object.fromEntries((telegram?.fields ?? []).map((f) => [f.key, f.value]));
    putChannel(dir, 'telegram', { values });
    expect(read(dir)).toContain('token: 1234:secret-bot-token');
    expect(read(dir)).toContain('webhook_secret: hush');
    expect(read(dir)).not.toContain(STORED);
  });

  it('takes a credential the person did retype', () => {
    const dir = home(CONFIG);
    putChannel(dir, 'telegram', { values: { token: '9999:new-token' } });
    expect(read(dir)).toContain('token: 9999:new-token');
  });

  it('turns one off without forgetting how to sign in', () => {
    const dir = home(CONFIG);
    const channel = putChannel(dir, 'telegram', { enabled: false });
    expect(channel.enabled).toBe(false);
    expect(read(dir)).toContain('token: 1234:secret-bot-token');
  });

  it('adds a platform the file did not have', () => {
    const dir = home(CONFIG);
    putChannel(dir, 'discord', { enabled: true, values: { bot_token: 'abc' } });
    expect(listChannels(dir).map((c) => c.platform)).toContain('discord');
  });

  it('writes into `extra` where the key came from, and leaves its quoting alone', () => {
    // Replacing the whole node would re-quote every value in it for no reason anybody
    // asked for.
    const dir = home(CONFIG);
    putChannel(dir, 'telegram', { values: { 'extra.allowed_chat_id': '7722' } });
    const text = read(dir);
    expect(text).toContain("allowed_chat_id: '7722'");
    expect(text).toContain('require_mention: false');
  });
});

describe('clearing one', () => {
  it('forgets the identity and keeps the settings', () => {
    // The other things a person tuned are not what they asked to clear.
    const dir = home(CONFIG);
    const channel = clearChannel(dir, 'telegram');
    expect(channel.enabled).toBe(false);
    const text = read(dir);
    expect(text).not.toContain('1234:secret-bot-token');
    expect(text).not.toContain('hush');
    expect(text).toContain('require_mention: false');
    expect(text).toContain("allowed_chat_id: '9911'");
  });

  it('says so when there is no such platform', () => {
    expect(() => clearChannel(home(CONFIG), 'ghost')).toThrow(/not_found/);
  });
});
