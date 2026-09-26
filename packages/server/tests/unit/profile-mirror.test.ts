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
import { authed, signedInHub, testHub } from './helpers.js';

type Hub = Awaited<ReturnType<typeof signedInHub>>;

function fakeMirror(profiles: string[] = [], displayNames?: Record<string, string>) {
  const created: Array<{ name: string; origin: ProfileOrigin }> = [];
  const named: Array<{ name: string; displayName: string }> = [];
  let refuse: string | null = null;
  let refuseName: string | null = null;
  const mirror: ProfileMirror = {
    list: async () => [...profiles],
    ...(displayNames ? { displayName: (name: string) => displayNames[name] ?? '' } : {}),
    async create(name, origin) {
      if (refuse) throw new ProfileMirrorError(refuse);
      created.push({ name, origin });
      profiles.push(name);
    },
    async setDisplayName(name, displayName) {
      if (refuseName) throw new ProfileMirrorError(refuseName);
      named.push({ name, displayName });
    },
  };
  return {
    mirror,
    created,
    named,
    refuseWith: (message: string) => (refuse = message),
    refuseNamesWith: (message: string) => (refuseName = message),
  };
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

const listed = async (h: Hub) =>
  (
    (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' })).json() as {
      items: Array<{ id: string; slug: string; name: string }>;
    }
  ).items;

const patch = (h: Hub, id: string, payload: Record<string, unknown>) =>
  authed(h, h.token, { method: 'PATCH', url: `/api/v1/profiles/${id}`, payload });

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

describe("a profile's name is Hermes's display name; its id never changes", () => {
  it('renames the default profile: Hermes is told the name, the id stays `default`', async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    const main = (await listed(hub)).find((item) => item.slug === 'default')!;

    const renamed = await patch(hub, main.id, { name: '  الرئيسي ' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: main.id, slug: 'default', name: 'الرئيسي' });
    // `hermes profile rename default <name>`: Hermes's id for it stays `default`.
    expect(fake.named).toEqual([{ name: 'default', displayName: 'الرئيسي' }]);
    expect((await listed(hub)).find((item) => item.id === main.id)).toMatchObject({
      slug: 'default',
      name: 'الرئيسي',
    });
  });

  it('renames a named profile without moving it: same slug, same Hermes folder', async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    const made = (await create(hub, { slug: 'design', name: 'Design' })).json() as { id: string };
    fake.named.length = 0;

    const renamed = await patch(hub, made.id, { name: 'فريق التصميم' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ slug: 'design', name: 'فريق التصميم' });
    // Named back to its id, Hermes shows the bare id: the display name is cleared.
    expect((await patch(hub, made.id, { name: 'design' })).statusCode).toBe(200);
    expect(fake.named).toEqual([
      { name: 'design', displayName: 'فريق التصميم' },
      { name: 'design', displayName: '' },
    ]);
    // Nothing asked Hermes to make or move a profile.
    expect(fake.created.map((entry) => entry.name)).toEqual(['design']);
    expect(await slugs(hub)).toContain('design');
  });

  it('refuses a new slug for a Hermes profile, before Hermes is told anything', async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    const made = (await create(hub, { slug: 'design', name: 'Design' })).json() as { id: string };
    fake.named.length = 0;

    const moved = await patch(hub, made.id, { slug: 'studio', name: 'Studio' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({
      code: 'conflict',
      details: { reason: 'profile_id_fixed' },
    });
    expect(fake.named).toEqual([]);
    expect((await listed(hub)).find((item) => item.id === made.id)).toMatchObject({
      slug: 'design',
      name: 'Design',
    });
    // The default profile's slug is refused the way it always was, Hermes untouched.
    const main = (await listed(hub)).find((item) => item.slug === 'default')!;
    const fixed = await patch(hub, main.id, { slug: 'home', name: 'Home' });
    expect(fixed.statusCode).toBe(409);
    expect(fake.named).toEqual([]);
  });

  it("keeps the old name when Hermes refuses the new one, and says Hermes's words", async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    const main = (await listed(hub)).find((item) => item.slug === 'default')!;
    fake.refuseNamesWith('Error: Display name too long (70 chars, max 64).');

    const refused = await patch(hub, main.id, { name: 'X' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      details: {
        reason: 'hermes_refused',
        message: 'Error: Display name too long (70 chars, max 64).',
      },
    });
    expect((await listed(hub)).find((item) => item.id === main.id)?.name).toBe(main.name);
  });

  it("takes a name only as long as Hermes's display name (64)", async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    const main = (await listed(hub)).find((item) => item.slug === 'default')!;
    expect((await patch(hub, main.id, { name: 'ن'.repeat(65) })).statusCode).toBe(400);
    expect((await patch(hub, main.id, { name: '   ' })).statusCode).toBe(400);
    expect((await patch(hub, main.id, { name: 'ن'.repeat(64) })).statusCode).toBe(200);
    expect((await create(hub, { slug: 'long', name: 'a'.repeat(65) })).statusCode).toBe(400);
  });

  it('tells Hermes the name a new profile was given', async () => {
    const fake = fakeMirror();
    registerProfileMirror(() => fake.mirror);
    hub = await signedInHub();
    expect((await create(hub, { slug: 'design', name: 'التصميم' })).statusCode).toBe(201);
    expect(fake.named).toEqual([{ name: 'design', displayName: 'التصميم' }]);
  });

  it('renames and moves a slug freely where there is no Hermes to mirror', async () => {
    hub = await signedInHub();
    const made = (await create(hub, { slug: 'labs', name: 'Labs' })).json() as { id: string };
    const moved = await patch(hub, made.id, { slug: 'lab', name: 'المختبر' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ slug: 'lab', name: 'المختبر' });
  });
});

describe('names are read from Hermes (§102)', () => {
  it("adds a Hermes profile under Hermes's display name, and its id when it has none", async () => {
    registerProfileMirror(
      () => fakeMirror(['design', 'ops'], { design: 'فريق التصميم', ops: '' }).mirror,
    );
    hub = await signedInHub();
    const names = new Map((await listed(hub)).map((row) => [row.slug, row.name]));
    expect(names.get('design')).toBe('فريق التصميم');
    expect(names.get('ops')).toBe('ops');
  });

  it('takes a name changed on Hermes’s side, and leaves a name Hermes does not have', async () => {
    const hermesNames: Record<string, string> = { default: '' };
    registerProfileMirror(() => fakeMirror(['design'], hermesNames).mirror);
    hub = await signedInHub();
    const before = new Map((await listed(hub)).map((row) => [row.slug, row.name]));
    // No display name on Hermes's side: the hub's own names stand.
    expect(before.get('default')).toBe('Default');
    expect(before.get('design')).toBe('design');

    // Renamed with `hermes profile rename`, or on Hermes's dashboard.
    hermesNames.default = 'الرئيسي';
    hermesNames.design = 'Design Team';
    const after = new Map((await listed(hub)).map((row) => [row.slug, row.name]));
    expect(after.get('default')).toBe('الرئيسي');
    expect(after.get('design')).toBe('Design Team');
  });

  it('writes the name given at first-run setup as Hermes’s name for `default`', async () => {
    const fake = fakeMirror([], {});
    registerProfileMirror(() => fake.mirror);
    hub = await testHub({});
    const made = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { username: 'tariq', password: 'a-good-owner-password', workspace_name: 'بيتي' },
    });
    expect(made.statusCode).toBe(200);
    expect(fake.named).toEqual([{ name: 'default', displayName: 'بيتي' }]);
  });
});
