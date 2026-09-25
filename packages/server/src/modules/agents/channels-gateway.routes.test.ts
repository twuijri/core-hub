/**
 * The owner's report of 2026-09-24, through the hub's own routes: WhatsApp paired in profile
 * «manger», Hermes restarted, the number messaged — «سويت رستارت وراسلته ولا رد».
 *
 * A hub that runs Hermes (a fake `hermes` on PATH, a fake spawner) with a scripted Hermes API
 * that does what Hermes's pairing does to the profile's files. Paired, the channel reads as
 * linked and on, and a gateway for «manger» starts at once; unlinking stops it and forgets the
 * phone; the Restart on Hermes's card restarts every gateway; and the senders waiting for
 * approval are listed, approved, turned down and revoked in the profile.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { HermesDashboardRefusal } from './hermes-dashboard.js';
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

let nextPid = 7000;
class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = nextPid++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

/** `hermes profile create` makes the folder (a copy of the root config for a clone). */
const FAKE_HERMES = `#!/bin/sh
if [ "$1" = profile ] && [ "$2" = create ]; then
  mkdir -p "$HERMES_HOME/profiles/$3"
  if [ -f "$HERMES_HOME/config.yaml" ]; then cp "$HERMES_HOME/config.yaml" "$HERMES_HOME/profiles/$3/config.yaml"; fi
fi
exit 0
`;

/** What Hermes's pairing API does to a profile's files, and its pairing store, in memory. */
function scriptedHermes(root: () => string) {
  const profileHome = (profile: string) =>
    profile === 'default' ? root() : path.join(root(), 'profiles', profile);
  const pending: Record<string, Array<Record<string, unknown>>> = {};
  const approved: Record<string, Array<Record<string, unknown>>> = {};
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const api: HermesApiCall = async <T>(method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    const answer = (value: unknown) => value as T;
    const url = new URL(route, 'http://hermes');
    if (route.endsWith('/whatsapp/onboarding/start')) {
      // Hermes's bridge writes the session into the profile the pairing was started in.
      const profile = (body as { profile: string }).profile;
      const session = path.join(profileHome(profile), 'platforms', 'whatsapp', 'session');
      mkdirSync(session, { recursive: true });
      writeFileSync(
        path.join(session, 'creds.json'),
        JSON.stringify({ me: { id: '966500000000:3@s.whatsapp.net', name: 'مكتب المدير' } }),
      );
      return answer({
        pairing_id: 'p1',
        status: 'connected',
        account_name: 'مكتب المدير',
        account_phone: '966500000000',
      });
    }
    if (method === 'PUT' && url.pathname === '/api/messaging/platforms/whatsapp') {
      // What Hermes writes without restarting anything: the values it was given into `.env`,
      // over what was there, and the switch in the file.
      const home = profileHome(url.searchParams.get('profile') ?? 'default');
      const file = path.join(home, '.env');
      const values = new Map(
        (existsSync(file) ? readFileSync(file, 'utf8') : '')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      for (const [key, value] of Object.entries((body as { env: Record<string, string> }).env)) {
        values.set(key, value);
      }
      writeFileSync(file, [...values].map(([key, value]) => `${key}=${value}\n`).join(''));
      writeFileSync(path.join(home, 'config.yaml'), 'platforms:\n  whatsapp:\n    enabled: true\n');
      return answer({ ok: true });
    }
    if (method === 'GET' && url.pathname === '/api/pairing') {
      const profile = url.searchParams.get('profile') ?? '';
      return answer({ pending: pending[profile] ?? [], approved: approved[profile] ?? [] });
    }
    if (url.pathname === '/api/pairing/approve') {
      const { profile, request_id: id } = body as { profile: string; request_id: string };
      const row = (pending[profile] ?? []).find((entry) => entry.request_id === id);
      if (!row) throw new HermesDashboardRefusal('POST /api/pairing/approve', 404, 'not found');
      pending[profile] = (pending[profile] ?? []).filter((entry) => entry !== row);
      (approved[profile] ??= []).push({ ...row, approved_at: 1_790_000_000 });
      return answer({ ok: true, user: { user_id: row.user_id, user_name: row.user_name } });
    }
    if (url.pathname === '/api/pairing/revoke') {
      const { profile, user_id: user } = body as { profile: string; user_id: string };
      const before = (approved[profile] ?? []).length;
      approved[profile] = (approved[profile] ?? []).filter((entry) => entry.user_id !== user);
      if (approved[profile].length === before) {
        throw new HermesDashboardRefusal('POST /api/pairing/revoke', 404, 'not found');
      }
      return answer({ ok: true });
    }
    return answer({ ok: true });
  };
  return { api, calls, pending, approved };
}

async function boot(options: { api?: boolean } = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), 'corehub-gw-bin-'));
  bins.push(bin);
  writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES);
  chmodSync(path.join(bin, 'hermes'), 0o755);
  const spawned: Array<{ args: string[]; cwd: string; child: FakeChild }> = [];
  const spawnImpl: Spawner = (_command, args, spawnOptions) => {
    const child = new FakeChild();
    spawned.push({ args, cwd: spawnOptions.cwd, child });
    return child;
  };
  let root = '';
  const hermes = scriptedHermes(() => root);
  hub = await signedInHub(
    {},
    {
      agents: {
        pathValue: bin,
        runtime: { spawnImpl, healthIntervalMs: 0, gatewayBackoffMs: [5], channelSettleMs: 5 },
        ...(options.api === false ? {} : { hermesApi: hermes.api }),
        pairingPollMs: 5,
      },
    },
  );
  root = path.join(hub.dataDir, 'hermes');
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const of = (profile: string) =>
    spawned.filter((entry) =>
      profile === 'default' ? !entry.args.includes('-p') : entry.args.includes(profile),
    );
  return { hub, agent, root, spawned, of, hermes };
}

/** A workspace, and the Hermes profile it is (made here the way `hermes profile create` would). */
async function makeProfile(h: Hub, slug: string) {
  const res = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/profiles',
    payload: { slug, name: slug },
  });
  expect(res.statusCode, res.body).toBe(201);
  mkdirSync(path.join(h.dataDir, 'hermes', 'profiles', slug), { recursive: true });
}

interface ChannelsAnswer {
  items: Array<{
    platform: string;
    enabled: boolean;
    configured: boolean;
    status: string;
    restart_needed: boolean;
    link: { linked: boolean; account_phone: string | null; account_name: string | null } | null;
  }>;
  gateway: { profile: string; state: string; applies: string } | null;
}

const channels = async (h: Hub, agent: string, profile: string) =>
  (
    await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/channels`, profile })
  ).json() as ChannelsAnswer;

describe('WhatsApp paired in a named profile', () => {
  it('reads as linked and on, and a gateway for that profile starts at once', async () => {
    const { hub: h, agent, of } = await boot();
    await makeProfile(h, 'manger');
    expect((await channels(h, agent, 'manger')).gateway).toEqual({
      profile: 'manger',
      state: 'stopped',
      applies: 'now',
      error: null,
    });
    expect(of('manger')).toHaveLength(0);

    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
      profile: 'manger',
    });
    expect(started.statusCode, started.body).toBe(202);
    await drainJobs(h.app);
    const job = await authed(h, h.token, {
      url: `/api/v1/jobs/${(started.json() as { job_id: string }).job_id}`,
      profile: 'manger',
    });
    expect(job.json()).toMatchObject({
      status: 'succeeded',
      result: { status: 'connected', applies: 'now' },
    });

    // The gateway that answers the number: `hermes -p manger gateway run`.
    await vi.waitFor(() => expect(of('manger')).toHaveLength(1));
    expect(of('manger')[0]?.args).toEqual(['-p', 'manger', 'gateway', 'run']);

    const after = await channels(h, agent, 'manger');
    expect(after.items).toEqual([
      expect.objectContaining({
        platform: 'whatsapp',
        enabled: true,
        configured: true,
        link: expect.objectContaining({
          linked: true,
          account_phone: '966500000000',
          account_name: 'مكتب المدير',
        }),
      }),
    ]);
    expect(after.gateway).toMatchObject({ profile: 'manger', state: 'starting', applies: 'now' });

    // Hermes's card lists both gateways.
    const card = await authed(h, h.token, { url: `/api/v1/agents/${agent}` });
    expect(
      (
        card.json() as { runtime: { gateways: Array<{ profile: string; channels: string[] }> } }
      ).runtime.gateways.map((g) => [g.profile, g.channels]),
    ).toEqual([
      ['default', []],
      ['manger', ['whatsapp']],
    ]);
  });

  it('in the default profile, restarts its gateway so the number is answered without a Restart', async () => {
    // The owner's report of 2026-09-26: linked in the default profile, «مربوط» but «غير متصل» —
    // the default gateway had started before the link and never read it.
    const { hub: h, agent, of } = await boot();
    expect(of('default')).toHaveLength(1);
    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
    });
    await drainJobs(h.app);
    const job = await authed(h, h.token, {
      url: `/api/v1/jobs/${(started.json() as { job_id: string }).job_id}`,
    });
    expect(job.json()).toMatchObject({ result: { applies: 'now', mode: 'bot' } });
    await vi.waitFor(() => expect(of('default')).toHaveLength(2));
    expect(of('default')[0]?.child.killed).toEqual(['SIGTERM']);
    expect(of('default')[1]?.args).toEqual(['gateway', 'run']);
  });
});

describe("WhatsApp's mode: a number for the agent, or the person's own", () => {
  it('links a personal number in self-chat mode, with the owner allowed to talk to the agent', async () => {
    const { hub: h, agent, root, hermes } = await boot();
    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
      payload: { mode: 'self-chat' },
    });
    expect(started.statusCode, started.body).toBe(202);
    await drainJobs(h.app);
    expect(hermes.calls[0]).toMatchObject({ body: { mode: 'self-chat', profile: 'default' } });
    const env = readFileSync(path.join(root, '.env'), 'utf8');
    expect(env).toContain('WHATSAPP_MODE=self-chat\n');
    expect(env).toContain('WHATSAPP_ALLOWED_USERS=966500000000\n');
    const list = await channels(h, agent, 'default');
    expect(list.items[0]).toMatchObject({
      platform: 'whatsapp',
      link: { linked: true, mode: 'self-chat' },
    });

    const wrong = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
      payload: { mode: 'personal' },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it('changes the mode of a linked number and restarts the gateway that serves it', async () => {
    const { hub: h, agent, root, of } = await boot();
    await makeProfile(h, 'manger');
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
    });
    await drainJobs(h.app);
    await vi.waitFor(() => expect(of('default')).toHaveLength(2));

    const changed = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/channels/whatsapp/mode`,
      payload: { mode: 'self-chat' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      platform: 'whatsapp',
      enabled: true,
      link: { linked: true, mode: 'self-chat', account_phone: '966500000000' },
    });
    const env = readFileSync(path.join(root, '.env'), 'utf8');
    expect(env).toContain('WHATSAPP_MODE=self-chat\n');
    expect(env).toContain('WHATSAPP_ALLOWED_USERS=966500000000\n');
    // Held down while `.env` changed, then started again: Hermes reads the mode at start.
    await vi.waitFor(() => expect(of('default')).toHaveLength(3));
    expect(of('default')[1]?.child.killed).toEqual(['SIGTERM']);

    const back = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/channels/whatsapp/mode`,
      payload: { mode: 'bot' },
    });
    expect(back.json()).toMatchObject({ link: { mode: 'bot' } });

    const telegram = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/channels/telegram/mode`,
      payload: { mode: 'bot' },
    });
    expect(telegram.statusCode).toBe(409);
    expect(telegram.json()).toMatchObject({ details: { reason: 'mode_not_supported' } });
    const nothing = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/channels/whatsapp/mode`,
      profile: 'manger',
      payload: { mode: 'self-chat' },
    });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ details: { reason: 'not_linked' } });
  });
});

describe('a channel the running gateway does not serve', () => {
  it('says a restart is needed until Hermes names it, then how it is', async () => {
    const { hub: h, agent, root, of } = await boot();
    // Linked behind the hub's back (by hand, or by a hub before this fix): the default gateway
    // is running and was started without it.
    writeFileSync(path.join(root, '.env'), 'WHATSAPP_ENABLED=true\nWHATSAPP_MODE=bot\n');
    const session = path.join(root, 'platforms', 'whatsapp', 'session');
    mkdirSync(session, { recursive: true });
    writeFileSync(
      path.join(session, 'creds.json'),
      JSON.stringify({ me: { id: '966500000000:3@s.whatsapp.net' } }),
    );
    const record = (platforms: Record<string, unknown>) =>
      writeFileSync(
        path.join(root, 'gateway_state.json'),
        JSON.stringify({ pid: of('default')[0]!.child.pid, gateway_state: 'running', platforms }),
      );
    const whatsapp = async () =>
      (await channels(h, agent, 'default')).items.find((item) => item.platform === 'whatsapp');

    record({});
    expect(await whatsapp()).toMatchObject({ status: 'offline', restart_needed: true });
    record({ whatsapp: { state: 'connecting' } });
    expect(await whatsapp()).toMatchObject({ status: 'unknown', restart_needed: false });
    record({ whatsapp: { state: 'connected' } });
    expect(await whatsapp()).toMatchObject({ status: 'online', restart_needed: false });
  });
});

describe('unlinking WhatsApp', () => {
  it('stops that profile gateway, forgets the phone, and shows Pair by QR again', async () => {
    const { hub: h, agent, root, of } = await boot();
    await makeProfile(h, 'manger');
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
      profile: 'manger',
    });
    await drainJobs(h.app);
    await vi.waitFor(() => expect(of('manger')).toHaveLength(1));

    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/unlink`,
      profile: 'manger',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      platform: 'whatsapp',
      enabled: false,
      configured: false,
      login: 'qr',
      link: { linked: false },
    });
    expect(of('manger')[0]?.child.killed).toEqual(['SIGTERM']);
    // Nothing left to serve: not started again.
    expect(of('manger')).toHaveLength(1);
    expect(
      existsSync(path.join(root, 'profiles', 'manger', 'platforms', 'whatsapp', 'session')),
    ).toBe(false);
    expect(readFileSync(path.join(root, 'profiles', 'manger', '.env'), 'utf8')).not.toContain(
      'WHATSAPP_ENABLED',
    );

    const again = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/unlink`,
      profile: 'manger',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ details: { reason: 'not_linked' } });
    const other = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/webhook/unlink`,
      profile: 'manger',
    });
    expect(other.json()).toMatchObject({ details: { reason: 'unlink_not_supported' } });
  });
});

describe('any channel change in a named profile', () => {
  it('starts, restarts and stops its gateway; the Restart restarts every gateway', async () => {
    const { hub: h, agent, of } = await boot();
    await makeProfile(h, 'sales');
    const put = (payload: Record<string, unknown>) =>
      authed(h, h.token, {
        method: 'PUT',
        url: `/api/v1/agents/${agent}/channels/telegram`,
        profile: 'sales',
        payload,
      });
    expect((await put({ enabled: true, credentials: { token: '1234:abc' } })).statusCode).toBe(200);
    await vi.waitFor(() => expect(of('sales')).toHaveLength(1));

    const restart = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/restart`,
    });
    expect(restart.statusCode).toBe(202);
    await drainJobs(h.app);
    await vi.waitFor(() => {
      expect(of('default')).toHaveLength(2);
      expect(of('sales')).toHaveLength(2);
    });

    await put({ enabled: false });
    await vi.waitFor(() => expect(of('sales')[1]?.child.killed).toEqual(['SIGTERM']));
    expect(of('sales')).toHaveLength(2);
  });
});

describe('senders waiting for approval', () => {
  it('are listed, approved, turned down and revoked in the selected profile', async () => {
    const { hub: h, agent, root, hermes } = await boot();
    await makeProfile(h, 'manger');
    hermes.pending.manger = [
      {
        platform: 'whatsapp',
        request_id: 'aaaaaaaaaaaaaaaa',
        user_id: '966500000001@s.whatsapp.net',
        user_name: 'سارة',
        age_minutes: 3,
      },
    ];
    const list = await authed(h, h.token, {
      url: `/api/v1/agents/${agent}/pairing`,
      profile: 'manger',
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({
      pending: [{ platform: 'whatsapp', request_id: 'aaaaaaaaaaaaaaaa', user_name: 'سارة' }],
      approved: [],
    });
    expect(hermes.calls.at(-1)?.route).toBe('/api/pairing?profile=manger');

    const approve = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pairing/whatsapp/requests/aaaaaaaaaaaaaaaa/approve`,
      profile: 'manger',
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toMatchObject({ user_id: '966500000001@s.whatsapp.net' });
    const gone = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pairing/whatsapp/requests/aaaaaaaaaaaaaaaa/approve`,
      profile: 'manger',
    });
    expect(gone.statusCode).toBe(404);

    // Deny: the hub's edit of Hermes's pending file in that profile.
    const folder = path.join(root, 'profiles', 'manger', 'platforms', 'pairing');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, 'whatsapp-pending.json'),
      JSON.stringify({ bbbbbbbbbbbbbbbb: { hash: 'h', salt: 's', user_id: '2', created_at: 1 } }),
    );
    const deny = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/pairing/whatsapp/requests/bbbbbbbbbbbbbbbb`,
      profile: 'manger',
    });
    expect(deny.statusCode, deny.body).toBe(204);
    expect(readFileSync(path.join(folder, 'whatsapp-pending.json'), 'utf8')).not.toContain('bbbb');

    const revoke = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/pairing/whatsapp/approved/${encodeURIComponent('966500000001@s.whatsapp.net')}`,
      profile: 'manger',
    });
    expect(revoke.statusCode, revoke.body).toBe(204);
    expect(hermes.calls.at(-1)?.body).toMatchObject({
      user_id: '966500000001@s.whatsapp.net',
      profile: 'manger',
    });
  });

  it('says so when the hub cannot reach Hermes to ask', async () => {
    const { hub: h, agent } = await boot({ api: false });
    const res = await authed(h, h.token, { url: `/api/v1/agents/${agent}/pairing` });
    // No `hermes serve` can start from a shell script; the reason is named, not an empty list.
    expect([409, 503]).toContain(res.statusCode);
  });
});
