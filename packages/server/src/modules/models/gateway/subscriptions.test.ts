/**
 * Subscriptions signed in to through the hub's model gateway (DECISIONS §143), through the API
 * and against the CLIProxyAPI stand-in's management API (`testing/fake-cliproxy-accounts.mjs`): a
 * short-code sign-in, a pasted-back link, ChatGPT's code from a child process, the provider's
 * dialog (accounts, usage windows, "check now", errors, turn off, renew, sign out), the account's
 * models reaching the catalogue and the gateway, and "move this sign-in to the gateway".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../../lib/db.js';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { modelsServiceFor } from '../index.js';
import { models as modelRows, providers as providerRows } from '../schema.js';
import { upstreamPrefix } from './cliproxy-config.js';
import { newUlid } from '../../../db/ids.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testing',
  'fake-cliproxy.mjs',
);

type Hub = TestHub & { token: string; userId: string };

const noNetwork = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  delete process.env.FAKE_CLIPROXY_LOGIN;
  delete process.env.FAKE_CLIPROXY_ERRORS;
});

async function hub(gateway: 'on' | 'off' = 'on'): Promise<Hub> {
  const made = await signedInHub(
    { COREHUB_MODEL_GATEWAY: gateway },
    { models: { fetchImpl: noNetwork, cliproxyBin: gateway === 'on' ? FAKE : null } },
  );
  cleanup.push(() => made.close());
  return made as Hub;
}

async function add(h: Hub, preset: string): Promise<{ id: string }> {
  const response = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset, label: '', kind: 'llm', scope: 'all' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string };
}

interface SignIn {
  id: string;
  status: string;
  user_code: string | null;
  verification_url: string;
  accepts_code: boolean;
  callback_hint?: string | null;
  error: string | null;
}

async function start(h: Hub, providerId: string): Promise<SignIn> {
  const response = await authed(h, h.token, {
    method: 'POST',
    url: `/api/v1/models/providers/${providerId}/sign-in`,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as SignIn;
}

async function settle(h: Hub, providerId: string, signIn: SignIn): Promise<SignIn> {
  for (let i = 0; i < 100; i += 1) {
    const response = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${providerId}/sign-in/${signIn.id}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const now = response.json() as SignIn;
    if (now.status !== 'pending') return now;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the sign-in never ended');
}

function authDir(h: Hub): string {
  return path.join(h.dataDir, 'gateway', 'cliproxy-auth');
}

function accountFile(h: Hub, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(authDir(h), name), 'utf8')) as Record<string, unknown>;
}

describe('subscriptions through the gateway', () => {
  it('lists the vendors the gateway signs in to, and keeps them out of the preset list', async () => {
    const h = await hub();
    const response = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/models/subscription-vendors',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      available: boolean;
      note: string;
      items: { preset: string; vendor: string; flow: string; usage_windows: boolean }[];
    };
    expect(body.available).toBe(true);
    expect(body.note).toMatch(/outside their own apps/);
    const byVendor = Object.fromEntries(body.items.map((item) => [item.vendor, item]));
    expect(byVendor.codex).toMatchObject({ preset: 'chatgpt-subscription', flow: 'device' });
    expect(byVendor.claude).toMatchObject({ flow: 'link', usage_windows: true });
    expect(byVendor.xai?.flow).toBe('device');
    expect(byVendor.kimi?.flow).toBe('device');
    expect(byVendor.meta?.flow).toBe('device');
    expect(byVendor.antigravity?.flow).toBe('link');
    const presets = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/models/provider-presets',
    });
    const ids = (presets.json() as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).not.toContain('chatgpt-subscription');
    expect(ids).toContain('openai-codex');
  });

  it('says why when the gateway is off, and refuses a sign-in', async () => {
    const h = await hub('off');
    const vendors = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/models/subscription-vendors',
    });
    expect((vendors.json() as { available: boolean }).available).toBe(false);
    const provider = await add(h, 'xai-subscription');
    const refused = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ details: { reason: 'gateway_unavailable' } });
  });

  it('signs in by a short code, marks the account as the row’s, and serves its models to every agent', async () => {
    const h = await hub();
    const provider = await add(h, 'xai-subscription');
    const signIn = await start(h, provider.id);
    expect(signIn).toMatchObject({
      status: 'pending',
      user_code: 'FAKE-1234',
      accepts_code: false,
    });
    expect(signIn.verification_url).toContain('user_code=FAKE-1234');
    const done = await settle(h, provider.id, signIn);
    expect(done.status).toBe('approved');
    await drainJobs(h.app);

    const name = readdirSync(authDir(h)).find((file) => file.startsWith('xai-'))!;
    expect(accountFile(h, name)).toMatchObject({
      prefix: upstreamPrefix(provider.id),
      note: `corehub:${provider.id.toLowerCase()}`,
      // The gateway decides what a refusal means; the account never cools itself (§148).
      disable_cooling: true,
    });
    const read = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${provider.id}`,
    });
    // (no GET for one provider: the list says it)
    expect([200, 404, 405]).toContain(read.statusCode);
    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/models/providers' });
    const row = (
      list.json() as {
        items: {
          id: string;
          auth: { signed_in: boolean };
          subscription?: { vendor: string; accounts: number; accounts_ready: number };
          models: { model: string }[];
        }[];
      }
    ).items.find((item) => item.id === provider.id)!;
    expect(row.auth.signed_in).toBe(true);
    expect(row.subscription).toMatchObject({ vendor: 'xai', flow: 'device', accounts: 1 });
    expect(row.models.map((model) => model.model)).toEqual(['grok-4.5']);

    // The gateway serves the row: its accounts, under its prefix.
    const upstreams = modelsServiceFor(h.app).gatewayUpstreams();
    expect(upstreams.find((u) => u.providerId === provider.id)).toMatchObject({
      kind: 'subscription',
      apiKey: null,
    });
    const catalogue = await authed(h, h.token, { method: 'GET', url: '/api/v1/models' });
    const model = (
      catalogue.json() as { items: { key: string; agent_gateway?: boolean }[] }
    ).items.find((item) => item.key === 'xai-subscription/grok-4.5');
    expect(model?.agent_gateway).toBe(true);
    // The hub's own agent reaches the account the same way, through the gateway's translator.
    const workspace = (
      requireSqlite(h.app.hub.database)
        .$client.prepare("select id from workspaces where slug = 'default'")
        .get() as { id: string }
    ).id;
    const events: { type: string; text?: string }[] = [];
    for await (const event of modelsServiceFor(h.app).chat(workspace, {
      providerId: provider.id,
      model: 'grok-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event as { type: string; text?: string });
    }
    expect(events.filter((event) => event.type === 'delta').map((event) => event.text)).toEqual([
      'hello',
    ]);
    // No key, no token of the account anywhere in the hub's database.
    const db = requireSqlite(h.app.hub.database);
    const dump = JSON.stringify(db.$client.prepare('select * from secrets').all());
    expect(dump).not.toContain('fake-access');
  });

  it('signs in by a link whose landing address is pasted back', async () => {
    const h = await hub();
    const provider = await add(h, 'claude-subscription');
    const signIn = await start(h, provider.id);
    expect(signIn).toMatchObject({
      status: 'pending',
      user_code: null,
      accepts_code: true,
      callback_hint: 'http://localhost:54545/callback',
    });
    const state = new URL(signIn.verification_url).searchParams.get('state');
    const pasted = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      payload: { code: `http://localhost:54545/callback?code=abc123&state=${state}` },
    });
    expect(pasted.statusCode, pasted.body).toBe(200);
    expect((await settle(h, provider.id, signIn)).status).toBe('approved');
  });

  it('says a pasted address the vendor refused', async () => {
    const h = await hub();
    const provider = await add(h, 'antigravity-subscription');
    const signIn = await start(h, provider.id);
    const state = new URL(signIn.verification_url).searchParams.get('state');
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      payload: { code: `http://localhost:51121/oauth-callback?code=bad&state=${state}` },
    });
    const done = await settle(h, provider.id, signIn);
    expect(done.status).toBe('failed');
    expect(done.error).toBeTruthy();
    // A device-code sign-in takes no pasted code.
    const xai = await add(h, 'xai-subscription');
    const code = await start(h, xai.id);
    const refused = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${xai.id}/sign-in/${code.id}`,
      payload: { code: 'anything' },
    });
    expect(refused.statusCode).toBe(409);
  });

  it('signs in to ChatGPT by the code CLIProxyAPI prints, and the dialog shows usage, checks, errors and actions', async () => {
    process.env.FAKE_CLIPROXY_ERRORS = '1';
    const h = await hub();
    const provider = await add(h, 'chatgpt-subscription');
    const signIn = await start(h, provider.id);
    expect(signIn).toMatchObject({
      user_code: 'FAKE-CODEX1',
      verification_url: 'https://auth.openai.com/codex/device',
      accepts_code: false,
    });
    expect((await settle(h, provider.id, signIn)).status).toBe('approved');
    await drainJobs(h.app);
    const name = readdirSync(authDir(h)).find((file) => file.startsWith('codex-'))!;
    expect(accountFile(h, name).prefix).toBe(upstreamPrefix(provider.id));

    const dialog = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${provider.id}/accounts`,
    });
    expect(dialog.statusCode, dialog.body).toBe(200);
    const body = dialog.json() as {
      available: boolean;
      vendor: string;
      accounts: {
        id: string;
        email: string;
        plan: string;
        status: string;
        requests: { success: number; recent: { at: string }[] };
        windows: {
          id: string;
          used_percent: number;
          resets_at: string;
          source: string;
          label: string;
        }[];
        limit_reached: boolean;
      }[];
      errors: { account_id: string; status: number; message: string; model: string }[];
    };
    expect(body).toMatchObject({ available: true, vendor: 'codex' });
    const account = body.accounts[0]!;
    expect(account).toMatchObject({ id: name, email: 'person@example.com', plan: 'plus' });
    expect(account.requests.recent).toHaveLength(20);
    expect(account.windows.map((w) => [w.id, w.used_percent, w.source, w.label])).toEqual([
      ['primary', 12.5, 'observed', '5 hours'],
      ['secondary', 40, 'observed', 'Weekly'],
    ]);
    expect(account.limit_reached).toBe(false);
    // The failed call CLIProxyAPI queued: the account is waiting, and the error is listed.
    expect(account.status).toBe('cooling');
    expect(body.errors[0]).toMatchObject({
      account_id: name,
      status: 429,
      message: 'The usage limit has been reached',
      model: 'gpt-5.5',
    });

    const encoded = encodeURIComponent(name);
    const checked = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/accounts/${encoded}/check`,
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const after = checked.json() as {
      windows: { id: string; used_percent: number; source: string }[];
      checked_at: string;
      check_error: string | null;
    };
    expect(after.check_error).toBeNull();
    expect(after.checked_at).toBeTruthy();
    expect(after.windows.map((w) => [w.id, w.used_percent, w.source])).toEqual([
      ['primary', 20, 'checked'],
      ['secondary', 55, 'checked'],
    ]);

    const renewed = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/accounts/${encoded}/refresh`,
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect((renewed.json() as { status: string }).status).toBe('active');

    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${provider.id}/accounts/${encoded}`,
      payload: { disabled: true },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ status: 'disabled', disabled: true });

    const gone = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${provider.id}/accounts/${encoded}`,
    });
    expect(gone.statusCode).toBe(204);
    expect(existsSync(path.join(authDir(h), name))).toBe(false);
    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/models/providers' });
    const row = (
      list.json() as { items: { id: string; auth: { signed_in: boolean } }[] }
    ).items.find((item) => item.id === provider.id)!;
    expect(row.auth.signed_in).toBe(false);
    const missing = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${provider.id}/accounts/${encoded}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses the dialog for a provider connected by key', async () => {
    const h = await hub();
    const response = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'lmstudio', label: 'LM Studio', kind: 'llm', scope: 'all' },
    });
    const id = (response.json() as { id: string }).id;
    const dialog = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${id}/accounts`,
    });
    expect(dialog.statusCode).toBe(409);
    expect(dialog.json()).toMatchObject({ details: { reason: 'not_a_subscription' } });
  });

  it('moves a Hermes sign-in to the gateway: signs in again and moves the model choices', async () => {
    const h = await hub();
    const db = requireSqlite(h.app.hub.database);
    const legacy = await add(h, 'openai-codex');
    db.update(providerRows).set({ status: 'ok' }).where(eq(providerRows.id, legacy.id)).run();
    const row = db.select().from(providerRows).where(eq(providerRows.id, legacy.id)).get()!;
    const modelId = newUlid();
    db.insert(modelRows)
      .values({
        id: modelId,
        ownerId: row.ownerId,
        workspace: row.workspace,
        createdAt: new Date(),
        updatedAt: new Date(),
        providerId: legacy.id,
        modelKey: 'gpt-5.5',
        label: 'gpt-5.5',
      })
      .run();
    const set = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: { default: { provider_id: legacy.id, model: 'gpt-5.5' } },
    });
    expect(set.statusCode, set.body).toBe(200);

    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/models/providers' });
    const card = (
      list.json() as { items: { id: string; gateway_move?: { preset: string } }[] }
    ).items.find((item) => item.id === legacy.id)!;
    expect(card.gateway_move).toEqual({ preset: 'chatgpt-subscription' });

    const moved = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${legacy.id}/move-to-gateway`,
    });
    expect(moved.statusCode, moved.body).toBe(201);
    const { provider, sign_in } = moved.json() as {
      provider: { id: string; slug: string };
      sign_in: SignIn;
    };
    expect(provider.slug).toBe('chatgpt-subscription');
    expect((await settle(h, provider.id, sign_in)).status).toBe('approved');
    await drainJobs(h.app);
    const defaults = await authed(h, h.token, { method: 'GET', url: '/api/v1/models/defaults' });
    expect(defaults.json()).toMatchObject({
      default: { provider_id: provider.id, model: 'gpt-5.5' },
    });
    // The Hermes sign-in is left as it was.
    const still = db.select().from(providerRows).where(eq(providerRows.id, legacy.id)).get()!;
    expect(still).toMatchObject({ status: 'ok', archivedAt: null });

    // A provider connected by key cannot be moved.
    const keyed = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'lmstudio', label: 'LM Studio', kind: 'llm', scope: 'all' },
    });
    const refused = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${(keyed.json() as { id: string }).id}/move-to-gateway`,
    });
    expect(refused.statusCode).toBe(409);
  });
});
