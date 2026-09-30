/**
 * The subscription sign-ins through the gateway (DECISIONS §143) with the real CLIProxyAPI (the
 * pinned 8.0.4) and its management API — every call the hub makes of it, through the hub's own
 * API, as a person would:
 *
 * - xAI's short-code sign-in, run by CLIProxyAPI's management API against a stand-in of xAI's
 *   discovery, device and token addresses; the account it saves is marked as the provider row's
 *   (prefix, note), its models reach the hub's catalogue, and the account's token never does;
 * - "check now" through CLIProxyAPI's `api-call`, which puts the account's token in the vendor
 *   call itself; renew (a refresh against the stand-in); turn off and on; sign out;
 * - ChatGPT's short code, which CLIProxyAPI offers only as `-codex-device-login`: run as a child
 *   process, its code read from what it prints, the account landing in the running process's store;
 * - Claude's link sign-in: CLIProxyAPI's own authorisation link (its callback address and state),
 *   and a pasted-back address from another sign-in refused by CLIProxyAPI. The code exchange itself
 *   is not driven: CLIProxyAPI makes it with its own TLS client for Anthropic, which takes no proxy.
 *
 * The vendors are never reached: CLIProxyAPI has no setting for their sign-in addresses, so it runs
 * behind a proxy that answers their hosts itself (`testing/vendor-mitm.ts`); its `api-call` takes
 * no proxy from the environment, so the account under test is given the stand-in as its own.
 *
 * Skipped unless `COREHUB_REAL_GATEWAY=1` (it needs `pnpm cliproxy:fetch` and `openssl`); CI's
 * `model-gateway-real` job runs it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../../lib/db.js';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { modelGatewayFor } from '../index.js';
import { upstreamPrefix } from './cliproxy-config.js';
import { devCliproxyPath } from './locate.js';
import { unsignedJwt, vendorMitm, type VendorMitm } from './testing/vendor-mitm.js';

const enabled = process.env.COREHUB_REAL_GATEWAY === '1';
const binary = process.env.COREHUB_CLIPROXY_BIN
  ? path.resolve(process.env.COREHUB_CLIPROXY_BIN)
  : devCliproxyPath();

const XAI_ACCESS = 'xai-access-token-never-in-the-hub';
const CODEX_ACCESS = 'codex-access-token-never-in-the-hub';

interface SignIn {
  id: string;
  status: string;
  user_code: string | null;
  verification_url: string;
  accepts_code: boolean;
  error: string | null;
}

describe.skipIf(!enabled)('subscription sign-ins with the real CLIProxyAPI', () => {
  let mitm: VendorMitm;
  let hub: TestHub & { token: string };
  const saved: Record<string, string | undefined> = {};
  let refreshes = 0;

  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    authed(hub, hub.token, { method, url, ...(payload === undefined ? {} : { payload }) });

  const add = async (preset: string): Promise<string> => {
    const response = await api('POST', '/api/v1/models/providers', {
      preset,
      label: '',
      kind: 'llm',
      scope: 'all',
    });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as { id: string }).id;
  };

  const settle = async (provider: string, signIn: SignIn, ms = 60_000): Promise<SignIn> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const response = await api(
        'GET',
        `/api/v1/models/providers/${provider}/sign-in/${signIn.id}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const now = response.json() as SignIn;
      if (now.status !== 'pending') return now;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('the sign-in never ended');
  };

  beforeAll(async () => {
    mitm = await vendorMitm((request) => {
      const form = new URLSearchParams(request.body);
      if (request.host === 'auth.x.ai') {
        if (request.path.startsWith('/.well-known/openid-configuration')) {
          return {
            status: 200,
            body: {
              issuer: 'https://auth.x.ai',
              device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
              token_endpoint: 'https://auth.x.ai/oauth2/token',
            },
          };
        }
        if (request.path === '/oauth2/device/code') {
          return {
            status: 200,
            body: {
              device_code: 'xai-device-1',
              user_code: 'XAIC-0DE1',
              verification_uri: 'https://accounts.x.ai/device',
              verification_uri_complete: 'https://accounts.x.ai/device?user_code=XAIC-0DE1',
              expires_in: 600,
              interval: 1,
            },
          };
        }
        if (request.path === '/oauth2/token') {
          if (form.get('grant_type') === 'refresh_token') refreshes += 1;
          return {
            status: 200,
            body: {
              access_token: XAI_ACCESS,
              refresh_token: `xai-refresh-${refreshes}`,
              id_token: unsignedJwt({ email: 'grok@example.com', sub: 'xai-sub-1' }),
              token_type: 'Bearer',
              expires_in: 3600,
            },
          };
        }
      }
      if (request.host === 'cli-chat-proxy.grok.com' && request.path.startsWith('/v1/billing')) {
        return {
          status: 200,
          body: {
            config: {
              creditUsagePercent: 42,
              currentPeriod: {
                type: 'WEEKLY',
                end: new Date(Date.now() + 3 * 86400_000).toISOString(),
              },
            },
          },
        };
      }
      if (request.host === 'auth.openai.com') {
        if (request.path === '/api/accounts/deviceauth/usercode') {
          return {
            status: 200,
            body: { device_auth_id: 'codex-device-1', user_code: 'CODX-12345', interval: '1' },
          };
        }
        if (request.path === '/api/accounts/deviceauth/token') {
          return {
            status: 200,
            body: {
              authorization_code: 'codex-code',
              code_verifier: 'v'.repeat(43),
              code_challenge: 'c'.repeat(43),
            },
          };
        }
        if (request.path === '/oauth/token') {
          return {
            status: 200,
            body: {
              access_token: CODEX_ACCESS,
              refresh_token: 'codex-refresh-1',
              id_token: unsignedJwt({
                email: 'chatgpt@example.com',
                'https://api.openai.com/auth': {
                  chatgpt_account_id: 'acct-real-test',
                  chatgpt_plan_type: 'plus',
                },
              }),
              token_type: 'Bearer',
              expires_in: 864000,
            },
          };
        }
      }
      if (request.host === 'platform.claude.com' && request.path.startsWith('/v1/oauth/token')) {
        return {
          status: 400,
          body: { error: 'invalid_grant', error_description: 'the code is not valid' },
        };
      }
      return null;
    });
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'SSL_CERT_FILE', 'NO_PROXY', 'no_proxy']) {
      saved[name] = process.env[name];
    }
    process.env.HTTPS_PROXY = mitm.proxyUrl;
    process.env.https_proxy = mitm.proxyUrl;
    process.env.SSL_CERT_FILE = mitm.caFile;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    hub = await signedInHub(
      { COREHUB_MODEL_GATEWAY: 'on' },
      { models: { fetchImpl: globalThis.fetch, cliproxyBin: binary } },
    );
  }, 120_000);

  afterAll(async () => {
    await hub?.close();
    await mitm?.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const authDir = () => path.join(hub.dataDir, 'gateway', 'cliproxy-auth');

  it('signs in to xAI by a short code, and the account serves the row', async () => {
    const vendors = await api('GET', '/api/v1/models/subscription-vendors');
    expect((vendors.json() as { available: boolean }).available).toBe(true);
    const provider = await add('xai-subscription');
    const started = await api('POST', `/api/v1/models/providers/${provider}/sign-in`);
    expect(started.statusCode, started.body).toBe(201);
    const signIn = started.json() as SignIn;
    expect(signIn).toMatchObject({ user_code: 'XAIC-0DE1', accepts_code: false });
    expect(signIn.verification_url).toBe('https://accounts.x.ai/device?user_code=XAIC-0DE1');
    expect((await settle(provider, signIn)).status).toBe('approved');
    await drainJobs(hub.app);

    const file = readdirSync(authDir()).find((name) => name.startsWith('xai'))!;
    const account = JSON.parse(readFileSync(path.join(authDir(), file), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(account).toMatchObject({
      prefix: upstreamPrefix(provider),
      note: `corehub:${provider.toLowerCase()}`,
      email: 'grok@example.com',
    });

    const list = await api('GET', '/api/v1/models/providers');
    const row = (
      list.json() as {
        items: {
          id: string;
          auth: { signed_in: boolean };
          subscription?: { accounts: number };
          models: { model: string }[];
        }[];
      }
    ).items.find((item) => item.id === provider)!;
    expect(row.auth.signed_in).toBe(true);
    expect(row.subscription?.accounts).toBe(1);
    // CLIProxyAPI's own catalogue for xAI, under the row's prefix, reached the hub's.
    expect(row.models.length).toBeGreaterThan(0);

    // The dialog: CLIProxyAPI's account, its counts, and "check now" through its api-call.
    const dialog = await api('GET', `/api/v1/models/providers/${provider}/accounts`);
    expect(dialog.statusCode, dialog.body).toBe(200);
    const accounts = (
      dialog.json() as {
        accounts: { id: string; email: string; status: string; requests: { recent: unknown[] } }[];
      }
    ).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: file, email: 'grok@example.com', status: 'active' });
    expect(accounts[0]!.requests.recent).toHaveLength(20);
    const id = encodeURIComponent(file);
    // CLIProxyAPI's `api-call` takes no proxy from the environment (a direct transport), only the
    // account's own `proxy_url`: the test gives this account the stand-in's, so "check now" does
    // not reach the real vendor. (A person's account has none; the call goes straight out.)
    const lease = await modelGatewayFor(hub.app).subscriptions().open();
    try {
      await lease.client.setFields(file, { proxy_url: mitm.proxyUrl });
    } finally {
      lease.done();
    }
    const checked = await api('POST', `/api/v1/models/providers/${provider}/accounts/${id}/check`);
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toMatchObject({
      check_error: null,
      windows: [{ id: 'weekly', used_percent: 42, source: 'checked' }],
    });
    const billing = mitm.seen.find((seen) => seen.host === 'cli-chat-proxy.grok.com');
    // CLIProxyAPI put the account's token in the vendor call…
    expect(billing?.authorization).toBe(`Bearer ${XAI_ACCESS}`);
    // …and it never came into the hub: not in its database, not in an answer.
    const db = requireSqlite(hub.app.hub.database);
    for (const table of ['secrets', 'providers', 'audit_events', 'jobs']) {
      const rows = JSON.stringify(db.$client.prepare(`select * from ${table}`).all());
      expect(rows).not.toContain(XAI_ACCESS);
    }
    expect(dialog.body + checked.body + list.body).not.toContain(XAI_ACCESS);

    const renewed = await api(
      'POST',
      `/api/v1/models/providers/${provider}/accounts/${id}/refresh`,
    );
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(refreshes).toBeGreaterThan(0);

    const off = await api('PATCH', `/api/v1/models/providers/${provider}/accounts/${id}`, {
      disabled: true,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ disabled: true, status: 'disabled' });
    const on = await api('PATCH', `/api/v1/models/providers/${provider}/accounts/${id}`, {
      disabled: false,
    });
    expect((on.json() as { disabled: boolean }).disabled).toBe(false);

    const gone = await api('DELETE', `/api/v1/models/providers/${provider}/accounts/${id}`);
    expect(gone.statusCode, gone.body).toBe(204);
    expect(existsSync(path.join(authDir(), file))).toBe(false);
  }, 180_000);

  it('signs in to ChatGPT by the code CLIProxyAPI prints as a child process', async () => {
    const provider = await add('chatgpt-subscription');
    const started = await api('POST', `/api/v1/models/providers/${provider}/sign-in`);
    expect(started.statusCode, started.body).toBe(201);
    const signIn = started.json() as SignIn;
    expect(signIn).toMatchObject({
      user_code: 'CODX-12345',
      verification_url: 'https://auth.openai.com/codex/device',
    });
    const done = await settle(provider, signIn, 90_000);
    expect(done.status, done.error ?? '').toBe('approved');
    const file = readdirSync(authDir()).find((name) => name.startsWith('codex'))!;
    const account = JSON.parse(readFileSync(path.join(authDir(), file), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(account).toMatchObject({
      prefix: upstreamPrefix(provider),
      email: 'chatgpt@example.com',
    });
    const dialog = await api('GET', `/api/v1/models/providers/${provider}/accounts`);
    const first = (dialog.json() as { accounts: { plan: string | null }[] }).accounts[0];
    expect(first?.plan).toBe('plus');
    expect(dialog.body).not.toContain(CODEX_ACCESS);
  }, 180_000);

  it('signs in to Claude by a link whose landing address is pasted back', async () => {
    const provider = await add('claude-subscription');
    const started = await api('POST', `/api/v1/models/providers/${provider}/sign-in`);
    expect(started.statusCode, started.body).toBe(201);
    const signIn = started.json() as SignIn;
    expect(signIn.accepts_code).toBe(true);
    const link = new URL(signIn.verification_url);
    expect(link.origin).toBe('https://claude.ai');
    const state = link.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(link.searchParams.get('redirect_uri')).toBe('http://localhost:54545/callback');
    // An address from another sign-in (its state is not this one's) is refused by CLIProxyAPI, in
    // its words, and the sign-in waits on. The code exchange itself is not driven here: CLIProxyAPI
    // makes it with its own TLS client for Anthropic, which takes no proxy, so it would reach the
    // real vendor.
    const wrong = await api('POST', `/api/v1/models/providers/${provider}/sign-in/${signIn.id}`, {
      code: 'http://localhost:54545/callback?code=a-code&state=0123456789abcdef0123456789abcdef',
    });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json()).toMatchObject({ details: { reason: 'callback_refused' } });
    const still = await api('GET', `/api/v1/models/providers/${provider}/sign-in/${signIn.id}`);
    expect((still.json() as SignIn).status).toBe('pending');
  }, 120_000);
});
