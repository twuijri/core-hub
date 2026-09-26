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

/**
 * The token with its signature's **first** character changed. Changing the last characters
 * is not a change at all one time in a thousand: a 32-byte signature is 43 base64url
 * characters, and the low bits of the last one are padding the decoder drops — so
 * `…xx` sometimes decoded to the very same signature and the "tampered" token verified
 * (CI run 36199485661). The first character carries six real bits.
 */
function tamper(jwt: string): string {
  const cut = jwt.lastIndexOf('.') + 1;
  const first = jwt[cut] === 'A' ? 'B' : 'A';
  return `${jwt.slice(0, cut)}${first}${jwt.slice(cut + 1)}`;
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-tokens-'));
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
    // An explicit clock: nothing here depends on when the test happens to run.
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    const jwt = await signAccessToken(key, { userId: 'U1', role: 'member', sessionId: 'S1' }, now);
    await expect(
      verifyAccessToken(key, jwt, now + (ACCESS_TOKEN_TTL_SECONDS + 5) * 1000),
    ).rejects.toMatchObject({ code: 'token_expired' });
    // One second before the end it is still good, and at the end it is not.
    await expect(
      verifyAccessToken(key, jwt, now + (ACCESS_TOKEN_TTL_SECONDS - 1) * 1000),
    ).resolves.toMatchObject({ sub: 'U1' });
    await expect(
      verifyAccessToken(key, jwt, now + ACCESS_TOKEN_TTL_SECONDS * 1000),
    ).rejects.toMatchObject({ code: 'token_expired' });
    const tampered = tamper(jwt);
    await expect(verifyAccessToken(key, tampered, now)).rejects.toBeInstanceOf(HubError);
    await expect(verifyAccessToken(key, tampered, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const otherKey = loadOrCreateSigningKey(mkdtempSync(path.join(tmpdir(), 'corehub-key2-')));
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
