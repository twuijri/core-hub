// Tokens: the HS256 access JWT (short-lived), and the opaque bearer strings for refresh
// tokens (`hub_rt_…`) and app tokens (`hub_at_…`). Opaque tokens are stored as SHA-256 only.
import { LEGACY, derived } from '@corehub/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { HubError } from '../../lib/errors.js';
import type { UserRole } from './schema.js';

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const APP_TOKEN_PREFIX = 'hub_at_';
export const REFRESH_TOKEN_PREFIX = 'hub_rt_';

const JWT_ALG = 'HS256';
/** Who signs a new access token. */
export const JWT_ISSUER = derived.jwtIssuer;
/**
 * Who a token may have been signed by: this product, and the name it had before (Majlis).
 * Accepting the old issuer is what keeps a rename from signing everyone out at once; an
 * access token lives fifteen minutes, so the old name stops appearing on its own.
 */
export const ACCEPTED_JWT_ISSUERS = [JWT_ISSUER, LEGACY.jwtIssuer];

export interface AccessClaims {
  /** User id. */
  sub: string;
  role: UserRole;
  /** The `app_tokens` row this access token belongs to (web session or app token). */
  sid: string;
  /** Seconds since epoch. */
  iat: number;
  exp: number;
}

/** Reads `<dataDir>/keys/jwt.secret`, creating it (32 random bytes, mode 0600) on first boot. */
export function loadOrCreateSigningKey(dataDir: string): Uint8Array {
  const dir = path.join(dataDir, 'keys');
  const file = path.join(dir, 'jwt.secret');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return new Uint8Array(Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'));
}

export function generateOpaqueToken(prefix: typeof APP_TOKEN_PREFIX | typeof REFRESH_TOKEN_PREFIX) {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

export function isAppToken(token: string): boolean {
  return token.startsWith(APP_TOKEN_PREFIX);
}

export function isRefreshToken(token: string): boolean {
  return token.startsWith(REFRESH_TOKEN_PREFIX);
}

export async function signAccessToken(
  key: Uint8Array,
  claims: { userId: string; role: UserRole; sessionId: string },
  nowMs: number,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({ role: claims.role, sid: claims.sessionId })
    .setProtectedHeader({ alg: JWT_ALG, typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setSubject(claims.userId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(key);
}

/** Throws `token_expired` or `unauthorized` (`auth.token_invalid`). */
export async function verifyAccessToken(
  key: Uint8Array,
  token: string,
  nowMs: number,
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [JWT_ALG],
      issuer: ACCEPTED_JWT_ISSUERS,
      currentDate: new Date(nowMs),
    });
    const { sub, role, sid, iat, exp } = payload as Partial<AccessClaims>;
    if (!sub || !role || !sid || typeof iat !== 'number' || typeof exp !== 'number') {
      throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    }
    return { sub, role, sid, iat, exp };
  } catch (error) {
    if (error instanceof HubError) throw error;
    if (error instanceof joseErrors.JWTExpired) throw new HubError('token_expired');
    throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
  }
}
