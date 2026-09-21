import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defineModule } from '../../lib/module.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { authModule, requireRole, requireUser, requireWorkspace } from './index.js';

const PASSWORD = 'roles-test-password';

/** A pretend sibling module using the exported guards, the way agents/sessions will. */
const probe = defineModule({
  name: 'agents',
  registerRoutes(app: FastifyInstance) {
    app.get('/__probe/user', { preHandler: [requireUser] }, async (request) => ({
      kind: request.principal!.kind,
      user: request.principal!.user.username,
    }));
    app.get('/__probe/admin', { preHandler: [requireUser, requireRole('admin')] }, async () => ({
      ok: true,
    }));
    app.get('/__probe/owner', { preHandler: [requireUser, requireRole('owner')] }, async () => ({
      ok: true,
    }));
    app.get('/__probe/scope', { preHandler: [requireUser, requireWorkspace] }, async (request) => ({
      workspace: request.workspace!.slug,
    }));
  },
  registerEvents() {},
});

describe('auth: roles, principal and workspace scope', () => {
  let hub: TestHub;
  const tokens: Record<string, string> = {};

  const login = async (username: string, password: string) => {
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    return res;
  };
  const get = (url: string, token?: string, profile?: string) =>
    hub.app.inject({
      method: 'GET',
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(profile ? { 'x-hub-profile': profile } : {}),
      },
    });

  beforeAll(async () => {
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: [authModule, probe], contract: null },
    );
    tokens.owner = (await login('admin', PASSWORD)).json().access_token;
    const mk = (body: Record<string, unknown>) =>
      hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/users',
        headers: { authorization: `Bearer ${tokens.owner}` },
        payload: body,
      });
    expect(
      (await mk({ username: 'adm', password: 'adm-password-1', role: 'admin' })).statusCode,
    ).toBe(201);
    const work = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      headers: { authorization: `Bearer ${tokens.owner}` },
      payload: { slug: 'work', name: 'Work' },
    });
    expect(work.statusCode).toBe(201);
    expect(
      (
        await mk({
          username: 'mem',
          password: 'mem-password-1',
          role: 'member',
          profiles: ['work'],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await mk({ username: 'free', password: 'free-password-1', role: 'member' })).statusCode,
    ).toBe(201);
    tokens.admin = (await login('adm', 'adm-password-1')).json().access_token;
    tokens.member = (await login('mem', 'mem-password-1')).json().access_token;
    tokens.free = (await login('free', 'free-password-1')).json().access_token;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('requireUser: no bearer is 401, a bad bearer is 401, a good one exposes the principal', async () => {
    expect((await get('/api/v1/__probe/user')).statusCode).toBe(401);
    const bad = await get('/api/v1/__probe/user', 'not-a-token');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('unauthorized');
    const ok = await get('/api/v1/__probe/user', tokens.member);
    expect(ok.json()).toEqual({ kind: 'user', user: 'mem' });
  });

  it('requireRole: admin is satisfied by owner and admin; owner by the owner only', async () => {
    expect((await get('/api/v1/__probe/admin', tokens.owner)).statusCode).toBe(200);
    expect((await get('/api/v1/__probe/admin', tokens.admin)).statusCode).toBe(200);
    const denied = await get('/api/v1/__probe/admin', tokens.member);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'forbidden', details: { required_role: 'admin' } });
    expect((await get('/api/v1/__probe/owner', tokens.owner)).statusCode).toBe(200);
    expect((await get('/api/v1/__probe/owner', tokens.admin)).statusCode).toBe(403);
  });

  it('requireWorkspace resolves X-Hub-Profile and enforces membership (ADR 0005)', async () => {
    expect((await get('/api/v1/__probe/scope', tokens.member, 'work')).json()).toEqual({
      workspace: 'work',
    });
    const outside = await get('/api/v1/__probe/scope', tokens.member, 'default');
    expect(outside.statusCode).toBe(404);
    expect(outside.json().code).toBe('profile_not_found');
    // a member with no membership rows may enter every workspace (contract: empty = every profile)
    expect((await get('/api/v1/__probe/scope', tokens.free, 'default')).json()).toEqual({
      workspace: 'default',
    });
    expect((await get('/api/v1/__probe/scope', tokens.owner, 'work')).json()).toEqual({
      workspace: 'work',
    });
    expect((await get('/api/v1/__probe/scope', tokens.owner, 'nope')).statusCode).toBe(404);
  });

  it('admin routes: members are refused, the owner account is immutable, self cannot be disabled', async () => {
    expect((await get('/api/v1/auth/users', tokens.member)).statusCode).toBe(403);
    const list = await get('/api/v1/auth/users', tokens.admin);
    expect(list.statusCode).toBe(200);
    const owner = list.json().items.find((u: { role: string }) => u.role === 'owner');
    const adm = list.json().items.find((u: { username: string }) => u.username === 'adm');
    const patchOwner = await hub.app.inject({
      method: 'PATCH',
      url: `/api/v1/auth/users/${owner.id}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { status: 'disabled' },
    });
    expect(patchOwner.statusCode).toBe(403);
    const self = await hub.app.inject({
      method: 'PATCH',
      url: `/api/v1/auth/users/${adm.id}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { status: 'disabled' },
    });
    expect(self.statusCode).toBe(403);
    expect(
      (
        await hub.app.inject({
          method: 'DELETE',
          url: `/api/v1/auth/users/${owner.id}`,
          headers: { authorization: `Bearer ${tokens.admin}` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('a disabled user cannot sign in and existing tokens stop working at once', async () => {
    const list = await get('/api/v1/auth/users', tokens.owner);
    const free = list.json().items.find((u: { username: string }) => u.username === 'free');
    const disable = await hub.app.inject({
      method: 'PATCH',
      url: `/api/v1/auth/users/${free.id}`,
      headers: { authorization: `Bearer ${tokens.owner}` },
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(200);
    expect((await get('/api/v1/auth/me', tokens.free)).statusCode).toBe(401);
    expect((await login('free', 'free-password-1')).statusCode).toBe(401);
  });

  it('locks an IP after five failed passwords and the admin can clear it', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login('adm', 'wrong-password');
      expect(res.statusCode).toBe(i < 4 ? 401 : 401);
    }
    const locked = await login('adm', 'adm-password-1');
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    const lockouts = await get('/api/v1/auth/lockouts', tokens.owner);
    expect(lockouts.json().items).toEqual([
      expect.objectContaining({ kind: 'password', failures: 5, ip: expect.any(String) }),
    ]);
    const cleared = await hub.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/lockouts',
      headers: { authorization: `Bearer ${tokens.owner}` },
    });
    expect(cleared.json()).toEqual({ cleared: 1 });
    expect((await login('adm', 'adm-password-1')).statusCode).toBe(200);
  });

  it('logout revokes the session so the access token dies with it; password change keeps the current one', async () => {
    const first = (await login('adm', 'adm-password-1')).json();
    const second = (await login('adm', 'adm-password-1')).json();
    const change = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/password',
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { current_password: 'adm-password-1', new_password: 'adm-password-2' },
    });
    expect(change.statusCode).toBe(204);
    expect((await get('/api/v1/auth/me', first.access_token)).statusCode).toBe(200);
    expect((await get('/api/v1/auth/me', second.access_token)).statusCode).toBe(401);
    const out = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(out.statusCode).toBe(204);
    expect((await get('/api/v1/auth/me', first.access_token)).statusCode).toBe(401);
    const stale = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: first.refresh_token },
    });
    expect(stale.statusCode).toBe(401);
  });
});
