/**
 * A workspace is a Hermes profile (ADR 0014): created in Hermes first, and a profile Hermes
 * already has listed as a workspace. Across `auth` and the port `modules/index.ts` fills
 * from `agents`, which is why it lives here; the port is a recording fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileMirrorError,
  registerProfileMirror,
  type ProfileMirror,
  type ProfileOrigin,
} from '../../src/modules/auth/index.js';
import { authed, signedInHub } from './helpers.js';

type Hub = Awaited<ReturnType<typeof signedInHub>>;

function fakeMirror(profiles: string[] = []) {
  const created: Array<{ name: string; origin: ProfileOrigin }> = [];
  let refuse: string | null = null;
  const mirror: ProfileMirror = {
    list: async () => [...profiles],
    async create(name, origin) {
      if (refuse) throw new ProfileMirrorError(refuse);
      created.push({ name, origin });
      profiles.push(name);
    },
  };
  return { mirror, created, refuseWith: (message: string) => (refuse = message) };
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

const slugs = async (h: Hub) =>
  (
    (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' })).json() as {
      items: Array<{ slug: string }>;
    }
  ).items.map((item) => item.slug);

const create = (h: Hub, payload: Record<string, unknown>) =>
  authed(h, h.token, { method: 'POST', url: '/api/v1/profiles', payload });

describe('a workspace is a Hermes profile', () => {
  it('is created in Hermes first: from scratch, or as a copy of the one chosen', async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();

    expect((await create(hub, { slug: 'design', name: 'Design' })).statusCode).toBe(201);
    // The hub's default workspace is Hermes's `default`, whatever the owner named it.
    expect(
      (await create(hub, { slug: 'worker', name: 'Worker', clone_from: 'default' })).statusCode,
    ).toBe(201);
    expect(
      (await create(hub, { slug: 'worker-2', name: 'Worker 2', clone_from: 'design' })).statusCode,
    ).toBe(201);

    expect(fake.created).toEqual([
      { name: 'design', origin: { kind: 'blank' } },
      { name: 'worker', origin: { kind: 'clone', source: 'default' } },
      { name: 'worker-2', origin: { kind: 'clone', source: 'design' } },
    ]);
    expect(await slugs(hub)).toEqual(expect.arrayContaining(['design', 'worker', 'worker-2']));
  });

  it("is not created when Hermes says no, and Hermes's words come back", async () => {
    const fake = fakeMirror();
    fake.refuseWith("Error: Profile 'design' already exists");
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();

    const refused = await create(hub, { slug: 'design', name: 'Design' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'conflict',
      details: { reason: 'hermes_refused', message: "Error: Profile 'design' already exists" },
    });
    expect(await slugs(hub)).not.toContain('design');
  });

  it('asks Hermes nothing for a copy of a workspace that does not exist', async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    const response = await create(hub, { slug: 'x', name: 'X', clone_from: 'nowhere' });
    expect(response.statusCode).toBe(400);
    expect(fake.created).toEqual([]);
  });

  it("lists Hermes's own profiles as workspaces, once, and leaves an archived one archived", async () => {
    const fake = fakeMirror(['design', 'worker', 'too_long_or_underscored']);
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();

    const first = await slugs(hub);
    expect(first).toEqual(expect.arrayContaining(['design', 'worker']));
    // A name a workspace slug cannot carry is not shown (the hub's slugs have no `_`).
    expect(first).not.toContain('too_long_or_underscored');
    // Listing again adds nothing twice.
    expect((await slugs(hub)).filter((slug) => slug === 'design')).toHaveLength(1);

    // Archived here, the profile stays in Hermes — and the next listing does not bring it back.
    const design = (
      (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' })).json() as {
        items: Array<{ id: string; slug: string }>;
      }
    ).items.find((item) => item.slug === 'design')!;
    const archived = await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/profiles/${design.id}`,
    });
    expect(archived.statusCode).toBe(204);
    expect(await slugs(hub)).not.toContain('design');
  });

  it('is the hub’s own filter where there is no Hermes to mirror', async () => {
    hub = await signedInHub();
    expect((await create(hub, { slug: 'labs', name: 'Labs' })).statusCode).toBe(201);
    expect(await slugs(hub)).toContain('labs');
  });
});
