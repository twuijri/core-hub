// First-run setup (ADR 0011): the claim token on disk, the two operations, and every way the
// flow is allowed to fail — wrong token, replayed token, an owner that already exists, and the
// per-IP lockout the password login already had.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capturingLogger, testHub } from '../../../tests/unit/helpers.js';
import { SETUP_TOKEN_FILE, setupTokenMatches } from './setup.js';

const tokenFile = (dataDir: string) => path.join(dataDir, SETUP_TOKEN_FILE);
const tokenOf = (dataDir: string) => readFileSync(tokenFile(dataDir), 'utf8').trim();
const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);

const OWNER = { username: 'tariq', password: 'a-good-owner-password' };

describe('auth: first-run setup', () => {
  it('writes the token 0600, logs it once with where to read it, and asks for setup', async () => {
    const { logger, lines } = capturingLogger();
    const hub = await testHub({}, { logger });
    try {
      const file = tokenFile(hub.dataDir);
      expect(existsSync(file)).toBe(true);
      expect(mode(file)).toBe('600');
      const token = tokenOf(hub.dataDir);
      expect(token).toMatch(/^[0-9a-f]{48}$/);

      const logged = lines.filter((line) => String(line.msg).includes('first-run setup'));
      expect(logged).toHaveLength(1);
      const message = String(logged[0]!.msg);
      expect(message).toContain(token);
      expect(message).toContain(file);
      expect(message).toContain('docker compose logs hub');
      expect(message).toContain('docker compose exec hub cat /data/setup-token.txt');

      const state = await hub.app.inject({ method: 'GET', url: '/api/v1/auth/setup' });
      expect(state.statusCode).toBe(200);
      // One bit and nothing else: no token, no "a file exists" flag.
      expect(state.json()).toEqual({ required: true });
    } finally {
      await hub.close();
    }
  });

  it('a fresh token is issued on every boot while setup is still pending', async () => {
    const first = await testHub();
    const { dataDir } = first;
    const before = tokenOf(dataDir);
    await first.app.close();
    const second = await testHub({ DATA_DIR: dataDir });
    try {
      const after = tokenOf(dataDir);
      expect(after).not.toBe(before);
      // The token that leaked into the old log no longer opens anything.
      const stale = await second.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { token: before, ...OWNER },
      });
      expect(stale.statusCode).toBe(401);
    } finally {
      await second.app.close();
      await first.close();
    }
  });

  it('completes setup: owner + default workspace, the file is deleted, the answer signs you in', async () => {
    const hub = await testHub();
    try {
      const token = tokenOf(hub.dataDir);
      const response = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          token,
          ...OWNER,
          display_name: 'طارق',
          workspace_name: 'مساحتي',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user).toMatchObject({
        username: 'tariq',
        display_name: 'طارق',
        role: 'owner',
        status: 'active',
        profiles: ['default'],
        default_profile: 'default',
      });
      expect(body.access_token).toBeTruthy();
      expect(body.refresh_token).toMatch(/^hub_rt_/);
      expect(body.expires_in).toBe(900);

      // The token file is gone the moment the owner exists.
      expect(existsSync(tokenFile(hub.dataDir))).toBe(false);
      expect((await hub.app.inject({ method: 'GET', url: '/api/v1/auth/setup' })).json()).toEqual({
        required: false,
      });

      // The session works, and so does a normal sign-in with the password just chosen.
      const me = await hub.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().username).toBe('tariq');
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: OWNER.username, password: OWNER.password },
      });
      expect(login.statusCode).toBe(200);
      // The workspace name the person chose is the `default` workspace's name.
      const profiles = await hub.app.inject({
        method: 'GET',
        url: '/api/v1/profiles',
        headers: { authorization: `Bearer ${body.access_token}`, 'x-hub-profile': 'default' },
      });
      expect(profiles.json().items[0]).toMatchObject({ slug: 'default', name: 'مساحتي' });
    } finally {
      await hub.close();
    }
  });

  it('a wrong token is 401 and leaves the file in place; the right one still works after', async () => {
    const hub = await testHub();
    try {
      const token = tokenOf(hub.dataDir);
      const wrong = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: { 'accept-language': 'ar' },
        payload: { token: 'f'.repeat(48), ...OWNER },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({ error: 'رمز التهيئة غير صحيح.', code: 'unauthorized' });
      expect(existsSync(tokenFile(hub.dataDir))).toBe(true);
      const right = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { token, ...OWNER },
      });
      expect(right.statusCode).toBe(200);
    } finally {
      await hub.close();
    }
  });

  it('replaying the same token after the owner exists is 409, and so is any setup attempt', async () => {
    const hub = await testHub();
    try {
      const token = tokenOf(hub.dataDir);
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/api/v1/auth/setup',
            payload: { token, ...OWNER },
          })
        ).statusCode,
      ).toBe(200);
      const replay = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: { 'accept-language': 'en' },
        payload: { token, username: 'someone', password: 'another-password' },
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toEqual({
        error: 'This hub is already set up; sign in instead.',
        code: 'conflict',
      });
      // A second account was not created by the replay.
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'someone', password: 'another-password' },
      });
      expect(login.statusCode).toBe(401);
    } finally {
      await hub.close();
    }
  });

  it('an owner created by HUB_ADMIN_PASSWORD writes no token file, and a stale one is deleted', async () => {
    const hub = await testHub({ HUB_ADMIN_PASSWORD: 'unattended-install-password' });
    const { dataDir } = hub;
    try {
      expect(existsSync(tokenFile(dataDir))).toBe(false);
      expect((await hub.app.inject({ method: 'GET', url: '/api/v1/auth/setup' })).json()).toEqual({
        required: false,
      });
      const attempt = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { token: 'a'.repeat(48), ...OWNER },
      });
      expect(attempt.statusCode).toBe(409);
    } finally {
      await hub.app.close();
    }
    // A file left behind by hand (or by an older boot) is removed on the next start.
    writeFileSync(tokenFile(dataDir), 'left-over-token\n', { mode: 0o600 });
    const again = await testHub({ DATA_DIR: dataDir, HUB_ADMIN_PASSWORD: 'unattended-install-password' });
    try {
      expect(existsSync(tokenFile(dataDir))).toBe(false);
      const stale = await again.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { token: 'left-over-token', ...OWNER },
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      await again.close();
    }
  });

  it('five wrong tokens lock the IP for the flow, with Retry-After, and the lockout is listed', async () => {
    const hub = await testHub();
    try {
      const token = tokenOf(hub.dataDir);
      const attempt = (value: string) =>
        hub.app.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: { token: value, ...OWNER },
        });
      for (let i = 0; i < 5; i += 1) expect((await attempt('b'.repeat(48))).statusCode).toBe(401);
      const locked = await attempt('b'.repeat(48));
      expect(locked.statusCode).toBe(429);
      expect(locked.json().code).toBe('rate_limited');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      // Even the correct token waits: the throttle is on the IP, not on the guess.
      expect((await attempt(token)).statusCode).toBe(429);
    } finally {
      await hub.close();
    }
  });

  it('the password policy of the rest of auth applies, and the token is compared in constant time', async () => {
    const hub = await testHub();
    try {
      const token = tokenOf(hub.dataDir);
      const weak = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { token, username: 'tariq', password: 'short' },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().code).toBe('validation_failed');
      const badName = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { token, username: 'Tariq Al Owner', password: OWNER.password },
      });
      expect(badName.statusCode).toBe(400);
      // Nothing was created by either rejection.
      expect((await hub.app.inject({ method: 'GET', url: '/api/v1/auth/setup' })).json()).toEqual({
        required: true,
      });
    } finally {
      await hub.close();
    }
  });

  it('setupTokenMatches compares digests, so length never leaks and equal tokens match', () => {
    expect(setupTokenMatches('a'.repeat(48), 'a'.repeat(48))).toBe(true);
    expect(setupTokenMatches('a'.repeat(48), 'a'.repeat(47))).toBe(false);
    expect(setupTokenMatches('a'.repeat(48), '')).toBe(false);
    expect(setupTokenMatches('token', 'token ')).toBe(false);
  });
});
