/**
 * Agent pictures through the hub's routes: `agents.update` stores a PNG or JPEG data URL,
 * `agents.getAvatar` serves it (it was the contract's 501 stub), the agent then reads
 * `avatar.kind = image`, and `generated` puts the drawn one back. Before this change
 * `agents.update` refused any avatar.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { sniffAvatarMime } from './avatars.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function boot(): Promise<{ h: Hub; agent: string }> {
  hub = await signedInHub();
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string }> }).items[0]!.id;
  return { h: hub, agent };
}

describe('agent pictures', () => {
  it('stores an uploaded picture, serves it, and goes back to the drawn one', async () => {
    const { h, agent } = await boot();
    const before = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/avatar`,
    });
    expect(before.statusCode).toBe(404);

    const set = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}`,
      payload: {
        avatar: { kind: 'image', data_url: `data:image/png;base64,${PNG.toString('base64')}` },
      },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({
      avatar: { kind: 'image', url: `/api/v1/agents/${agent}/avatar`, seed: null },
    });

    const image = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/avatar`,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.equals(PNG)).toBe(true);

    // Every profile reads the same picture: the registry is the hub's.
    const listed = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
    const row = (
      listed.json() as { items: Array<{ id: string; avatar: { kind: string } }> }
    ).items.find((item) => item.id === agent)!;
    expect(row.avatar.kind).toBe('image');

    const reset = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}`,
      payload: { avatar: { kind: 'generated' } },
    });
    expect(reset.json()).toMatchObject({ avatar: { kind: 'generated', url: null } });
    const gone = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/avatar` });
    expect(gone.statusCode).toBe(404);
  });

  it('refuses a picture that is not a PNG or JPEG data URL, and changes nothing', async () => {
    const { h, agent } = await boot();
    const bad = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}`,
      payload: {
        name: 'Renamed',
        avatar: { kind: 'image', data_url: 'data:image/gif;base64,R0lGOD' },
      },
    });
    expect(bad.statusCode).toBe(400);
    const read = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}` });
    expect(read.json()).toMatchObject({ avatar: { kind: 'generated' } });
    expect((read.json() as { name: string }).name).not.toBe('Renamed');
  });

  it('reads the type from the file itself', () => {
    expect(sniffAvatarMime(PNG)).toBe('image/png');
    expect(sniffAvatarMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffAvatarMime(Buffer.from('GIF89a'))).toBeNull();
  });
});
