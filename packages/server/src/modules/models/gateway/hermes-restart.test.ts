/**
 * Hermes is restarted by the hub after every change that needs it — no manual restart in the
 * normal flow (the owner, 2026-09-30, on preview.38: he had to press "Restart now" before
 * "The runtime restarted after the last change" went green). One test per path that changes what
 * Hermes reads: a provider added, edited, removed; the default model; a named profile's files
 * alone; a subscription signed in and signed out through CLIProxyAPI; an account that went away
 * outside the hub (the minute's read). And the runtime report: while the automatic restart is on
 * its way it says so (`scheduled` / `waiting_for_run`), and the chat model reads «<provider> ·
 * <model>», not Hermes's block name.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../../lib/db.js';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { modelsServiceFor } from '../index.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testing',
  'fake-cliproxy.mjs',
);

type Hub = TestHub & { token: string; userId: string };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function providers(): typeof fetch {
  return (async (url: string) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.startsWith('https://api.groq.com/openai/v1/models')) {
      return json({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'qwen-3-32b' }] });
    }
    return new Response('{}', { status: 503 });
  }) as unknown as typeof fetch;
}

interface Harness {
  h: Hub;
  home: string;
  restarts: number[];
  /** Waits for the debounced restart, then says how many happened since `from`. */
  restartsSince(from: number): Promise<number>;
  busy: { value: boolean };
}

async function hub(
  options: { restartDelayMs?: number; profiles?: string[]; gateway?: 'on' | 'off' } = {},
): Promise<Harness> {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-restart-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const profileHomes = (options.profiles ?? []).map((name) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  const restarts: number[] = [];
  const busy = { value: false };
  let startedAt: number | null = Date.now() - 60_000;
  const gateway = options.gateway ?? 'on';
  const made = await signedInHub(
    { COREHUB_MODEL_GATEWAY: gateway },
    {
      models: {
        fetchImpl: providers(),
        cliproxyBin: gateway === 'on' ? FAKE : null,
        restartDelayMs: options.restartDelayMs ?? 0,
        hermes: {
          home: () => home,
          profileHomes: () => profileHomes,
          mode: () => 'managed',
          reloadedAt: () => startedAt,
          busy: () => busy.value,
          restart: () => {
            // A real restart starts the process a moment later than the write it follows.
            startedAt = Date.now() + 1;
            restarts.push(startedAt);
            return Promise.resolve(true);
          },
        },
      },
    },
  );
  cleanup.push(() => made.close());
  const restartsSince = async (from: number) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return restarts.length - from;
  };
  return { h: made as Hub, home, restarts, restartsSince, busy };
}

async function add(h: Hub, preset: string, key: string | null) {
  const response = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset, label: preset, kind: 'llm', api_key: key, scope: 'all' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string };
}

interface Report {
  ready: boolean;
  checks: { id: string; ok: boolean; detail: string | null }[];
}

async function report(h: Hub): Promise<Report> {
  const response = await authed(h, h.token, { method: 'GET', url: '/api/v1/models/runtime' });
  return response.json() as Report;
}

const check = (r: Report, id: string) => r.checks.find((c) => c.id === id)!;

const blocks = (home: string) =>
  Object.keys(
    (
      parse(readFileSync(path.join(home, 'config.yaml'), 'utf8')) as {
        providers?: Record<string, unknown>;
      }
    ).providers ?? {},
  );

describe('Hermes is restarted after every change it needs, with no restart button', () => {
  it('a provider added, edited and removed, and the default model changed', async () => {
    const { h, restarts, restartsSince } = await hub();
    let from = restarts.length;
    const groq = await add(h, 'groq', 'gsk-restart');
    await drainJobs(h.app);
    expect(await restartsSince(from)).toBeGreaterThanOrEqual(1);
    expect(check(await report(h), 'gateway_reloaded').ok).toBe(true);

    from = restarts.length;
    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${groq.id}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await restartsSince(from)).toBe(1);
    expect(check(await report(h), 'gateway_reloaded').ok).toBe(true);

    await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${groq.id}`,
      payload: { enabled: true },
    });
    await restartsSince(0);
    from = restarts.length;
    const chosen = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: { default: { provider_id: groq.id, model: 'qwen-3-32b' } },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(await restartsSince(from)).toBe(1);
    const ready = await report(h);
    expect(check(ready, 'gateway_reloaded').ok).toBe(true);
    // The chat model as people read it, not Hermes's block name (`corehub-gw-groq/…`).
    expect(check(ready, 'model_selected').detail).toBe('groq · qwen-3-32b');

    from = restarts.length;
    const removed = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${groq.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(await restartsSince(from)).toBe(1);
    expect(check(await report(h), 'gateway_reloaded').ok).toBe(true);
  });

  it('a change only a named profile’s files see still restarts Hermes (its messaging gateway reads them)', async () => {
    const { h, home, restarts, restartsSince } = await hub({ profiles: ['work'] });
    const groq = await add(h, 'groq', 'gsk-profile');
    await drainJobs(h.app);
    await restartsSince(0);
    const profileConfig = path.join(home, 'profiles', 'work', 'config.yaml');
    expect(readFileSync(profileConfig, 'utf8')).toContain('corehub-gw-groq');
    // Somebody's edit, or an earlier build's, leaves the profile behind; the root is current.
    writeFileSync(profileConfig, 'model:\n  default: something-else\n');
    const from = restarts.length;
    // A save that changes nothing in the root's files.
    const same = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${groq.id}`,
      payload: { enabled: true },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(await restartsSince(from)).toBe(1);
    expect(readFileSync(profileConfig, 'utf8')).toContain('corehub-gw-groq');
    expect(check(await report(h), 'gateway_reloaded').ok).toBe(true);
  });

  it('a subscription signed in and signed out through CLIProxyAPI, and an account gone outside the hub', async () => {
    const { h, home, restarts, restartsSince } = await hub();
    const provider = await add(h, 'xai-subscription', null);
    let from = restarts.length;
    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in`,
    });
    expect(started.statusCode, started.body).toBe(201);
    const signIn = started.json() as { id: string };
    for (let i = 0; i < 100; i += 1) {
      const polled = await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/models/providers/${provider.id}/sign-in/${signIn.id}`,
      });
      if ((polled.json() as { status: string }).status !== 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await drainJobs(h.app);
    expect(await restartsSince(from)).toBeGreaterThanOrEqual(1);
    expect(blocks(home)).toContain('corehub-gw-xai-subscription');
    expect(check(await report(h), 'gateway_reloaded').ok).toBe(true);

    // Signed out through the dialog: the row's block goes, and Hermes is restarted.
    const accounts = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/models/providers/${provider.id}/accounts`,
    });
    const account = (accounts.json() as { accounts: { id: string }[] }).accounts[0]!;
    from = restarts.length;
    const gone = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${provider.id}/accounts/${encodeURIComponent(account.id)}`,
    });
    expect(gone.statusCode, gone.body).toBe(204);
    expect(await restartsSince(from)).toBe(1);
    expect(blocks(home)).not.toContain('corehub-gw-xai-subscription');
    expect(check(await report(h), 'gateway_reloaded').ok).toBe(true);

    // Signed in again, then the account file disappears outside the hub (CLIProxyAPI dropped
    // it, a backup restored without it): the minute's read brings Hermes up to date.
    const again = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/models/providers/${provider.id}/sign-in`,
    });
    const second = again.json() as { id: string };
    for (let i = 0; i < 100; i += 1) {
      const polled = await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/models/providers/${provider.id}/sign-in/${second.id}`,
      });
      if ((polled.json() as { status: string }).status !== 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await drainJobs(h.app);
    await restartsSince(0);
    expect(blocks(home)).toContain('corehub-gw-xai-subscription');
    const authDir = path.join(h.dataDir, 'gateway', 'cliproxy-auth');
    for (const name of readdirSync(authDir)) rmSync(path.join(authDir, name));
    const service = modelsServiceFor(h.app);
    await service.subscriptions.refresh(true);
    const workspace = (
      requireSqlite(h.app.hub.database)
        .$client.prepare("select id, slug, name from workspaces where slug = 'default'")
        .get() as { id: string; slug: string; name: string }
    ).id;
    from = restarts.length;
    expect(
      service.syncSubscriptionRows(
        { id: workspace, slug: 'default', name: 'default', isDefault: true },
        { userId: h.userId },
      ),
    ).toBe(true);
    expect(await restartsSince(from)).toBe(1);
    expect(blocks(home)).not.toContain('corehub-gw-xai-subscription');
  });

  it('says the automatic restart is on its way, and waits for a reply in progress', async () => {
    const { h, busy, restarts } = await hub({ restartDelayMs: 150 });
    busy.value = true;
    await add(h, 'groq', 'gsk-scheduled');
    await drainJobs(h.app);
    const pending = check(await report(h), 'gateway_reloaded');
    expect(pending).toMatchObject({ ok: false, detail: 'scheduled' });
    // Past the debounce, a turn is in flight: it waits for it, and says so.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(check(await report(h), 'gateway_reloaded')).toMatchObject({
      ok: false,
      detail: 'waiting_for_run',
    });
    const before = restarts.length;
    busy.value = false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(restarts.length).toBeGreaterThan(before);
    expect(check(await report(h), 'gateway_reloaded')).toMatchObject({ ok: true, detail: null });
  });
});
