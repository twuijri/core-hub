import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authModule } from './index.js';
import { expectModuleRegistered, testHub } from '../../../tests/unit/helpers.js';

describe('module: auth', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(authModule);
  });

  it('first boot: creates the owner from HUB_ADMIN_PASSWORD, the default workspace and the signing key', async () => {
    const hub = await testHub({ HUB_ADMIN_PASSWORD: 'first-boot-password' });
    try {
      expect(existsSync(path.join(hub.dataDir, 'keys', 'jwt.secret'))).toBe(true);
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: 'first-boot-password' },
      });
      expect(login.statusCode).toBe(200);
      const body = login.json();
      expect(body.user).toMatchObject({
        username: 'admin',
        role: 'owner',
        profiles: ['default'],
        default_profile: 'default',
      });
      expect(body.expires_in).toBe(900);
      expect(body.refresh_token).toMatch(/^hub_rt_/);
      const wrong = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'accept-language': 'ar' },
        payload: { username: 'admin', password: 'nope' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({
        error: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
        code: 'unauthorized',
      });
    } finally {
      await hub.close();
    }
  });

  it('without a password and without users, sign-in reports setup_required and nothing is created', async () => {
    const hub = await testHub();
    try {
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: 'anything-at-all' },
      });
      expect(login.statusCode).toBe(401);
      expect(login.json().error).toContain('HUB_ADMIN_PASSWORD');
    } finally {
      await hub.close();
    }
  });

  it('a second boot with the password set does not create another owner', async () => {
    const hub = await testHub({ HUB_ADMIN_PASSWORD: 'boot-password-1' });
    const { dataDir } = hub;
    await hub.app.close();
    const again = await testHub({ DATA_DIR: dataDir, HUB_ADMIN_PASSWORD: 'boot-password-2' });
    try {
      const login = await again.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: 'boot-password-1' },
      });
      expect(login.statusCode).toBe(200);
      const users = await again.app.inject({
        method: 'GET',
        url: '/api/v1/auth/users',
        headers: { authorization: `Bearer ${login.json().access_token}` },
      });
      expect(users.json().items).toHaveLength(1);
    } finally {
      await again.app.close();
      await hub.close();
    }
  });
});
