import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HubConnection,
  LinkRefused,
  claimPairing,
  gatewayModels,
  RENEW_BEFORE_MS,
} from '../src/hub.js';
import { PluginStore, type StoredLink } from '../src/store.js';
import { fakeFetch } from './fake-hub.js';

const dirs: string[] = [];
const store = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-dsh-hub-'));
  dirs.push(dir);
  return new PluginStore(dir);
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const link = (expires: string | null): StoredLink => ({
  version: 1,
  hub: 'https://hub.example',
  token: 'hub_at_1',
  token_expires_at: expires,
  device_id: 'D1',
  user: { id: 'u1', username: 'tariq', display_name: 'Tariq' },
  profiles: ['default'],
  default_profile: 'default',
  linked_at: '2026-11-22T00:00:00.000Z',
});

describe('claimPairing', () => {
  it('claims with the computer described as the harness and keeps the token', async () => {
    const { fetch, seen } = fakeFetch((s) =>
      s.path === '/auth/pairings/P1/claim' &&
      (s.body as { device: { platform: string } }).device.platform === 'dsh'
        ? {
            status: 200,
            json: {
              app_token: 'hub_at_new',
              token_id: 'T1',
              expires_at: '2027-02-01T00:00:00Z',
              device: { id: 'D9' },
              user: {
                id: 'u1',
                username: 'tariq',
                display_name: 'طارق',
                profiles: ['default', 'work'],
                default_profile: 'work',
              },
              server: {},
            },
          }
        : undefined,
    );
    const stored = await claimPairing({
      pairing: { hub: 'https://hub.example', pairingId: 'P1', code: 'ABCD' },
      deviceKey: 'k'.repeat(64),
      pluginVersion: '1.1.10',
      harnessVersion: '0.2.2-rc.5',
      fetch,
    });
    expect(stored).toMatchObject({
      token: 'hub_at_new',
      device_id: 'D9',
      default_profile: 'work',
      profiles: ['default', 'work'],
    });
    const body = seen[0]!.body as { code: string; device: Record<string, unknown> };
    expect(body.code).toBe('ABCD');
    expect(body.device).toMatchObject({
      kind: 'computer',
      model: 'DeepSeek Harness 0.2.2-rc.5',
      app_version: '1.1.10',
    });
    expect(String(body.device.name)).toContain('DeepSeek Harness');
    expect(body.device.platform).toBe('dsh');
  });

  it('says the OS to a hub older than the dsh platform', async () => {
    const { fetch, seen } = fakeFetch((s) => {
      const platform = (s.body as { device: { platform: string } }).device.platform;
      if (platform === 'dsh')
        return { status: 400, json: { error: 'invalid', code: 'validation_failed' } };
      return {
        status: 200,
        json: {
          app_token: 'hub_at_old',
          token_id: 'T1',
          expires_at: null,
          device: { id: 'D1' },
          user: {
            id: 'u1',
            username: 'tariq',
            display_name: 'Tariq',
            profiles: [],
            default_profile: 'default',
          },
          server: {},
        },
      };
    });
    const stored = await claimPairing({
      pairing: { hub: 'https://hub.example', pairingId: 'P1', code: 'ABCD' },
      deviceKey: 'k'.repeat(64),
      pluginVersion: '1.1.10',
      harnessVersion: null,
      fetch,
    });
    expect(stored.token).toBe('hub_at_old');
    expect(seen.map((s) => (s.body as { device: { platform: string } }).device.platform)).toEqual([
      'dsh',
      expect.stringMatching(/^(linux|macos|windows)$/),
    ]);
  });
});

describe('HubConnection', () => {
  it('renews an app token that has fewer than seven days left, and keeps the new expiry', async () => {
    const now = Date.parse('2026-11-22T00:00:00Z');
    const { fetch, seen } = fakeFetch((s) =>
      s.path === '/auth/refresh'
        ? { status: 200, json: { expires_in: 90 * 24 * 3600 } }
        : s.path === '/meta'
          ? { status: 200, json: { ok: true } }
          : undefined,
    );
    const st = store();
    const conn = new HubConnection(link(new Date(now + RENEW_BEFORE_MS - 1000).toISOString()), {
      store: st,
      fetch,
      now: () => now,
    });
    await conn.client.raw('get', '/meta');
    expect(seen.map((s) => s.path)).toEqual(['/auth/refresh', '/meta']);
    expect(seen[0]!.headers.authorization).toBe('Bearer hub_at_1');
    expect(st.link()?.token_expires_at).toBe(new Date(now + 90 * 24 * 3600 * 1000).toISOString());
    await conn.client.raw('get', '/meta');
    expect(seen.filter((s) => s.path === '/auth/refresh')).toHaveLength(1);
  });

  it('retries once after token_expired, and stops the link on any other 401', async () => {
    let expired = true;
    const { fetch } = fakeFetch((s) => {
      if (s.path === '/auth/refresh') {
        expired = false;
        return { status: 200, json: { expires_in: 3600 } };
      }
      if (s.path === '/meta')
        return expired
          ? { status: 401, json: { error: 'expired', code: 'token_expired' } }
          : { status: 200, json: {} };
      return { status: 401, json: { error: 'revoked', code: 'token_revoked' } };
    });
    const onRefused = vi.fn();
    const conn = new HubConnection(link(null), { store: store(), fetch, onRefused });
    await expect(conn.client.raw('get', '/meta')).resolves.toMatchObject({ status: 200 });
    await expect(conn.client.raw('get', '/other')).rejects.toBeInstanceOf(LinkRefused);
    expect(onRefused).toHaveBeenCalledWith('token_revoked');
  });
});

describe('gatewayModels', () => {
  it('lists the models of the external entrance', async () => {
    const { fetch, seen } = fakeFetch((s) =>
      s.path === '/gateway/openai/v1/models'
        ? {
            status: 200,
            json: {
              object: 'list',
              data: [
                {
                  id: 'chatgpt-subscription/gpt-6.2-sol',
                  context_window: 400000,
                  input_modalities: ['text', 'image'],
                },
                { id: 'kimi-subscription/kimi-k2', input_modalities: ['text'] },
                { id: 'openrouter/vl', architecture: { input_modalities: ['TEXT', 'Image'] } },
                // An older hub: no modalities at all.
                { id: 'gpt-5' },
              ],
            },
          }
        : undefined,
    );
    const conn = new HubConnection(link(null), { store: store(), fetch });
    expect(await gatewayModels(conn)).toEqual({
      ok: true,
      models: [
        {
          id: 'chatgpt-subscription/gpt-6.2-sol',
          name: null,
          context_window: 400000,
          image: true,
        },
        { id: 'kimi-subscription/kimi-k2', name: null, context_window: null, image: false },
        { id: 'openrouter/vl', name: null, context_window: null, image: true },
        { id: 'gpt-5', name: null, context_window: null, image: false },
      ],
    });
    expect(seen[0]!.headers.authorization).toBe('Bearer hub_at_1');
  });

  it('says the entrance is off (403, OpenAI envelope) or missing on an older hub (404)', async () => {
    for (const [status, reason] of [
      [403, 'off'],
      [404, 'missing'],
      [503, 'unreachable'],
    ] as const) {
      const { fetch } = fakeFetch(() => ({
        status,
        json: {
          error: {
            message: 'the external entrance is off',
            type: 'permission_error',
            code: 'permission_error',
          },
        },
      }));
      const conn = new HubConnection(link(null), { store: store(), fetch });
      expect(await gatewayModels(conn)).toMatchObject({
        ok: false,
        reason,
        detail: 'the external entrance is off',
      });
    }
  });
});
