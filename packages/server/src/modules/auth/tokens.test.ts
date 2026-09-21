import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HubError } from '../../lib/errors.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  APP_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  generateOpaqueToken,
  hashToken,
  isAppToken,
  isRefreshToken,
  loadOrCreateSigningKey,
  signAccessToken,
  tokenPrefix,
  verifyAccessToken,
} from './tokens.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'majlis-tokens-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('auth: tokens', () => {
  it('creates the signing key once, owner-only, and reloads the same bytes', () => {
    const first = loadOrCreateSigningKey(dataDir);
    const second = loadOrCreateSigningKey(dataDir);
    expect(first.length).toBe(32);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const mode = statSync(path.join(dataDir, 'keys', 'jwt.secret')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('signs an access token whose claims verify with the same key', async () => {
    const key = loadOrCreateSigningKey(dataDir);
    const now = Date.now();
    const jwt = await signAccessToken(key, { userId: 'U1', role: 'admin', sessionId: 'S1' }, now);
    const claims = await verifyAccessToken(key, jwt, now + 1000);
    expect(claims).toMatchObject({ sub: 'U1', role: 'admin', sid: 'S1' });
    expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('rejects an expired token with token_expired and a tampered one with unauthorized', async () => {
    const key = loadOrCreateSigningKey(dataDir);
    const now = Date.now();
    const jwt = await signAccessToken(key, { userId: 'U1', role: 'member', sessionId: 'S1' }, now);
    await expect(
      verifyAccessToken(key, jwt, now + (ACCESS_TOKEN_TTL_SECONDS + 5) * 1000),
    ).rejects.toMatchObject({ code: 'token_expired' });
    const tampered = `${jwt.slice(0, -2)}xx`;
    await expect(verifyAccessToken(key, tampered, now)).rejects.toBeInstanceOf(HubError);
    await expect(verifyAccessToken(key, tampered, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const otherKey = loadOrCreateSigningKey(mkdtempSync(path.join(tmpdir(), 'majlis-key2-')));
    await expect(verifyAccessToken(otherKey, jwt, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('issues opaque tokens with a recognisable prefix and stores only a SHA-256', () => {
    const app = generateOpaqueToken(APP_TOKEN_PREFIX);
    const refresh = generateOpaqueToken(REFRESH_TOKEN_PREFIX);
    expect(isAppToken(app)).toBe(true);
    expect(isRefreshToken(refresh)).toBe(true);
    expect(isAppToken(refresh)).toBe(false);
    expect(app).not.toBe(generateOpaqueToken(APP_TOKEN_PREFIX));
    expect(hashToken(app)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(app)).not.toContain(app.slice(7, 20));
    expect(tokenPrefix(app)).toBe(app.slice(0, 8));
  });
});
