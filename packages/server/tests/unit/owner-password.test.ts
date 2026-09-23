/**
 * The owner sets any password, their own included, from the users page (owner decision,
 * 2026-09-23: «خل اقدر اعدل باسوورد اي احد حتى حسابي لاني انا سوبر ادمن»). An admin still
 * cannot touch the owner's account, and the owner's role never changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_ADMIN_PASSWORD, authed, signedInHub } from './helpers.js';

type Hub = Awaited<ReturnType<typeof signedInHub>>;
let hub: Hub;
afterEach(async () => hub?.close());

const login = (h: Hub, username: string, password: string) =>
  h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });

describe("the owner's password", () => {
  it('is set by the owner from the users page, and this device stays signed in', async () => {
    hub = await signedInHub();
    const set = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/auth/users/${hub.userId}`,
      payload: { password: 'a-brand-new-password' },
    });
    expect(set.statusCode).toBe(200);
    expect((await login(hub, 'admin', TEST_ADMIN_PASSWORD)).statusCode).toBe(401);
    expect((await login(hub, 'admin', 'a-brand-new-password')).statusCode).toBe(200);
    // The session that made the change is still good.
    const me = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/auth/me' });
    expect(me.statusCode).toBe(200);
  });

  it('is not the business of an admin, and the owner’s role never changes', async () => {
    hub = await signedInHub();
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: { username: 'sara', password: 'sara-password-1', role: 'admin' },
    });
    expect(created.statusCode).toBe(201);
    const sara = (await login(hub, 'sara', 'sara-password-1')).json() as { access_token: string };

    const byAdmin = await authed(hub, sara.access_token, {
      method: 'PATCH',
      url: `/api/v1/auth/users/${hub.userId}`,
      payload: { password: 'taken-over-now' },
    });
    expect(byAdmin.statusCode).toBe(403);

    const demote = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/auth/users/${hub.userId}`,
      payload: { role: 'admin' },
    });
    expect(demote.statusCode).toBe(403);
  });
});
