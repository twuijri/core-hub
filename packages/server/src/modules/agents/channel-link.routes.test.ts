/**
 * More messaging platforms linked like Telegram (the owner: «link more messaging platforms from
 * the Channels page, like Telegram»), through the hub's own routes.
 *
 * A hub that runs Hermes (a fake `hermes` on PATH, a fake spawner) and scripted platform APIs:
 * Discord's `/users/@me`, Slack's `auth.test` and `apps.connections.open`, Matrix's `whoami`,
 * Mattermost's `/users/me`. A good credential is asked about, stored in the profile's own `.env`
 * and never returned; the channel reads as linked with the account the platform named; a named
 * profile's gateway starts at once. A refused one is refused in the platform's words and nothing
 * is written; a generic platform is stored unchecked; Unlink forgets it; settings land where
 * Hermes reads them.
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

let nextPid = 9400;
class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = nextPid++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

const DISCORD = 'fake-discord-token-for-tests-only-0000000000000000000000000000001';
const DISCORD_OTHER = 'fake-discord-token-for-tests-only-0000000000000000000000000000002';
const SLACK_BOT = 'xoxb-fake-test-token-0001';
const SLACK_APP = 'xapp-fake-test-token-0001';
const MATRIX_TOKEN = 'fake_matrix_token_for_tests';
const MM_TOKEN = 'k9d8s7a6f5g4h3j2k1l0qwerty';

/** The platforms' APIs as linking asks them. Everything else is refused as the platform would. */
function scriptedPlatforms(mode: { down?: boolean } = {}) {
  const asked: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    asked.push({ url, auth });
    if (mode.down) throw new TypeError('fetch failed');
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === 'https://discord.com/api/v10/users/@me') {
      if (auth === `Bot ${DISCORD}`) {
        return json(200, { id: '1234567890123456789', username: 'office_helper', bot: true });
      }
      if (auth === `Bot ${DISCORD_OTHER}`) {
        return json(200, { id: '1999999999999999999', username: 'other_bot', bot: true });
      }
      return json(401, { message: '401: Unauthorized', code: 0 });
    }
    if (url === 'https://slack.com/api/auth.test') {
      return auth === `Bearer ${SLACK_BOT}`
        ? json(200, { ok: true, team: 'المكتب', user: 'corehub', user_id: 'U0BOT', bot_id: 'B1' })
        : json(200, { ok: false, error: 'invalid_auth' });
    }
    if (url === 'https://slack.com/api/apps.connections.open') {
      return auth === `Bearer ${SLACK_APP}`
        ? json(200, { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=x' })
        : json(200, { ok: false, error: 'not_allowed_token_type' });
    }
    if (url === 'https://matrix.example.org/_matrix/client/v3/account/whoami') {
      return auth === `Bearer ${MATRIX_TOKEN}`
        ? json(200, { user_id: '@corehub:example.org', device_id: 'HUB' })
        : json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.' });
    }
    if (url === 'https://mm.example.org/api/v4/users/me') {
      return auth === `Bearer ${MM_TOKEN}`
        ? json(200, { id: 'u1', username: 'corehub-bot', nickname: 'مساعد' })
        : json(401, { id: 'api.context.session_expired.app_error', message: 'Invalid token.' });
    }
    return json(404, { message: 'no such route' });
  };
  return { fetchImpl, asked };
}

const FAKE_HERMES = `#!/bin/sh
if [ "$1" = profile ] && [ "$2" = create ]; then mkdir -p "$HERMES_HOME/profiles/$3"; fi
exit 0
`;

async function boot(options: { down?: boolean } = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), 'corehub-links-bin-'));
  bins.push(bin);
  writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES);
  chmodSync(path.join(bin, 'hermes'), 0o755);
  const spawned: Array<{ args: string[]; child: FakeChild }> = [];
  const spawnImpl: Spawner = (_command, args) => {
    const child = new FakeChild();
    spawned.push({ args, child });
    return child;
  };
  const platforms = scriptedPlatforms({ down: options.down ?? false });
  const api: HermesApiCall = async <T>() => ({ pending: [], approved: [] }) as T;
  hub = await signedInHub(
    {},
    {
      agents: {
        pathValue: bin,
        runtime: { spawnImpl, healthIntervalMs: 0, gatewayBackoffMs: [5] },
        hermesApi: api,
        channelProbe: { fetchImpl: platforms.fetchImpl },
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
  return { hub, agent, root, of, platforms };
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

const link = (
  h: Hub,
  agent: string,
  profile: string,
  platform: string,
  payload: Record<string, unknown>,
) =>
  authed(h, h.token, {
    method: 'POST',
    url: `/api/v1/agents/${agent}/channels/${platform}/link`,
    profile,
    payload,
  });

const channels = async (h: Hub, agent: string, profile: string) =>
  (
    await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/channels`, profile })
  ).json() as { items: Array<Record<string, unknown>> };

const envOf = (dir: string) =>
  existsSync(path.join(dir, '.env')) ? readFileSync(path.join(dir, '.env'), 'utf8') : '';

describe('The platforms the hub links', () => {
  it('lists every platform with what it takes, the full ones first', async () => {
    const { hub: h, agent } = await boot();
    const res = await authed(h, h.token, { url: `/api/v1/agents/${agent}/channel-platforms` });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: Array<Record<string, unknown>> }).items;
    const names = items.map((item) => item.platform);
    for (const platform of [
      'telegram',
      'whatsapp',
      'discord',
      'slack',
      'matrix',
      'mattermost',
      'email',
    ]) {
      expect(items.find((item) => item.platform === platform)).toMatchObject({ support: 'full' });
    }
    for (const platform of [
      'signal',
      'sms',
      'feishu',
      'dingtalk',
      'wecom',
      'weixin',
      'qqbot',
      'line',
      'google_chat',
      'teams',
      'homeassistant',
      'ntfy',
      'irc',
      'bluebubbles',
      'whatsapp_cloud',
      'simplex',
      'photon',
      'wecom_callback',
      'yuanbao',
      'raft',
      'buzz',
    ]) {
      expect(items.find((item) => item.platform === platform)).toMatchObject({
        support: 'generic',
        validates: false,
        settings: false,
      });
    }
    const firstGeneric = items.findIndex((item) => item.support === 'generic');
    expect(items.slice(firstGeneric).every((item) => item.support === 'generic')).toBe(true);
    expect(names).toHaveLength(new Set(names).size);
    expect(items.find((item) => item.platform === 'slack')).toMatchObject({
      login: 'credentials',
      credentials: [
        { key: 'SLACK_BOT_TOKEN', kind: 'secret', required: true },
        { key: 'SLACK_APP_TOKEN', kind: 'secret', required: true },
      ],
      allowed_users_key: 'SLACK_ALLOWED_USERS',
      validates: true,
      pairs: true,
      settings: true,
      packages: 'image',
    });
    expect(items.find((item) => item.platform === 'discord')).toMatchObject({
      pairs: false,
      allowlist: true,
    });
    expect(items.find((item) => item.platform === 'matrix')).toMatchObject({
      packages: 'first_use',
      program: null,
    });
    // Observed in Hermes v2026.9.14: WeCom's callback app takes a webhook and a library on first
    // start; Photon's bridge is installed on first start; Raft and Buzz run a program of their own.
    expect(items.find((item) => item.platform === 'wecom_callback')).toMatchObject({
      inbound: true,
      packages: 'first_use',
      allowed_users_key: 'WECOM_CALLBACK_ALLOWED_USERS',
    });
    expect(items.find((item) => item.platform === 'photon')).toMatchObject({
      label: 'iMessage via Photon',
      packages: 'first_use',
      inbound: false,
      credentials: [
        { key: 'PHOTON_PROJECT_ID', kind: 'text', required: true },
        { key: 'PHOTON_PROJECT_SECRET', kind: 'secret', required: true },
      ],
    });
    expect(items.find((item) => item.platform === 'yuanbao')).toMatchObject({
      allowed_users_key: 'YUANBAO_DM_ALLOW_FROM',
      exclusive: true,
    });
    expect(items.find((item) => item.platform === 'raft')).toMatchObject({ program: 'raft' });
    expect(items.find((item) => item.platform === 'buzz')).toMatchObject({
      program: 'buzz',
      exclusive: true,
    });
    expect(items.filter((item) => item.program !== null).map((item) => item.platform)).toEqual([
      'raft',
      'buzz',
    ]);
  });
});

describe('Link Discord', () => {
  it('asks Discord, stores the token in the profile’s own .env, and starts its gateway', async () => {
    const { hub: h, agent, root, of, platforms } = await boot();
    await makeProfile(h, 'manger');
    const res = await link(h, agent, 'manger', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: ` ${DISCORD} ` },
      allowed_users: ['111222333444555666'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(DISCORD);
    expect(res.json()).toMatchObject({
      platform: 'discord',
      enabled: true,
      configured: true,
      exclusive: true,
      login: 'credentials',
      link: {
        linked: true,
        account_id: '1234567890123456789',
        account_name: 'office_helper',
        account_username: 'office_helper',
      },
    });
    expect(platforms.asked).toEqual([
      { url: 'https://discord.com/api/v10/users/@me', auth: `Bot ${DISCORD}` },
    ]);
    const home = path.join(root, 'profiles', 'manger');
    const env = envOf(home);
    expect(env).toContain(`DISCORD_BOT_TOKEN=${DISCORD}\n`);
    expect(env).toContain('DISCORD_ALLOWED_USERS=111222333444555666\n');
    expect(statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600);
    const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toMatch(/discord:\n\s+enabled: true/);
    // Discord drops strangers itself: the hub does not pretend they get a code.
    expect(config).not.toContain('unauthorized_dm_behavior');
    expect(config).not.toContain(DISCORD);
    expect(envOf(root)).not.toContain('DISCORD');

    await vi.waitFor(() => expect(of('manger')).toHaveLength(1));
    const listed = await channels(h, agent, 'manger');
    expect(listed.items).toEqual([
      expect.objectContaining({
        platform: 'discord',
        link: expect.objectContaining({ linked: true, account_username: 'office_helper' }),
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(DISCORD);
  });

  it('refuses a token Discord does not know, in Discord’s words, and writes nothing', async () => {
    const { hub: h, agent, root } = await boot();
    const bad = 'fake-discord-token-for-tests-only-0000000000000000000000000000bad';
    const res = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: bad },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      details: {
        reason: 'credentials_rejected',
        field: 'DISCORD_BOT_TOKEN',
        message: '401: Unauthorized',
      },
    });
    expect(res.body).not.toContain(bad);
    expect(envOf(root)).not.toContain('DISCORD');
  });

  it('refuses a missing or malformed token without asking Discord', async () => {
    const { hub: h, agent, platforms } = await boot();
    const missing = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: '  ' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      details: { reason: 'credentials_invalid', field: 'credentials.DISCORD_BOT_TOKEN' },
    });
    const short = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: 'short' },
    });
    expect(short.json()).toMatchObject({ details: { reason: 'credentials_invalid' } });
    const unknown = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: DISCORD, OTHER_THING: 'x' },
    });
    expect(unknown.json()).toMatchObject({
      details: { reason: 'credentials_invalid', field: 'credentials.OTHER_THING' },
    });
    expect(platforms.asked).toEqual([]);
  });

  it('says so when Discord does not answer', async () => {
    const { hub: h, agent } = await boot({ down: true });
    const res = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: DISCORD },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      details: { reason: 'platform_unreachable', platform: 'discord' },
    });
  });

  it('names the profile a bot is already linked in, and replaces it in the same one', async () => {
    const { hub: h, agent } = await boot();
    await makeProfile(h, 'manger');
    const first = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: DISCORD },
    });
    expect(first.statusCode, first.body).toBe(200);
    const res = await link(h, agent, 'manger', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: DISCORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'token_in_use', profile: 'default' } });
    const again = await link(h, agent, 'default', 'discord', {
      credentials: { DISCORD_BOT_TOKEN: DISCORD_OTHER },
    });
    expect(again.json()).toMatchObject({ link: { account_username: 'other_bot' } });
  });

  it('does not name a bot after a token somebody replaced by hand', async () => {
    const { hub: h, agent, root } = await boot();
    expect(
      (await link(h, agent, 'default', 'discord', { credentials: { DISCORD_BOT_TOKEN: DISCORD } }))
        .statusCode,
    ).toBe(200);
    writeFileSync(path.join(root, '.env'), `DISCORD_BOT_TOKEN=${DISCORD_OTHER}\n`);
    const listed = await channels(h, agent, 'default');
    expect(listed.items.find((item) => item.platform === 'discord')).toMatchObject({
      link: { linked: true, account_name: null, account_username: null },
    });
  });
});

describe('Link Slack, Matrix and Mattermost', () => {
  it('Slack: both tokens asked about, pairing switched on for strangers', async () => {
    const { hub: h, agent, root, platforms } = await boot();
    const bad = await link(h, agent, 'default', 'slack', {
      credentials: { SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: 'xapp-fake-test-token-wrong' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      details: {
        reason: 'credentials_rejected',
        field: 'SLACK_APP_TOKEN',
        message: 'not_allowed_token_type',
      },
    });
    expect(envOf(root)).not.toContain('SLACK');

    const res = await link(h, agent, 'default', 'slack', {
      credentials: { SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP },
      allowed_users: ['U01ABCDEF'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      link: { linked: true, account_name: 'المكتب', account_username: 'corehub' },
    });
    expect(platforms.asked.map((entry) => entry.url)).toContain(
      'https://slack.com/api/apps.connections.open',
    );
    const env = envOf(root);
    expect(env).toContain(`SLACK_BOT_TOKEN=${SLACK_BOT}\n`);
    expect(env).toContain(`SLACK_APP_TOKEN=${SLACK_APP}\n`);
    expect(env).toContain('SLACK_ALLOWED_USERS=U01ABCDEF\n');
    const config = readFileSync(path.join(root, 'config.yaml'), 'utf8');
    expect(config).toMatch(/slack:\n\s+enabled: true\n\s+unauthorized_dm_behavior: pair/);
  });

  it('Matrix: the homeserver’s whoami names the account', async () => {
    const { hub: h, agent, root } = await boot();
    const bad = await link(h, agent, 'default', 'matrix', {
      credentials: {
        MATRIX_HOMESERVER: 'https://matrix.example.org/',
        MATRIX_ACCESS_TOKEN: 'fake_matrix_wrong_token',
      },
    });
    expect(bad.json()).toMatchObject({
      details: { reason: 'credentials_rejected', message: 'Invalid access token passed.' },
    });
    const res = await link(h, agent, 'default', 'matrix', {
      credentials: {
        MATRIX_HOMESERVER: 'https://matrix.example.org/',
        MATRIX_ACCESS_TOKEN: MATRIX_TOKEN,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      link: {
        linked: true,
        account_id: '@corehub:example.org',
        account_username: 'corehub:example.org',
      },
    });
    expect(envOf(root)).toContain('MATRIX_HOMESERVER=https://matrix.example.org/\n');
  });

  it('Mattermost: /users/me names the bot; a server that is not one is said to be', async () => {
    const { hub: h, agent } = await boot();
    const wrongServer = await link(h, agent, 'default', 'mattermost', {
      credentials: { MATTERMOST_URL: 'https://not-mm.example.org', MATTERMOST_TOKEN: MM_TOKEN },
    });
    expect(wrongServer.json()).toMatchObject({
      details: { reason: 'credentials_rejected', field: 'MATTERMOST_URL' },
    });
    const res = await link(h, agent, 'default', 'mattermost', {
      credentials: { MATTERMOST_URL: 'https://mm.example.org', MATTERMOST_TOKEN: MM_TOKEN },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      link: { account_name: 'مساعد', account_username: 'corehub-bot' },
    });
  });
});

describe('A generic platform', () => {
  it('is stored as given, unchecked, and switched on', async () => {
    const { hub: h, agent, root, platforms } = await boot();
    const missing = await link(h, agent, 'default', 'signal', {
      credentials: { SIGNAL_HTTP_URL: 'http://signal:8080' },
    });
    expect(missing.json()).toMatchObject({
      details: { reason: 'credentials_invalid', field: 'credentials.SIGNAL_ACCOUNT' },
    });
    const res = await link(h, agent, 'default', 'signal', {
      credentials: { SIGNAL_HTTP_URL: 'http://signal:8080', SIGNAL_ACCOUNT: '+966500000000' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      platform: 'signal',
      enabled: true,
      login: 'credentials',
      link: { linked: true, account_name: null },
    });
    expect(platforms.asked).toEqual([]);
    expect(envOf(root)).toContain('SIGNAL_ACCOUNT=+966500000000\n');
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).not.toContain(
      'unauthorized_dm_behavior',
    );
  });

  it('quotes a value with a space or a # the way Hermes writes it', async () => {
    const { hub: h, agent, root } = await boot();
    const res = await link(h, agent, 'default', 'irc', {
      credentials: {
        IRC_SERVER: 'irc.libera.chat',
        IRC_CHANNEL: '#hub',
        IRC_NICKNAME: 'corehub',
        IRC_NICKSERV_PASSWORD: 'pass word"#1',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const env = envOf(root);
    expect(env).toContain('IRC_CHANNEL="#hub"\n');
    expect(env).toContain('IRC_NICKSERV_PASSWORD="pass word\\"#1"\n');
  });

  it('links the platforms the picker added (Buzz), with the people Hermes reads', async () => {
    const { hub: h, agent, root, platforms } = await boot();
    const res = await link(h, agent, 'default', 'buzz', {
      credentials: {
        BUZZ_RELAY_URL: 'https://community.example.test',
        BUZZ_PRIVATE_KEY: 'nsec1fakekeyfortestsonly',
      },
      allowed_users: ['npub1alice', 'npub1bob'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ platform: 'buzz', link: { linked: true } });
    expect(platforms.asked).toEqual([]);
    const env = envOf(root);
    expect(env).toContain('BUZZ_RELAY_URL=https://community.example.test\n');
    expect(env).toContain('BUZZ_ALLOWED_USERS=npub1alice,npub1bob\n');
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).toMatch(/buzz:\n\s+enabled: true/);
  });
});

describe('Unlink a platform linked by credentials', () => {
  it('removes the credentials, keeps the allowlist, and stops the profile’s gateway', async () => {
    const { hub: h, agent, root, of } = await boot();
    await makeProfile(h, 'manger');
    expect(
      (
        await link(h, agent, 'manger', 'discord', {
          credentials: { DISCORD_BOT_TOKEN: DISCORD },
          allowed_users: ['42'],
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(() => expect(of('manger')).toHaveLength(1));
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/discord/unlink`,
      profile: 'manger',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      platform: 'discord',
      enabled: false,
      configured: false,
      link: { linked: false, account_username: null },
    });
    const home = path.join(root, 'profiles', 'manger');
    expect(envOf(home)).not.toContain('DISCORD_BOT_TOKEN');
    expect(envOf(home)).toContain('DISCORD_ALLOWED_USERS=42');
    expect(existsSync(path.join(home, 'platforms', 'discord', 'hub-account.json'))).toBe(false);
    const again = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/discord/unlink`,
      profile: 'manger',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ details: { reason: 'not_linked' } });
  });
});

describe('Settings of the new platforms', () => {
  const settingsUrl = (agent: string, platform: string) =>
    `/api/v1/agents/${agent}/channels/${platform}/settings`;

  it('Discord: mentions, threads, channels and the home channel, where Hermes reads them', async () => {
    const { hub: h, agent, root } = await boot();
    expect(
      (await link(h, agent, 'default', 'discord', { credentials: { DISCORD_BOT_TOKEN: DISCORD } }))
        .statusCode,
    ).toBe(200);
    // Somebody set the variable by hand: the file wins for Discord, and the two are kept in step.
    writeFileSync(
      path.join(root, '.env'),
      `${readFileSync(path.join(root, '.env'), 'utf8')}DISCORD_REQUIRE_MENTION=true\n`,
    );
    const read = await authed(h, h.token, { url: settingsUrl(agent, 'discord') });
    expect(read.statusCode, read.body).toBe(200);
    const options = (read.json() as { options: Array<Record<string, unknown>> }).options;
    expect(options.map((option) => option.key)).toEqual(
      expect.arrayContaining([
        'allowed_users',
        'require_mention',
        'auto_thread',
        'allowed_channels',
        'free_response_channels',
        'home_channel',
        'show_reasoning',
      ]),
    );
    expect(options.find((option) => option.key === 'require_mention')).toMatchObject({
      value: true,
      default: true,
      source: 'env',
    });
    expect(options.find((option) => option.key === 'tool_progress')).toMatchObject({
      default: 'all',
    });

    const saved = await authed(h, h.token, {
      method: 'PATCH',
      url: settingsUrl(agent, 'discord'),
      payload: {
        values: {
          require_mention: false,
          auto_thread: false,
          allowed_channels: ['1111', '2222'],
          home_channel: '3333',
          reply_to_mode: 'off',
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const config = readFileSync(path.join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('require_mention: false');
    expect(config).toContain('auto_thread: false');
    expect(config).toMatch(/allowed_channels:\n\s+- '1111'\n\s+- '2222'/);
    expect(config).toMatch(
      /home_channel:\n\s+platform: discord\n\s+name: Home\n\s+chat_id: '3333'/,
    );
    // A bare `off` is YAML 1.1's false: it is quoted.
    expect(config).toContain("reply_to_mode: 'off'");
    expect(envOf(root)).toContain('DISCORD_REQUIRE_MENTION=false\n');
    const after = (saved.json() as { options: Array<Record<string, unknown>> }).options;
    expect(after.find((option) => option.key === 'require_mention')).toMatchObject({
      value: false,
      source: 'config',
    });
  });

  it('Matrix, Mattermost and Email have their own', async () => {
    const { hub: h, agent, root } = await boot();
    const matrix = await authed(h, h.token, {
      method: 'PATCH',
      url: settingsUrl(agent, 'matrix'),
      payload: { values: { e2ee_mode: 'optional', free_response_rooms: ['!room:example.org'] } },
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const mattermost = await authed(h, h.token, {
      method: 'PATCH',
      url: settingsUrl(agent, 'mattermost'),
      payload: { values: { reply_mode: 'thread' } },
    });
    expect(mattermost.statusCode, mattermost.body).toBe(200);
    const email = await authed(h, h.token, {
      method: 'PATCH',
      url: settingsUrl(agent, 'email'),
      payload: { values: { allowed_users: ['sara@example.org'], poll_interval: 60 } },
    });
    expect(email.statusCode, email.body).toBe(200);
    const config = readFileSync(path.join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('e2ee_mode: optional');
    expect(config).toContain("- '!room:example.org'");
    expect(config).toContain('reply_mode: thread');
    const env = envOf(root);
    expect(env).toContain('EMAIL_ALLOWED_USERS=sara@example.org\n');
    expect(env).toContain('EMAIL_POLL_INTERVAL=60\n');
    const wrong = await authed(h, h.token, {
      method: 'PATCH',
      url: settingsUrl(agent, 'email'),
      payload: { values: { allowed_users: ['not an address'] } },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ details: { field: 'values.allowed_users' } });
    const generic = await authed(h, h.token, { url: settingsUrl(agent, 'signal') });
    expect(generic.json()).toMatchObject({ details: { reason: 'settings_not_supported' } });
  });
});
