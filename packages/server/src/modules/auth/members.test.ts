// A member enters only the workspaces they were given (owner, 2026-09-24: «انا كنت فاتح يوزر
// fff لما فتحت بروفايل جديد اضافه لليوزر fff مع انه مهب ادمن؟»). Nothing is granted implicitly:
// not by an empty list, not by a workspace created later, not by archiving the last one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

type Hub = TestHub & { token: string; userId: string };

describe('auth: a member enters only the profiles explicitly granted', () => {
  let hub: Hub;
  let adminToken: string;

  const login = async (username: string, password: string) => {
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { access_token: string; user: { profiles: string[] } };
  };
  const asOwner = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    authed(hub, hub.token, { method, url, ...(payload !== undefined ? { payload } : {}) });
  const createProfile = async (slug: string) => {
    const res = await asOwner('POST', '/api/v1/profiles', { slug, name: slug.toUpperCase() });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; slug: string };
  };
  const createUser = async (body: Record<string, unknown>) => {
    const res = await asOwner('POST', '/api/v1/auth/users', body);
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; profiles: string[] };
  };
  const slugsFor = async (token: string) => {
    const res = await authed(hub, token, { method: 'GET', url: '/api/v1/profiles' });
    expect(res.statusCode).toBe(200);
    return (res.json().items as { slug: string }[]).map((p) => p.slug);
  };

  beforeAll(async () => {
    hub = await signedInHub();
    await createUser({ username: 'adm', password: 'adm-password-1', role: 'admin' });
    adminToken = (await login('adm', 'adm-password-1')).access_token;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('a profile the owner creates while a member is signed in is not offered to them', async () => {
    // The owner's exact report: fff has `default`, is signed in, and the owner adds a profile.
    await createUser({
      username: 'fff',
      password: 'fff-password-1',
      role: 'member',
      profiles: ['default'],
    });
    const fff = (await login('fff', 'fff-password-1')).access_token;
    expect(await slugsFor(fff)).toEqual(['default']);

    const fresh = await createProfile('fresh');

    expect(await slugsFor(fff)).toEqual(['default']);
    const me = await authed(hub, fff, { method: 'GET', url: '/api/v1/auth/me' });
    expect(me.json().profiles).toEqual(['default']);
    const byId = await authed(hub, fff, { method: 'GET', url: `/api/v1/profiles/${fresh.id}` });
    expect(byId.statusCode).toBe(404);
    expect(byId.json().code).toBe('profile_not_found');
    const scoped = await authed(hub, fff, {
      method: 'GET',
      url: '/api/v1/sessions',
      profile: 'fresh',
    });
    expect(scoped.statusCode).toBe(404);
    expect(scoped.json()).toMatchObject({
      code: 'profile_not_found',
      details: { profile: 'fresh' },
    });
    // The users table (what the owner reads) names their grant, not what exists.
    const table = await asOwner('GET', '/api/v1/auth/users');
    const row = (table.json().items as { username: string; profiles: string[] }[]).find(
      (u) => u.username === 'fff',
    );
    expect(row?.profiles).toEqual(['default']);
    // What they were given still works.
    const own = await authed(hub, fff, { method: 'GET', url: '/api/v1/sessions' });
    expect(own.statusCode).toBe(200);

    // The owner and an admin still enter every profile, the new one included.
    expect(await slugsFor(hub.token)).toContain('fresh');
    expect(await slugsFor(adminToken)).toContain('fresh');
    const adminScoped = await authed(hub, adminToken, {
      method: 'GET',
      url: '/api/v1/sessions',
      profile: 'fresh',
    });
    expect(adminScoped.statusCode).toBe(200);
  });

  it('a member cannot be created with no profile: the list is required and explicit', async () => {
    for (const body of [
      { username: 'none1', password: 'none-password-1', role: 'member' },
      { username: 'none2', password: 'none-password-1', role: 'member', profiles: [] },
    ]) {
      const res = await asOwner('POST', '/api/v1/auth/users', body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'validation_failed',
        details: { field: 'profiles' },
      });
    }
    // An admin needs none: they enter every profile.
    const admin = await asOwner('POST', '/api/v1/auth/users', {
      username: 'adm2',
      password: 'adm2-password-1',
      role: 'admin',
    });
    expect(admin.statusCode).toBe(201);
  });

  it('making an admin a member names their profiles in the same request', async () => {
    const promoted = await createUser({
      username: 'demoted',
      password: 'demoted-password-1',
      role: 'admin',
    });
    // A bare role change would leave a member with no list (formerly: with every profile).
    for (const payload of [{ role: 'member' }, { role: 'member', profiles: [] }]) {
      const bare = await asOwner('PATCH', `/api/v1/auth/users/${promoted.id}`, payload);
      expect(bare.statusCode).toBe(400);
      expect(bare.json()).toMatchObject({
        code: 'validation_failed',
        details: { field: 'profiles' },
      });
    }
    const still = await asOwner('GET', `/api/v1/auth/users/${promoted.id}`);
    expect(still.json().role).toBe('admin');

    const demoted = await asOwner('PATCH', `/api/v1/auth/users/${promoted.id}`, {
      role: 'member',
      profiles: ['default'],
    });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json()).toMatchObject({ role: 'member', profiles: ['default'] });
    const token = (await login('demoted', 'demoted-password-1')).access_token;
    expect(await slugsFor(token)).toEqual(['default']);
    const outside = await authed(hub, token, {
      method: 'GET',
      url: '/api/v1/sessions',
      profile: 'fresh',
    });
    expect(outside.statusCode).toBe(404);
  });

  it('a member whose list is empty signs in and enters nothing, with a reason', async () => {
    const user = await createUser({
      username: 'empty',
      password: 'empty-password-1',
      role: 'member',
      profiles: ['default'],
    });
    const cleared = await asOwner('PATCH', `/api/v1/auth/users/${user.id}`, { profiles: [] });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().profiles).toEqual([]);

    const session = await login('empty', 'empty-password-1');
    expect(session.user.profiles).toEqual([]);
    expect(await slugsFor(session.access_token)).toEqual([]);
    for (const profile of ['default', 'fresh']) {
      const refused = await authed(hub, session.access_token, {
        method: 'GET',
        url: '/api/v1/sessions',
        profile,
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toMatchObject({
        code: 'profile_not_found',
        details: { profile, reason: 'no_profile_granted' },
      });
    }
    // The global pages answer "nothing", not everything and not an error.
    const board = await authed(hub, session.access_token, {
      method: 'GET',
      url: '/api/v1/task-columns',
    });
    expect(board.statusCode).toBe(200);
    const schedules = await authed(hub, session.access_token, {
      method: 'GET',
      url: '/api/v1/schedules',
    });
    expect(schedules.statusCode).toBe(200);
    expect(schedules.json().items).toEqual([]);
  });

  it('archiving a member’s only profile leaves them with none, not with every profile', async () => {
    const labs = await createProfile('labs');
    await createUser({
      username: 'labsonly',
      password: 'labs-password-1',
      role: 'member',
      profiles: ['labs'],
    });
    const token = (await login('labsonly', 'labs-password-1')).access_token;
    expect(await slugsFor(token)).toEqual(['labs']);

    const archived = await asOwner('DELETE', `/api/v1/profiles/${labs.id}`);
    expect(archived.statusCode).toBe(204);

    expect(await slugsFor(token)).toEqual([]);
    const me = await authed(hub, token, { method: 'GET', url: '/api/v1/auth/me' });
    expect(me.json().profiles).toEqual([]);
    const refused = await authed(hub, token, {
      method: 'GET',
      url: '/api/v1/sessions',
      profile: 'default',
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().details).toMatchObject({ reason: 'no_profile_granted' });
    const list = await asOwner('GET', '/api/v1/auth/users');
    const row = (list.json().items as { username: string; profiles: string[] }[]).find(
      (u) => u.username === 'labsonly',
    );
    expect(row?.profiles).toEqual([]);
  });
});
