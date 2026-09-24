// First run with the open window (ADR 0019): for `COREHUB_SETUP_OPEN_MINUTES` after the process
// starts with no owner, setup needs no token; after it, the claim token again; a restart opens
// a fresh window; `0` is token only; two racing setups make one owner; and
// `COREHUB_RESET_OWNER=1` disables the owner once and reopens setup. Time is faked (`Date`
// only), so "an hour later" is one line and not an hour.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authed, capturingLogger, testHub } from '../../../tests/unit/helpers.js';
import { OWNER_RESET_MARKER, SETUP_TOKEN_FILE } from './setup.js';

const T0 = new Date('2026-09-25T09:00:00.000Z');
const MINUTE = 60_000;
const OWNER = { username: 'tariq', password: 'a-good-owner-password' };

type Hub = Awaited<ReturnType<typeof testHub>>;

const meta = async (hub: Hub) =>
  (await hub.app.inject({ method: 'GET', url: '/api/v1/meta' })).json() as {
    setup_required: boolean;
    setup_open: boolean;
    setup_open_until: string | null;
  };
const setup = (hub: Hub, payload: Record<string, unknown>, language = 'en') =>
  hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { 'accept-language': language },
    payload,
  });
const login = (hub: Hub, username: string, password: string) =>
  hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
const tokenOf = (dataDir: string) =>
  readFileSync(path.join(dataDir, SETUP_TOKEN_FILE), 'utf8').trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('auth: first-run setup is open for a window after boot (ADR 0019)', () => {
  it('inside the window whoever arrives first creates the owner with no token', async () => {
    const { logger, lines } = capturingLogger();
    const hub = await testHub({}, { logger });
    try {
      expect(await meta(hub)).toMatchObject({
        setup_required: true,
        setup_open: true,
        setup_open_until: new Date(T0.getTime() + 60 * MINUTE).toISOString(),
      });
      // The boot log says it is open, until when, and still carries the fallback token.
      const logged = String(lines.find((l) => String(l.msg).includes('first-run setup'))!.msg);
      expect(logged).toContain('OPEN to whoever opens the hub first until 2026-09-25T10:00:00.000Z');
      expect(logged).toContain(tokenOf(hub.dataDir));

      vi.setSystemTime(T0.getTime() + 59 * MINUTE);
      const created = await setup(hub, { ...OWNER, display_name: 'طارق' });
      expect(created.statusCode).toBe(200);
      expect(created.json().user).toMatchObject({ username: 'tariq', role: 'owner' });
      expect(existsSync(path.join(hub.dataDir, SETUP_TOKEN_FILE))).toBe(false);

      // Closed for good: meta says so, and a second setup is 409 even inside the window.
      expect(await meta(hub)).toMatchObject({
        setup_required: false,
        setup_open: false,
        setup_open_until: null,
      });
      expect((await setup(hub, { username: 'second', password: OWNER.password })).statusCode).toBe(
        409,
      );
    } finally {
      await hub.close();
    }
  });

  it('after the window the token is required again, and it still works', async () => {
    const hub = await testHub();
    try {
      vi.setSystemTime(T0.getTime() + 60 * MINUTE);
      expect(await meta(hub)).toMatchObject({
        setup_required: true,
        setup_open: false,
        setup_open_until: null,
      });
      const noToken = await setup(hub, OWNER);
      expect(noToken.statusCode).toBe(401);
      expect(noToken.json()).toEqual({
        error:
          'First-run setup is no longer open without the setup token. Paste the token from the hub log, or restart the hub to open setup again for a while.',
        code: 'unauthorized',
      });
      expect((await setup(hub, { ...OWNER, token: 'f'.repeat(48) })).statusCode).toBe(401);
      const withToken = await setup(hub, { ...OWNER, token: tokenOf(hub.dataDir) });
      expect(withToken.statusCode).toBe(200);
    } finally {
      await hub.close();
    }
  });

  it('a restart opens a fresh window, so nobody needs the terminal', async () => {
    const first = await testHub();
    const { dataDir } = first;
    vi.setSystemTime(T0.getTime() + 3 * 60 * MINUTE);
    expect((await setup(first, OWNER)).statusCode).toBe(401);
    await first.app.close();

    const second = await testHub({ DATA_DIR: dataDir });
    try {
      expect(await meta(second)).toMatchObject({
        setup_open: true,
        setup_open_until: new Date(T0.getTime() + 4 * 60 * MINUTE).toISOString(),
      });
      expect((await setup(second, OWNER)).statusCode).toBe(200);
    } finally {
      await second.close();
    }
  });

  it('COREHUB_SETUP_OPEN_MINUTES=0 is token only from the first second', async () => {
    const hub = await testHub({ COREHUB_SETUP_OPEN_MINUTES: '0' });
    try {
      expect(await meta(hub)).toMatchObject({
        setup_required: true,
        setup_open: false,
        setup_open_until: null,
      });
      expect((await setup(hub, OWNER)).statusCode).toBe(401);
      expect((await setup(hub, { ...OWNER, token: tokenOf(hub.dataDir) })).statusCode).toBe(200);
    } finally {
      await hub.close();
    }
  });

  it('two setups at once: exactly one owner, the other is 409', async () => {
    const hub = await testHub();
    try {
      const [a, b] = await Promise.all([
        setup(hub, { username: 'first', password: OWNER.password }),
        setup(hub, { username: 'second', password: OWNER.password }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = (a.statusCode === 200 ? a : b).json();
      const users = await authed(hub, winner.access_token, {
        method: 'GET',
        url: '/api/v1/auth/users',
      });
      const items = users.json().items as { username: string; role: string }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.role).toBe('owner');
    } finally {
      await hub.close();
    }
  });
});

describe('auth: COREHUB_RESET_OWNER=1 (ADR 0019)', () => {
  it('disables the owner, keeps everyone else, reopens setup — once', async () => {
    // A hub in use: its owner, one admin, and the owner's live session.
    const first = await testHub();
    const { dataDir } = first;
    const owner = (await setup(first, OWNER)).json();
    const admin = await authed(first, owner.access_token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: { username: 'noura', password: 'admin-password-1', role: 'admin' },
    });
    expect(admin.statusCode).toBe(201);
    await first.app.close();

    // Somebody else got there first; the operator restarts with the variable set.
    vi.setSystemTime(T0.getTime() + 24 * 60 * MINUTE);
    const { logger, lines } = capturingLogger();
    const reset = await testHub({ DATA_DIR: dataDir, COREHUB_RESET_OWNER: '1' }, { logger });
    let newOwnerToken: string;
    try {
      const warning = lines.find((l) => String(l.msg).includes('OWNER RESET'));
      expect(warning?.level).toBe(40);
      expect(String(warning!.msg)).toContain(owner.user.id);
      expect(String(warning!.msg)).toContain('Remove COREHUB_RESET_OWNER');
      const marker = JSON.parse(readFileSync(path.join(dataDir, OWNER_RESET_MARKER), 'utf8'));
      expect(marker).toEqual({
        reset_at: new Date(T0.getTime() + 24 * 60 * MINUTE).toISOString(),
        disabled_owner_ids: [owner.user.id],
      });

      // The old owner's session is gone and setup is open again, with a fresh window.
      const refresh = await reset.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: owner.refresh_token },
      });
      expect(refresh.statusCode).toBe(401);
      expect(await meta(reset)).toMatchObject({ setup_required: true, setup_open: true });

      // The old owner's name is still taken: nothing was deleted.
      expect((await setup(reset, OWNER)).statusCode).toBe(409);
      const claimed = await setup(reset, { username: 'rightful', password: OWNER.password });
      expect(claimed.statusCode).toBe(200);
      newOwnerToken = claimed.json().access_token as string;

      const users = await authed(reset, newOwnerToken, { method: 'GET', url: '/api/v1/auth/users' });
      const byName = Object.fromEntries(
        (users.json().items as { id: string; username: string; role: string; status: string }[]).map(
          (u) => [u.username, u],
        ),
      );
      expect(byName.tariq).toMatchObject({ role: 'admin', status: 'disabled' });
      expect(byName.noura).toMatchObject({ role: 'admin', status: 'active' });
      expect(byName.rightful).toMatchObject({ role: 'owner', status: 'active' });
      expect((await login(reset, 'tariq', OWNER.password)).statusCode).toBe(401);
      expect((await login(reset, 'noura', 'admin-password-1')).statusCode).toBe(200);
      // The new owner decides about the old one: re-enable it here (deleting works too).
      const enable = await authed(reset, newOwnerToken, {
        method: 'PATCH',
        url: `/api/v1/auth/users/${byName.tariq!.id}`,
        payload: { status: 'active' },
      });
      expect(enable.statusCode).toBe(200);
    } finally {
      await reset.app.close();
    }

    // The variable was left in the compose file: the marker stops a second reset.
    const again = await testHub({ DATA_DIR: dataDir, COREHUB_RESET_OWNER: '1' }, { logger });
    try {
      expect((await meta(again)).setup_required).toBe(false);
      expect((await login(again, 'rightful', OWNER.password)).statusCode).toBe(200);
      expect(lines.some((l) => String(l.msg).includes('the reset already ran'))).toBe(true);
    } finally {
      await again.app.close();
    }

    // A boot without it removes the marker, so a later reset would work again.
    const plain = await testHub({ DATA_DIR: dataDir });
    try {
      expect(existsSync(path.join(dataDir, OWNER_RESET_MARKER))).toBe(false);
      expect((await meta(plain)).setup_required).toBe(false);
    } finally {
      await plain.close();
    }
  });
});
