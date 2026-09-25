/**
 * A profile's automatic context compression is Hermes's, where the hub supervises Hermes
 * (decision §52): `auth.getProfileSettings` reads it from the runtime, and
 * `auth.updateProfileSettings` writes it there before storing it — a value the runtime
 * refused is never reported as saved. The runtime is a recording fake of the mirror port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileMirrorError,
  registerProfileMirror,
  type ProfileMirror,
  type RuntimeCompression,
} from '../../src/modules/auth/index.js';
import { authed, signedInHub } from './helpers.js';

type Hub = Awaited<ReturnType<typeof signedInHub>>;

const HERMES: RuntimeCompression = {
  enabled: true,
  threshold: 0.5,
  targetRatio: 0.2,
  protectFirst: 3,
  protectLast: 20,
  contextLength: null,
};

function fakeRuntime(initial: RuntimeCompression) {
  const files = new Map<string, RuntimeCompression>([['default', { ...initial }]]);
  const writes: Array<{ name: string; settings: RuntimeCompression }> = [];
  let refuse: string | null = null;
  const mirror: ProfileMirror = {
    list: async () => [],
    create: async () => undefined,
    setDisplayName: async () => undefined,
    readCompression: (name) => files.get(name) ?? null,
    writeCompression(name, settings) {
      if (refuse) throw new ProfileMirrorError(refuse);
      writes.push({ name, settings });
      files.set(name, { ...settings });
    },
  };
  return { mirror, files, writes, refuseWith: (message: string) => (refuse = message) };
}

let previous: ReturnType<typeof registerProfileMirror> = null;
let hub: Hub;
beforeEach(() => {
  previous = registerProfileMirror(null);
});
afterEach(async () => {
  registerProfileMirror(previous);
  await hub?.close();
});

async function defaultProfileId(h: Hub): Promise<string> {
  const res = await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' });
  const items = (res.json() as { items: Array<{ id: string; slug: string }> }).items;
  return (items.find((item) => item.slug === 'default') ?? items[0])!.id;
}

describe("a profile's compression settings are Hermes's", () => {
  it('reads what the runtime has, including a window set by hand', async () => {
    const runtime = fakeRuntime({ ...HERMES, threshold: 0.8, contextLength: 64_000 });
    registerProfileMirror(() => runtime.mirror);
    hub = await signedInHub();
    const id = await defaultProfileId(hub);
    const res = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/profiles/${id}/settings`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { compression: unknown }).compression).toEqual({
      enabled: true,
      threshold: 0.8,
      target_ratio: 0.2,
      protect_first: 3,
      protect_last: 20,
      context_length: 64_000,
    });
  });

  it('writes a change to the runtime, merged onto what it has, then reports it', async () => {
    const runtime = fakeRuntime({ ...HERMES, protectLast: 40 });
    registerProfileMirror(() => runtime.mirror);
    hub = await signedInHub();
    const id = await defaultProfileId(hub);
    const res = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/profiles/${id}/settings`,
      payload: { compression: { threshold: 0.7, context_length: 128_000 } },
    });
    expect(res.statusCode).toBe(200);
    expect(runtime.writes).toEqual([
      {
        name: 'default',
        settings: { ...HERMES, protectLast: 40, threshold: 0.7, contextLength: 128_000 },
      },
    ]);
    expect((res.json() as { settings: { compression: unknown } }).settings.compression).toEqual({
      enabled: true,
      threshold: 0.7,
      target_ratio: 0.2,
      protect_first: 3,
      protect_last: 40,
      context_length: 128_000,
    });
  });

  it('refuses when the runtime cannot take it, and stores nothing', async () => {
    const runtime = fakeRuntime(HERMES);
    runtime.refuseWith('the config.yaml of Hermes profile "default" is not valid YAML');
    registerProfileMirror(() => runtime.mirror);
    hub = await signedInHub();
    const id = await defaultProfileId(hub);
    const res = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/profiles/${id}/settings`,
      payload: { compression: { enabled: false } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'runtime_config_unwritable', section: 'compression' },
    });
    registerProfileMirror(null);
    const after = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/profiles/${id}/settings`,
    });
    expect((after.json() as { compression: { enabled: boolean } }).compression.enabled).toBe(true);
  });

  it('without a runtime, the hub keeps the values itself, window included', async () => {
    hub = await signedInHub();
    const id = await defaultProfileId(hub);
    const res = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/profiles/${id}/settings`,
      payload: { compression: { context_length: 32_000 } },
    });
    expect(res.statusCode).toBe(200);
    const bad = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/profiles/${id}/settings`,
      payload: { compression: { context_length: 10 } },
    });
    expect(bad.statusCode).toBe(400);
    const after = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/profiles/${id}/settings`,
    });
    expect(
      (after.json() as { compression: { context_length: number } }).compression.context_length,
    ).toBe(32_000);
  });
});
