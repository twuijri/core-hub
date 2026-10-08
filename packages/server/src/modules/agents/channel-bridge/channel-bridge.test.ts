/**
 * The hub's plugin in Hermes's messaging gateway (contract decision §153): the files the hub
 * writes into a Hermes home and how they switch the plugin on without touching the rest of the
 * person's `config.yaml`; the bridge's outbox, acknowledgements and turn reports, per key and per
 * gateway topology; and the posts on the channel — Telegram's Bot API and WhatsApp's bridge.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { HubError } from '../../../lib/errors.js';
import type { GatewayTopology } from '../hermes-gateways.js';
import { ChannelBridge, type BridgeEvent } from './bridge.js';
import { postMirror, whatsappJid } from './mirror.js';
import {
  BRIDGE_PLUGIN_ID,
  bridgeDir,
  bridgeKeyOf,
  pluginSource,
  writeBridgePlugin,
} from './plugin.js';
import { telegramParts } from './telegram.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'corehub-bridge-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const config = () => readFileSync(path.join(home, 'config.yaml'), 'utf8');

describe('the plugin in a Hermes home', () => {
  it('writes the plugin, a key of its own, and switches it on with injection allowed', () => {
    const first = writeBridgePlugin(home, {
      url: 'http://127.0.0.1:8080/api/v1/hub-mcp/channel-bridge',
      profile: 'default',
    });
    expect(first.codeChanged).toBe(true);
    expect(first.key).toMatch(/^hub_bridge_[0-9a-f]{48}$/);
    const hub = JSON.parse(readFileSync(path.join(bridgeDir(home), 'hub.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(hub).toEqual({
      url: 'http://127.0.0.1:8080/api/v1/hub-mcp/channel-bridge',
      key: first.key,
      profile: 'default',
    });
    expect(readFileSync(path.join(bridgeDir(home), 'plugin.yaml'), 'utf8')).toContain(
      `name: ${BRIDGE_PLUGIN_ID}`,
    );
    expect(parse(config())).toEqual({
      plugins: {
        enabled: [BRIDGE_PLUGIN_ID],
        entries: { [BRIDGE_PLUGIN_ID]: { allow_gateway_injection: true } },
      },
    });
    // Again: the same key, nothing rewritten; an address not known yet keeps the old one.
    const again = writeBridgePlugin(home, { url: null, profile: 'default' });
    expect(again).toEqual({ key: first.key, codeChanged: false, configChanged: false });
    expect(bridgeKeyOf(home)).toBe(first.key);
  });

  it('keeps the person’s config, their plugins and their comments', () => {
    writeFileSync(
      path.join(home, 'config.yaml'),
      [
        '# my settings',
        'model:',
        '  default: gpt-x # the good one',
        'plugins:',
        '  enabled:',
        '    - langfuse',
        '  disabled:',
        '    - corehub-bridge',
        '    - spotify',
        '  entries:',
        '    langfuse:',
        '      settings:',
        '        host: https://example.test',
        '',
      ].join('\n'),
    );
    writeBridgePlugin(home, { url: null, profile: 'work' });
    const text = config();
    expect(text).toContain('# my settings');
    expect(text).toContain('# the good one');
    expect(parse(text)).toEqual({
      model: { default: 'gpt-x' },
      plugins: {
        enabled: ['langfuse', BRIDGE_PLUGIN_ID],
        disabled: ['spotify'],
        entries: {
          langfuse: { settings: { host: 'https://example.test' } },
          [BRIDGE_PLUGIN_ID]: { allow_gateway_injection: true },
        },
      },
    });
  });

  it('never rewrites a config.yaml it cannot read', () => {
    writeFileSync(path.join(home, 'config.yaml'), 'model: [unclosed\n');
    const written = writeBridgePlugin(home, { url: null, profile: 'default' });
    expect(written.configChanged).toBe(false);
    expect(config()).toBe('model: [unclosed\n');
  });

  it('is Python Hermes can load (standard library only)', () => {
    let python = 'python3';
    try {
      execFileSync(python, ['--version'], { stdio: 'ignore' });
    } catch {
      python = '';
    }
    const source = pluginSource();
    expect(source).toContain('ctx.inject_message(');
    expect(source).toContain('ctx.register_hook("pre_llm_call"');
    expect(source).toContain('ctx.register_hook("on_session_end"');
    expect(source).toContain('os.environ.get("COREHUB_MCP_ORIGIN") != "gateway"');
    if (!python) return;
    const file = path.join(home, 'plugin.py');
    writeFileSync(file, source);
    execFileSync(python, ['-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', file]);
  });
});

describe('the bridge', () => {
  let topology: GatewayTopology;
  let now: number;
  let heard: Array<[string, string, unknown]>;
  let bridge: ChannelBridge;
  let keys: Record<string, string>;

  beforeEach(() => {
    topology = 'per-profile';
    now = 1_000_000;
    heard = [];
    mkdirSync(path.join(home, 'profiles', 'work'), { recursive: true });
    bridge = new ChannelBridge({
      managedRoot: () => home,
      namedProfiles: () => ['work'],
      topology: () => topology,
      mcpUrl: () => 'http://127.0.0.1:9/api/v1/hub-mcp',
      listener: () => ({
        acknowledged: (profile, id, accepted, reason) =>
          heard.push([profile, 'ack', { id, accepted, reason }]),
        turn: (profile, event) => heard.push([profile, 'turn', event]),
      }),
      log: { info: () => undefined, warn: () => undefined },
      now: () => now,
    });
    bridge.syncAll();
    keys = {
      default: bridgeKeyOf(home)!,
      work: bridgeKeyOf(path.join(home, 'profiles', 'work'))!,
    };
  });

  const item = (id: string) => ({
    id,
    session_key: `agent:main:telegram:dm:${id}`,
    text: `words ${id}`,
  });
  const code = (run: () => unknown) => {
    try {
      run();
      return 'ok';
    } catch (error) {
      return (error as HubError).code;
    }
  };

  it('knows only the keys it wrote', async () => {
    expect(keys.default).not.toBe(keys.work);
    await expect(bridge.outbox(null, 0)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(bridge.outbox('hub_bridge_unknown', 0)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(bridge.outbox('hub_mcp_other', 0)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(
      code(() =>
        bridge.event('nope', { event: 'turn_started', platform: 'telegram', session_id: 's' }),
      ),
    ).toBe('unauthorized');
    expect(JSON.parse(readFileSync(path.join(bridgeDir(home), 'hub.json'), 'utf8'))).toMatchObject({
      url: 'http://127.0.0.1:9/api/v1/hub-mcp/channel-bridge',
    });
  });

  it('hands each gateway its own profile’s items, or every profile’s from the root gateway', async () => {
    bridge.enqueue('default', item('a'));
    bridge.enqueue('work', item('b'));
    expect((await bridge.outbox(keys.default, 0)).items.map((i) => i.id)).toEqual(['a']);
    expect((await bridge.outbox(keys.work, 0)).items.map((i) => i.id)).toEqual(['b']);
    topology = 'one-per-host';
    bridge.enqueue('work', item('c'));
    expect((await bridge.outbox(keys.default, 0)).items.map((i) => i.id)).toEqual(['c']);
  });

  it('answers a waiting poll as soon as an item arrives, and says who is listening', async () => {
    expect(bridge.connected('default')).toBe(false);
    const waiting = bridge.outbox(keys.default, 5);
    expect(bridge.connected('default')).toBe(true);
    expect(bridge.connected('work')).toBe(false);
    bridge.enqueue('default', item('a'));
    expect((await waiting).items.map((i) => i.id)).toEqual(['a']);
    now += 60_000;
    expect(bridge.connected('default')).toBe(false);
    // A poll whose plugin went away gets nothing; the item waits for the next one.
    const gone = bridge.outbox(keys.default, 5, () => false);
    bridge.enqueue('default', item('b'));
    expect((await gone).items).toEqual([]);
    expect((await bridge.outbox(keys.default, 0)).items.map((i) => i.id)).toEqual(['b']);
    bridge.enqueue('default', item('c'));
    bridge.withdraw('c');
    expect((await bridge.outbox(keys.default, 0)).items).toEqual([]);
  });

  it('answers the polls it holds when the hub closes, and holds no new one', async () => {
    const started = Date.now();
    const waiting = bridge.outbox(keys.default, 25);
    bridge.close();
    expect((await waiting).items).toEqual([]);
    expect((await bridge.outbox(keys.default, 25)).items).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('passes acknowledgements and turns on, once, to whoever handed the item out', async () => {
    bridge.enqueue('work', item('a'));
    await bridge.outbox(keys.work, 0);
    expect(code(() => bridge.ack(keys.default, 'a', { accepted: true }))).toBe('not_found');
    bridge.ack(keys.work, 'a', { accepted: false, reason: 'refused' });
    expect(code(() => bridge.ack(keys.work, 'a', { accepted: true }))).toBe('not_found');
    const event: BridgeEvent = {
      event: 'turn_ended',
      platform: 'telegram',
      session_id: 's1',
      outcome: 'completed',
    };
    bridge.event(keys.work, event);
    expect(heard).toEqual([
      ['work', 'ack', { id: 'a', accepted: false, reason: 'refused' }],
      ['work', 'turn', event],
    ]);
  });
});

describe('posting on the channel', () => {
  const fetchOf = (answer: (url: string, body: Record<string, unknown>) => Response) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return answer(String(input), body);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends Telegram the words in parts it takes, in the topic, and its refusal without the token', async () => {
    const ok = fetchOf(() => json({ ok: true, result: { message_id: 1 } }));
    const deps = {
      fetchImpl: ok.fetchImpl,
      telegramApi: 'https://tg.test/',
      telegramToken: () => '42:SECRET',
      whatsappPort: () => 3000,
    };
    const long = `${'a'.repeat(4000)}\n${'b'.repeat(200)}`;
    expect(
      await postMirror({ platform: 'telegram', chatId: '-100', threadId: '77' }, long, deps),
    ).toEqual({ ok: true });
    expect(
      ok.calls.map((c) => [
        c.url,
        c.body.chat_id,
        c.body.message_thread_id,
        String(c.body.text).length,
      ]),
    ).toEqual([
      ['https://tg.test/bot42:SECRET/sendMessage', '-100', 77, 4000],
      ['https://tg.test/bot42:SECRET/sendMessage', '-100', 77, 200],
    ]);
    const refused = fetchOf(() =>
      json({ ok: false, error_code: 403, description: 'Forbidden: 42:SECRET blocked' }, 403),
    );
    expect(
      await postMirror({ platform: 'telegram', chatId: '5', threadId: null }, 'x', {
        ...deps,
        fetchImpl: refused.fetchImpl,
      }),
    ).toEqual({
      ok: false,
      message: 'Forbidden: … blocked',
    });
    expect(
      await postMirror({ platform: 'telegram', chatId: '5', threadId: null }, 'x', {
        ...deps,
        telegramToken: () => null,
      }),
    ).toEqual({
      ok: false,
      message: 'this profile has no Telegram bot',
    });
    expect(telegramParts('short')).toEqual(['short']);
  });

  it('sends WhatsApp through the profile’s bridge, and says why not', async () => {
    const bridge = fetchOf((url) =>
      url.includes(':3005/')
        ? json({ success: true, messageId: 'm1' })
        : json({ error: 'Not connected to WhatsApp' }, 503),
    );
    const deps = {
      fetchImpl: bridge.fetchImpl,
      telegramApi: '',
      telegramToken: () => null,
      whatsappPort: () => 3005,
    };
    expect(
      await postMirror(
        { platform: 'whatsapp', chatId: '+966 50 000 0000', threadId: null },
        'hi',
        deps,
      ),
    ).toEqual({ ok: true });
    expect(bridge.calls[0]).toEqual({
      url: 'http://127.0.0.1:3005/send',
      body: { chatId: '966500000000@s.whatsapp.net', message: 'hi' },
    });
    expect(
      await postMirror({ platform: 'whatsapp', chatId: 'x@g.us', threadId: null }, 'hi', {
        ...deps,
        whatsappPort: () => 3000,
      }),
    ).toEqual({
      ok: false,
      message: 'Not connected to WhatsApp',
    });
    const down = fetchOf(() => {
      throw new TypeError('fetch failed');
    });
    expect(
      (
        await postMirror(
          { platform: 'whatsapp', chatId: '1@s.whatsapp.net', threadId: null },
          'hi',
          { ...deps, fetchImpl: down.fetchImpl },
        )
      ).ok,
    ).toBe(false);
    expect(whatsappJid('12345:7@s.whatsapp.net')).toBe('12345@s.whatsapp.net');
    expect(whatsappJid('120363@g.us')).toBe('120363@g.us');
    expect(
      await postMirror({ platform: 'discord', chatId: '1', threadId: null }, 'hi', deps),
    ).toEqual({
      ok: false,
      message: 'discord is not supported',
    });
  });
});
