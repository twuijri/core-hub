/**
 * The two halves of this change the models module owns (contract decisions §54, §55):
 *
 * - **the fallback chain**: which provider failures another model could get past, and the
 *   chain as Hermes is told it (`fallback_providers` in `config.yaml`);
 * - **signing in to a provider account** by device code, through a scripted Hermes server that
 *   plays the authorization flow — a code and a link, `pending` until the person approves,
 *   then the provider signed in and its models listed by Hermes.
 *
 * The turn that actually moves down the chain is `sessions/direct-fallback.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { writeHermesConfiguration, type PropagationState } from './propagation.js';
import { retryableFailure } from './service.js';
import {
  hermesSignInRuntime,
  signInStatusOf,
  type DashboardRequest,
  type SignInRuntime,
} from './sign-in.js';

const homes: string[] = [];
let hub: (TestHub & { token: string }) | undefined;
afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  await hub?.close();
  hub = undefined;
});

describe('which failures move a turn down the chain (decision §54)', () => {
  const failure = (
    reason: Parameters<typeof retryableFailure>[0]['reason'],
    status: number | null,
    detail: string | null = null,
  ) => retryableFailure({ reason, status, detail });

  it('moves on when the provider, not the request, failed', () => {
    expect(failure('http_error', 503)).toBe(true);
    expect(failure('http_error', 500)).toBe(true);
    expect(failure('http_error', 502)).toBe(true);
    expect(failure('rate_limited', 429)).toBe(true);
    expect(failure('http_error', 408)).toBe(true);
    expect(failure('unreachable', null, 'fetch failed')).toBe(true);
    // The owner's outage, however the proxy sends it: a 503, or inside a 200 stream.
    expect(failure('http_error', null, 'auth_unavailable: no auth available')).toBe(true);
  });

  it('stays on a validation error, a refused key, a missing model or a stop', () => {
    expect(failure('http_error', 400, 'messages: field required')).toBe(false);
    expect(failure('http_error', 422)).toBe(false);
    expect(failure('model_not_found', 404)).toBe(false);
    expect(failure('unauthorized', 401)).toBe(false);
    expect(failure('unauthorized', 403)).toBe(false);
    expect(failure('no_key', null)).toBe(false);
    expect(failure('cancelled', null)).toBe(false);
  });
});

describe("the chain in Hermes's config.yaml (decision §54)", () => {
  function home(config: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-fallback-'));
    homes.push(dir);
    writeFileSync(path.join(dir, 'config.yaml'), config);
    return dir;
  }
  const read = (dir: string) =>
    YAML.parse(readFileSync(path.join(dir, 'config.yaml'), 'utf8')) as Record<string, unknown>;
  const state = (over: Partial<PropagationState>): PropagationState => ({
    credentials: [],
    hermesProviders: [],
    hermesModel: { provider: 'corehub-proxy', model: 'gemini-3.8-flash-high' },
    hermesModelBlocked: null,
    ...over,
  });

  it('writes the chain as fallback_providers, keeping every other key', () => {
    const dir = home('# mine\nagent:\n  max_turns: 40\n');
    const written = writeHermesConfiguration(
      dir,
      state({ hermesFallbacks: [{ provider: 'openai-codex', model: 'gpt-5.5' }] }),
    );
    expect(written.config.changed).toContain('fallback_providers');
    const config = read(dir);
    expect(config.fallback_providers).toEqual([{ provider: 'openai-codex', model: 'gpt-5.5' }]);
    expect(config.agent).toEqual({ max_turns: 40 });
    expect(readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain('# mine');

    // The same chain again is no write at all: nothing to recycle Hermes for.
    const again = writeHermesConfiguration(
      dir,
      state({ hermesFallbacks: [{ provider: 'openai-codex', model: 'gpt-5.5' }] }),
    );
    expect(again.config.changed).not.toContain('fallback_providers');
  });

  it('keeps extra keys on an entry that still names the same model', () => {
    const dir = home(
      'fallback_providers:\n  - provider: openai-codex\n    model: gpt-5.5\n    request_timeout_seconds: 30\n',
    );
    writeHermesConfiguration(
      dir,
      state({ hermesFallbacks: [{ provider: 'openai-codex', model: 'gpt-5.5' }] }),
    );
    expect(read(dir).fallback_providers).toEqual([
      { provider: 'openai-codex', model: 'gpt-5.5', request_timeout_seconds: 30 },
    ]);
  });

  it('empties a chain the profile no longer has, and leaves it alone where it owns no model', () => {
    const dir = home('fallback_providers:\n  - provider: nous\n    model: hermes-5\n');
    writeHermesConfiguration(dir, state({ hermesFallbacks: [] }));
    expect(read(dir).fallback_providers).toEqual([]);

    const other = home('fallback_providers:\n  - provider: nous\n    model: hermes-5\n');
    writeHermesConfiguration(other, state({ hermesModel: null, hermesFallbacks: null }));
    expect(read(other).fallback_providers).toEqual([{ provider: 'nous', model: 'hermes-5' }]);
  });
});

/**
 * A scripted Hermes server playing the device-code flow: `start` hands out a code and a link,
 * `poll` answers `pending` until `approve()` is called, and `/api/model/options` lists the
 * signed-in provider's models. Every call is recorded, with the profile it was for.
 */
function fakeHermesServer() {
  const calls: string[] = [];
  let state: 'pending' | 'approved' | 'denied' = 'pending';
  const request: DashboardRequest = <T>(method: string, route: string): Promise<T> => {
    calls.push(`${method} ${route}`);
    const url = new URL(route, 'http://hermes.test');
    if (method === 'POST' && url.pathname === '/api/providers/oauth/openai-codex/start') {
      return Promise.resolve({
        session_id: 'hermes-session-1',
        flow: 'device_code',
        user_code: 'HXKQ-9P2M',
        verification_url: 'https://auth.openai.example/codex/device',
        expires_in: 900,
        poll_interval: 5,
      } as T);
    }
    if (url.pathname === '/api/providers/oauth/openai-codex/poll/hermes-session-1') {
      return Promise.resolve({
        session_id: 'hermes-session-1',
        status: state,
        error_message: state === 'denied' ? 'the person declined' : null,
        reason: state === 'denied' ? 'user_declined' : null,
      } as T);
    }
    if (url.pathname === '/api/model/options') {
      return Promise.resolve({
        providers: [
          { slug: 'nous', models: ['hermes-5'] },
          { slug: 'openai-codex', models: ['gpt-5.5', 'gpt-5.5-mini'] },
        ],
      } as T);
    }
    if (method === 'DELETE') return Promise.resolve({ ok: true } as T);
    const refusal = Object.assign(new Error('Unknown route'), {
      name: 'HermesDashboardRefusal',
      status: 404,
    });
    return Promise.reject(refusal);
  };
  return {
    calls,
    runtime: hermesSignInRuntime(request),
    approve: () => {
      state = 'approved';
    },
    deny: () => {
      state = 'denied';
    },
  };
}

async function hubWith(signIn: SignInRuntime | null) {
  hub = await signedInHub({}, { models: { signIn } });
  return hub;
}

async function addCodex(h: TestHub & { token: string }) {
  const created = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset: 'openai-codex', label: 'ChatGPT', kind: 'llm' },
  });
  expect(created.statusCode).toBe(201);
  return created.json() as { id: string; auth: { kind: string; signed_in: boolean } };
}

describe('signing in to a provider by device code (decision §55)', () => {
  it('offers the sign-in only for the providers Hermes can sign in to', async () => {
    const h = await hubWith(fakeHermesServer().runtime);
    const presets = (
      await authed(h, h.token, { method: 'GET', url: '/api/v1/models/provider-presets' })
    ).json() as { items: { id: string; sign_in: boolean; key: string }[] };
    const signIn = presets.items.filter((item) => item.sign_in).map((item) => item.id);
    expect(signIn.sort()).toEqual(['minimax-oauth', 'nous', 'openai-codex', 'xai-oauth']);
    expect(presets.items.find((item) => item.id === 'anthropic')?.sign_in).toBe(false);
    expect(
      presets.items.filter((item) => item.sign_in).every((item) => item.key === 'optional'),
    ).toBe(true);
  });

  it('shows the code and link, polls until approved, then the provider is signed in with its models', async () => {
    const fake = fakeHermesServer();
    const h = await hubWith(fake.runtime);
    const provider = await addCodex(h);
    expect(provider.auth).toEqual({ kind: 'oauth', signed_in: false });

    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in`,
    });
    expect(started.statusCode).toBe(201);
    const signIn = started.json() as {
      id: string;
      status: string;
      user_code: string;
      verification_url: string;
      accepts_code: boolean;
      error: string | null;
    };
    expect(signIn).toMatchObject({
      status: 'pending',
      user_code: 'HXKQ-9P2M',
      verification_url: 'https://auth.openai.example/codex/device',
      accepts_code: false,
      error: null,
    });
    // A shared provider signs in to Hermes's root: no profile on the call.
    expect(fake.calls).toContain('POST /api/providers/oauth/openai-codex/start');

    const poll = () =>
      authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      });
    expect((await poll()).json()).toMatchObject({ status: 'pending' });

    fake.approve();
    expect((await poll()).json()).toMatchObject({ status: 'approved', error: null });
    await drainJobs(h.app);

    const listed = (
      await authed(h, h.token, { method: 'GET', url: '/api/v1/models/providers' })
    ).json() as {
      items: { id: string; auth: { signed_in: boolean }; models: { model: string }[] }[];
    };
    const row = listed.items.find((item) => item.id === provider.id);
    expect(row?.auth.signed_in).toBe(true);
    expect(row?.models.map((model) => model.model).sort()).toEqual(['gpt-5.5', 'gpt-5.5-mini']);

    // A pasted code is not how this sign-in finishes.
    const pasted = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      payload: { code: 'a1b2c3d4' },
    });
    expect(pasted.statusCode).toBe(409);
    expect(pasted.json()).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'code_not_accepted' },
    });
  });

  it("says denied in the person's own words when they decline", async () => {
    const fake = fakeHermesServer();
    const h = await hubWith(fake.runtime);
    const provider = await addCodex(h);
    const signIn = (
      await authed(h, h.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${provider.id}/sign-in`,
      })
    ).json() as { id: string };
    fake.deny();
    const polled = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
    });
    expect(polled.json()).toMatchObject({ status: 'denied', error: 'the person declined' });
  });

  it('a profile’s own provider signs in to that Hermes profile', async () => {
    const fake = fakeHermesServer();
    const h = await hubWith(fake.runtime);
    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'studio', name: 'Studio' },
    });
    expect(made.statusCode).toBe(201);
    const created = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      headers: { 'x-hub-profile': 'studio' },
      payload: { preset: 'openai-codex', label: 'ChatGPT', kind: 'llm', scope: 'profile' },
    });
    expect(created.statusCode).toBe(201);
    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${(created.json() as { id: string }).id}/sign-in`,
      headers: { 'x-hub-profile': 'studio' },
    });
    expect(started.statusCode).toBe(201);
    expect(fake.calls).toContain('POST /api/providers/oauth/openai-codex/start?profile=studio');
  });

  it('refuses a provider used with a key, and a hub that does not run Hermes', async () => {
    const h = await hubWith(null);
    const keyed = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'lmstudio', label: 'LM Studio', kind: 'llm' },
    });
    const keyedId = (keyed.json() as { id: string }).id;
    const refused = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${keyedId}/sign-in`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ details: { reason: 'sign_in_unsupported' } });

    const codex = await addCodex(h);
    const unsupervised = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${codex.id}/sign-in`,
    });
    expect(unsupervised.statusCode).toBe(409);
    expect(unsupervised.json()).toMatchObject({ details: { reason: 'hermes_not_supervised' } });

    const unknown = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${codex.id}/sign-in/01J8QK3ZR2W7M5N4P6T8V9X0SN`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("maps Hermes's states onto the contract's", () => {
    const poll = (status: string, reason: string | null = null) => ({
      status,
      reason,
      error: null,
    });
    expect(signInStatusOf(poll('pending'), false)).toBe('pending');
    expect(signInStatusOf(poll('pending'), true)).toBe('expired');
    expect(signInStatusOf(poll('approved'), false)).toBe('approved');
    expect(signInStatusOf(poll('denied'), false)).toBe('denied');
    expect(signInStatusOf(poll('error', 'timeout'), false)).toBe('expired');
    expect(signInStatusOf(poll('error', 'superseded'), false)).toBe('failed');
    expect(signInStatusOf(poll('gone'), false)).toBe('expired');
    expect(signInStatusOf(poll('cancelled'), false)).toBe('failed');
  });
});
