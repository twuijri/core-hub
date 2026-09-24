/**
 * Linking Telegram by a bot token, through the hub's own routes (the owner, 2026-09-24: «ابي
 * تربط التليجرام … لانه ما سويت الا واتساب وانا احتاج تليجرام»).
 *
 * A hub that runs Hermes (a fake `hermes` on PATH, a fake spawner) and a scripted Telegram
 * `getMe`. A good token is asked about, stored in the profile's own `.env` and never returned;
 * the channel reads as linked with the bot's @username; a named profile's gateway starts at once.
 * A malformed token never reaches Telegram, a refused one is refused in Telegram's words, a bot
 * linked in another profile is said to be there, and Unlink forgets it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import type { SpawnedProcess, Spawner } from './hermes-runtime.js';
import type { HermesApiCall } from './hermes-tools.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
const bins: string[] = [];
afterEach(async () => {
  await hub?.close();
  hub = null;
  for (const dir of bins.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let nextPid = 9100;
class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = nextPid++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

const GOOD = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const OTHER = '7099999999:AAFfffffffffffffffffffffffffffffffffff';

/** Telegram's Bot API as `getMe` answers: one bot for `GOOD`, another for `OTHER`, 401 else. */
function scriptedTelegram(mode: { down?: boolean } = {}) {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (mode.down) throw new TypeError('fetch failed');
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === `https://api.telegram.org/bot${GOOD}/getMe`) {
      return json(200, {
        ok: true,
        result: {
          id: 7012345678,
          is_bot: true,
          first_name: 'مساعد المكتب',
          username: 'office_helper_bot',
        },
      });
    }
    if (url === `https://api.telegram.org/bot${OTHER}/getMe`) {
      return json(200, {
        ok: true,
        result: { id: 7099999999, is_bot: true, first_name: 'Other', username: 'other_bot' },
      });
    }
    return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
  };
  return { fetchImpl, asked };
}

const FAKE_HERMES = `#!/bin/sh
if [ "$1" = profile ] && [ "$2" = create ]; then mkdir -p "$HERMES_HOME/profiles/$3"; fi
exit 0
`;

async function boot(options: { api?: boolean; down?: boolean; external?: boolean } = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), 'majlis-tg-bin-'));
  bins.push(bin);
  if (!options.external) {
    writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES);
    chmodSync(path.join(bin, 'hermes'), 0o755);
  }
  // A gateway somebody else runs: it answers its health check, and the hub runs no Hermes.
  const healthy: typeof fetch = async () =>
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const spawned: Array<{ args: string[]; child: FakeChild }> = [];
  const spawnImpl: Spawner = (_command, args) => {
    const child = new FakeChild();
    spawned.push({ args, child });
    return child;
  };
  const telegram = scriptedTelegram({ down: options.down ?? false });
  // Hermes's pairing API, played for Telegram: one stranger waiting in «manger».
  const pending = [
    {
      platform: 'telegram',
      request_id: 'a1b2c3d4e5f60718',
      user_id: '555666777',
      user_name: 'Sara',
      age_minutes: 1,
    },
  ];
  const approved: Array<Record<string, unknown>> = [];
  const api: HermesApiCall = async <T>(method: string, route: string, body?: unknown) => {
    const url = new URL(route, 'http://hermes');
    if (method === 'GET' && url.pathname === '/api/pairing') {
      return { pending, approved } as T;
    }
    if (url.pathname === '/api/pairing/approve') {
      const { request_id: id, platform } = body as { request_id: string; platform: string };
      const index = pending.findIndex((row) => row.request_id === id && row.platform === platform);
      const [row] = pending.splice(index, 1);
      approved.push({ ...row, approved_at: 1_790_000_000 });
      return { ok: true, user: { user_id: row!.user_id, user_name: row!.user_name } } as T;
    }
    return { ok: true } as T;
  };
  hub = await signedInHub(
    {},
    {
      agents: {
        pathValue: bin,
        runtime: { spawnImpl, healthIntervalMs: 0, gatewayBackoffMs: [5] },
        ...(options.api === false ? {} : { hermesApi: api }),
        ...(options.external ? { adapterOptions: { hermes: { fetchImpl: healthy } } } : {}),
        telegramFetch: telegram.fetchImpl,
      },
    },
  );
  const root = path.join(hub.dataDir, 'hermes');
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const of = (profile: string) =>
    spawned.filter((entry) =>
      profile === 'default' ? !entry.args.includes('-p') : entry.args.includes(profile),
    );
  return { hub, agent, root, of, telegram };
}

async function makeProfile(h: Hub, slug: string) {
  const res = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/profiles',
    payload: { slug, name: slug },
  });
  expect(res.statusCode, res.body).toBe(201);
  mkdirSync(path.join(h.dataDir, 'hermes', 'profiles', slug), { recursive: true });
}

const link = (h: Hub, agent: string, profile: string, payload: Record<string, unknown>) =>
  authed(h, h.token, {
    method: 'POST',
    url: `/api/v1/agents/${agent}/channels/telegram/link`,
    profile,
    payload,
  });

const channels = async (h: Hub, agent: string, profile: string) =>
  (
    await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/channels`, profile })
  ).json() as {
    items: Array<Record<string, unknown>>;
    gateway: { applies: string; state: string } | null;
  };

describe('Link Telegram by a bot token', () => {
  it('asks Telegram, stores the token in the profile’s own .env, and starts its gateway', async () => {
    const { hub: h, agent, root, of, telegram } = await boot();
    await makeProfile(h, 'manger');
    const res = await link(h, agent, 'manger', {
      token: `  ${GOOD} `,
      allowed_users: ['111222333'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(GOOD);
    expect(res.json()).toMatchObject({
      platform: 'telegram',
      enabled: true,
      configured: true,
      login: 'token',
      link: {
        linked: true,
        account_id: '7012345678',
        account_name: 'مساعد المكتب',
        account_phone: null,
        account_username: 'office_helper_bot',
      },
    });
    expect(telegram.asked).toEqual([`https://api.telegram.org/bot${GOOD}/getMe`]);

    const home = path.join(root, 'profiles', 'manger');
    const env = readFileSync(path.join(home, '.env'), 'utf8');
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${GOOD}\n`);
    expect(env).toContain('TELEGRAM_ALLOWED_USERS=111222333\n');
    expect(statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600);
    const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('enabled: true');
    expect(config).toContain('unauthorized_dm_behavior: pair');
    expect(config).not.toContain(GOOD);
    // The default profile is untouched.
    expect(
      existsSync(path.join(root, '.env')) ? readFileSync(path.join(root, '.env'), 'utf8') : '',
    ).not.toContain('TELEGRAM');

    await vi.waitFor(() => expect(of('manger')).toHaveLength(1));
    const listed = await channels(h, agent, 'manger');
    expect(listed.gateway).toMatchObject({ applies: 'now' });
    expect(listed.items).toEqual([
      expect.objectContaining({
        platform: 'telegram',
        configured: true,
        link: expect.objectContaining({ account_username: 'office_helper_bot' }),
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(GOOD);
  });

  it('refuses a malformed token without asking Telegram', async () => {
    const { hub: h, agent, root, telegram } = await boot();
    const res = await link(h, agent, 'default', { token: 'not-a-token' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ details: { reason: 'token_invalid' } });
    expect(telegram.asked).toEqual([]);
    expect(
      existsSync(path.join(root, '.env')) ? readFileSync(path.join(root, '.env'), 'utf8') : '',
    ).not.toContain('TELEGRAM');
  });

  it('refuses a token Telegram does not know, in Telegram’s words, and writes nothing', async () => {
    const { hub: h, agent, root, telegram } = await boot();
    const bad = '7000000000:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const res = await link(h, agent, 'default', { token: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      details: { reason: 'token_rejected', message: 'Unauthorized' },
    });
    expect(res.body).not.toContain(bad);
    expect(telegram.asked).toHaveLength(1);
    expect(
      existsSync(path.join(root, '.env')) ? readFileSync(path.join(root, '.env'), 'utf8') : '',
    ).not.toContain('TELEGRAM');
  });

  it('says so when Telegram does not answer', async () => {
    const { hub: h, agent } = await boot({ down: true });
    const res = await link(h, agent, 'default', { token: GOOD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ details: { reason: 'telegram_unreachable' } });
  });

  it('in the default profile, waits for Hermes’s Restart', async () => {
    const { hub: h, agent, root } = await boot();
    const res = await link(h, agent, 'default', { token: GOOD });
    expect(res.statusCode, res.body).toBe(200);
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(`TELEGRAM_BOT_TOKEN=${GOOD}`);
    expect((await channels(h, agent, 'default')).gateway).toMatchObject({ applies: 'on_restart' });
  });

  it('names the profile a bot is already linked in', async () => {
    const { hub: h, agent } = await boot();
    await makeProfile(h, 'manger');
    expect((await link(h, agent, 'default', { token: GOOD })).statusCode).toBe(200);
    const res = await link(h, agent, 'manger', { token: GOOD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'token_in_use', profile: 'default' } });
    // Linking again in the same profile replaces the token.
    const again = await link(h, agent, 'default', { token: OTHER });
    expect(again.json()).toMatchObject({ link: { account_username: 'other_bot' } });
  });

  it('is Telegram’s and needs a Hermes the hub runs', async () => {
    const withApi = await boot();
    const slack = await authed(withApi.hub, withApi.hub.token, {
      method: 'POST',
      url: `/api/v1/agents/${withApi.agent}/channels/slack/link`,
      payload: { token: GOOD },
    });
    expect(slack.statusCode).toBe(409);
    expect(slack.json()).toMatchObject({ details: { reason: 'link_not_supported' } });
    await hub?.close();
    hub = null;

    const { hub: h, agent, telegram } = await boot({ api: false, external: true });
    const res = await link(h, agent, 'default', { token: GOOD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'hermes_not_supervised' } });
    expect(telegram.asked).toEqual([]);
  });

  it('lists a Telegram stranger waiting for approval, and approves them', async () => {
    const { hub: h, agent } = await boot();
    await makeProfile(h, 'manger');
    const list = await authed(h, h.token, {
      url: `/api/v1/agents/${agent}/pairing`,
      profile: 'manger',
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({
      pending: [{ platform: 'telegram', request_id: 'a1b2c3d4e5f60718', user_id: '555666777' }],
    });
    const approve = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pairing/telegram/requests/a1b2c3d4e5f60718/approve`,
      profile: 'manger',
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toMatchObject({ platform: 'telegram', user_id: '555666777' });
  });
});

describe('Unlink Telegram', () => {
  it('removes the token, switches the channel off and stops the profile’s gateway', async () => {
    const { hub: h, agent, root, of } = await boot();
    await makeProfile(h, 'manger');
    expect((await link(h, agent, 'manger', { token: GOOD, allowed_users: ['1'] })).statusCode).toBe(
      200,
    );
    await vi.waitFor(() => expect(of('manger')).toHaveLength(1));

    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/telegram/unlink`,
      profile: 'manger',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      platform: 'telegram',
      enabled: false,
      configured: false,
      link: { linked: false, account_username: null },
    });
    const home = path.join(root, 'profiles', 'manger');
    const env = readFileSync(path.join(home, '.env'), 'utf8');
    expect(env).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(env).toContain('TELEGRAM_ALLOWED_USERS=1'); // what the person set stays
    expect(existsSync(path.join(home, 'platforms', 'telegram', 'hub-bot.json'))).toBe(false);
    await vi.waitFor(async () =>
      expect((await channels(h, agent, 'manger')).gateway).toMatchObject({ state: 'stopped' }),
    );

    const again = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/telegram/unlink`,
      profile: 'manger',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ details: { reason: 'not_linked' } });
  });
});
