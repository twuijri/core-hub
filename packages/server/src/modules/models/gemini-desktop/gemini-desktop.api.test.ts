// Gemini Desktop through the hub's API (DECISIONS §155): added like any subscription, signed in
// to by a pasted address with no gateway at all, its accounts in the dialog and in the encrypted
// store only, its models in the catalogue, the direct agent's turns kept in one Gemini
// conversation, and every other agent refused with the reason.
import { afterEach, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../../lib/db.js';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { modelsServiceFor } from '../index.js';
import { REDIRECT_URI, TOKEN_ENDPOINT, USERINFO_ENDPOINT } from './oauth.js';
import { fakeNative, type FakeNative } from './testing/fake-native.js';

type Hub = TestHub & { token: string; userId: string };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function google(): typeof fetch {
  let issued = 0;
  return (async (url: string, init: RequestInit = {}) => {
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (String(url) === TOKEN_ENDPOINT) {
      if (body.get('grant_type') === 'authorization_code') {
        return json({ access_token: 'flex', refresh_token: 'refresh-secret-1', expires_in: 3600 });
      }
      issued += 1;
      return json({
        access_token: `access-secret-${issued}`,
        expires_in: 3600,
        scope: body.get('scope'),
      });
    }
    if (String(url) === USERINFO_ENDPOINT)
      return json({ email: 'person@example.com', verified_email: true });
    return new Response('{}', { status: 503 });
  }) as unknown as typeof fetch;
}

async function hub(): Promise<{ h: Hub; fake: FakeNative }> {
  const fake = await fakeNative();
  // The gateway is off and there is no CLIProxyAPI: Gemini Desktop needs neither.
  const made = await signedInHub(
    { COREHUB_MODEL_GATEWAY: 'off' },
    {
      models: {
        fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
        cliproxyBin: null,
        geminiDesktop: { fetchImpl: google(), opener: fake.opener },
      },
    },
  );
  cleanup.push(
    () => made.close(),
    () => fake.close(),
  );
  return { h: made as Hub, fake };
}

interface SignIn {
  id: string;
  status: string;
  verification_url: string;
  accepts_code: boolean;
  callback_hint?: string | null;
  error: string | null;
}

describe('gemini desktop through the API', () => {
  it('signs in by a pasted address, lists the account and its models, and keeps the tokens encrypted', async () => {
    const { h, fake } = await hub();
    const vendors = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/models/subscription-vendors',
    });
    const items = (vendors.json() as { items: { vendor: string; preset: string; flow: string }[] })
      .items;
    expect(items).toContainEqual(
      expect.objectContaining({
        vendor: 'gemini-desktop',
        preset: 'gemini-desktop-subscription',
        flow: 'link',
      }),
    );

    const created = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'gemini-desktop-subscription', label: '', kind: 'llm', scope: 'all' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const provider = created.json() as { id: string };

    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in`,
    });
    expect(started.statusCode, started.body).toBe(201);
    const signIn = started.json() as SignIn;
    expect(signIn).toMatchObject({
      status: 'pending',
      accepts_code: true,
      callback_hint: REDIRECT_URI,
    });
    const state = new URL(signIn.verification_url).searchParams.get('state');

    // Another sign-in's address is refused, and this one still waits for its own.
    const wrong = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      payload: { code: `${REDIRECT_URI}?state=not-this-one&code=x` },
    });
    expect(wrong.statusCode).toBe(400);
    const pasted = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      payload: {
        code: `${REDIRECT_URI}?state=${state}&iss=https://accounts.google.com&code=4/abc&scope=x`,
      },
    });
    expect(pasted.statusCode, pasted.body).toBe(200);
    expect((pasted.json() as SignIn).status).toBe('approved');
    await drainJobs(h.app);

    const row = (await providerOf(h, provider.id)) as {
      auth: { kind: string; signed_in: boolean };
      models: { key: string }[];
      subscription: { vendor: string; accounts: number; accounts_ready: number };
    };
    expect(row.auth).toEqual({ kind: 'oauth', signed_in: true });
    expect(row.subscription).toEqual({
      vendor: 'gemini-desktop',
      flow: 'link',
      accounts: 1,
      accounts_ready: 1,
    });
    expect(row.models.map((model) => model.key).sort()).toEqual([
      'gemini-desktop-subscription/gemini-desktop-3.1-pro',
      'gemini-desktop-subscription/gemini-desktop-3.5-flash-lite',
      'gemini-desktop-subscription/gemini-desktop-auto',
    ]);

    const dialog = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${provider.id}/accounts`,
    });
    expect(dialog.statusCode, dialog.body).toBe(200);
    const accounts = (
      dialog.json() as { accounts: { id: string; email: string; status: string }[] }
    ).accounts;
    expect(accounts).toEqual([
      expect.objectContaining({ email: 'person@example.com', status: 'active' }),
    ]);

    // The tokens are only ever ciphertext at rest.
    const db = requireSqlite(h.app.hub.database);
    const dump = JSON.stringify(db.$client.prepare('select * from secrets').all());
    expect(dump).not.toContain('refresh-secret-1');
    expect(dump).not.toContain('access-secret');

    // Renew asks Google again and the account's modes; sign out ends the provider's sign-in.
    const renewed = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/accounts/${accounts[0]!.id}/refresh`,
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(
      fake.requests.filter((r) => r.method.endsWith('/GetUserStatus')).length,
    ).toBeGreaterThanOrEqual(2);
    const removed = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${provider.id}/accounts/${accounts[0]!.id}`,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const after = (await providerOf(h, provider.id)) as { auth: { signed_in: boolean } };
    expect(after.auth.signed_in).toBe(false);
  });

  it('keeps the direct agent’s conversation in one Gemini conversation, and refuses every other agent', async () => {
    const { h, fake } = await hub();
    const created = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'gemini-desktop-subscription', label: '', kind: 'llm', scope: 'all' },
    });
    const provider = created.json() as { id: string };
    const signIn = (
      await authed(h, h.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${provider.id}/sign-in`,
      })
    ).json() as SignIn;
    const state = new URL(signIn.verification_url).searchParams.get('state');
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      payload: { code: `${REDIRECT_URI}?state=${state}&code=4/abc` },
    });
    await drainJobs(h.app);

    const service = modelsServiceFor(h.app);
    const workspace = await defaultWorkspace(h);
    const conversation = 'direct-01jabcdefghjkmnpqrstvwxyz0';
    const say = async (messages: { role: 'user' | 'assistant'; text: string }[]) => {
      let text = '';
      for await (const event of service.chat(workspace, {
        providerId: provider.id,
        model: 'gemini-desktop-3.1-pro',
        messages,
        conversation,
      })) {
        if (event.type === 'delta') text += event.text;
        if (event.type === 'failed') throw new Error(event.message);
      }
      return text;
    };
    const first = await say([{ role: 'user', text: 'hello' }]);
    const second = await say([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: first },
      { role: 'user', text: 'again' },
    ]);
    expect(second).toBe('echo: again');
    const turns = fake.turns.slice(-2);
    expect(turns[0]!.conversation).toBe(turns[1]!.conversation);
    expect(fake.requests.at(-1)).toMatchObject({ text: 'again', category: 3, variantId: 'pro-v1' });

    // Not an upstream of the gateway, not a model a coding agent can run, and refused by name.
    expect(service.gatewayUpstreams().some((upstream) => upstream.providerId === provider.id)).toBe(
      false,
    );
    expect(
      service.gatewayModelKeys(workspace).some((key) => key.startsWith('gemini-desktop')),
    ).toBe(false);
    const refusal = service.gatewayTarget(workspace, provider.id, 'gemini-desktop-3.1-pro');
    expect(refusal).toEqual({ refusal: expect.stringMatching(/text only.*direct agent/) });
  });
});

/** The workspace id behind the `default` profile, for the service-level calls. */
async function defaultWorkspace(h: Hub): Promise<string> {
  const response = await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' });
  const items = (response.json() as { items: { id: string; slug: string }[] }).items;
  const found = items.find((profile) => profile.slug === 'default');
  if (!found) throw new Error('no default workspace');
  return found.id;
}

async function providerOf(h: Hub, id: string): Promise<unknown> {
  const response = await authed(h, h.token, { method: 'GET', url: '/api/v1/models/providers' });
  return (response.json() as { items: { id: string }[] }).items.find((item) => item.id === id);
}
