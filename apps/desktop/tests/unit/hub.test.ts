// Asking a hub "are you a Core Hub" and claiming a pairing, over the generated client.
import { describe, expect, it } from 'vitest';
import { claimPairing, devicePlatform, probeHub } from '../../src/main/hub.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('probe', () => {
  it('knows a Core Hub by its contract', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return json({ name: 'Core Hub', server_version: '0.2.0', api_versions: ['v1'] });
    }) as unknown as typeof fetch;
    expect(await probeHub('https://hub.example', fetchImpl)).toEqual({
      ok: true,
      name: 'Core Hub',
      serverVersion: '0.2.0',
    });
    expect(seen).toEqual(['https://hub.example/api/v1/meta']);
  });

  it('tells "nothing answered" from "something that is not a hub answered"', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await probeHub('https://hub.example', down)).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    const html = (async () =>
      new Response('<html>router</html>', {
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    expect(await probeHub('https://hub.example', html)).toEqual({ ok: false, reason: 'not_a_hub' });
    const notFound = (async () =>
      json({ error: 'no', code: 'not_found' }, 404)) as unknown as typeof fetch;
    expect(await probeHub('https://hub.example', notFound)).toEqual({
      ok: false,
      reason: 'not_a_hub',
    });
    const other = (async () =>
      json({ name: 'x', api_versions: ['v9'] })) as unknown as typeof fetch;
    expect(await probeHub('https://hub.example', other)).toEqual({
      ok: false,
      reason: 'not_a_hub',
    });
  });
});

describe('pairing', () => {
  const pairing = {
    hub: 'https://hub.example',
    pairingId: '01J8QK3ZR2W7M5N4P6T8V9X0PR',
    code: '7KQ2-M9XW',
  };
  const computer = {
    deviceKey: 'key-123456',
    name: 'laptop',
    platform: 'darwin' as const,
    appVersion: '1.0.0',
    model: 'Darwin 25',
  };

  it('describes this computer and turns the answer into the web client’s session', async () => {
    let sent: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      return json(
        {
          app_token: 'hub_at_abc',
          token_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
          expires_at: '2026-12-20T11:16:00Z',
          device: { id: '01J8QK3ZR2W7M5N4P6T8V9X0DV' },
          user: {
            id: 'U1',
            username: 'tariq',
            display_name: 'Tariq',
            role: 'owner',
            profiles: ['default', 'work'],
            default_profile: 'work',
          },
          server: {},
        },
        201,
      );
    }) as unknown as typeof fetch;
    const result = await claimPairing(pairing, computer, fetchImpl);
    expect(sent!.url).toBe(`https://hub.example/api/v1/auth/pairings/${pairing.pairingId}/claim`);
    expect(sent!.body).toEqual({
      code: '7KQ2-M9XW',
      device: {
        device_key: 'key-123456',
        name: 'laptop',
        platform: 'macos',
        kind: 'computer',
        brand: null,
        model: 'Darwin 25',
        app_version: '1.0.0',
        capabilities: ['notifications'],
      },
    });
    expect(result).toEqual({
      ok: true,
      hub: 'https://hub.example',
      // The app keeps the device and the person's profiles to answer the hub itself (ADR 0025).
      deviceId: '01J8QK3ZR2W7M5N4P6T8V9X0DV',
      profiles: ['default', 'work'],
      session: {
        profile: 'work',
        token: 'hub_at_abc',
        refresh_token: null,
        expires_at: '2026-12-20T11:16:00Z',
        user: { id: 'U1', username: 'tariq', display_name: 'Tariq', role: 'owner' },
      },
    });
  });

  it('passes the hub’s own words on when it refuses', async () => {
    const fetchImpl = (async () =>
      json({ error: 'الرمز غير صحيح', code: 'unauthorized' }, 401)) as unknown as typeof fetch;
    expect(await claimPairing(pairing, computer, fetchImpl)).toEqual({
      ok: false,
      message: 'الرمز غير صحيح',
    });
  });

  it('names the platform the way the contract does', () => {
    expect(devicePlatform('darwin')).toBe('macos');
    expect(devicePlatform('win32')).toBe('windows');
    expect(devicePlatform('linux')).toBe('linux');
  });
});
