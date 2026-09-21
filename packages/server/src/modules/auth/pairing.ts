// QR pairing: a signed-in client creates a short-lived code, the phone presents it once and
// receives a device-bound app token. One transaction creates the device (devices module), the
// token and marks the code consumed; a code can be claimed exactly once.
import { randomInt } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { registerPairedDevice, type DeviceRow, type PairedDeviceInput } from '../devices/index.js';
import { assertNotLocked, clearFailures, recordFailure } from './lockouts.js';
import { appTokens, pairingCodes, users, type PairingConnection } from './schema.js';
import { pairingStatus, type PairingRow, type UserRow } from './serialize.js';
import {
  APP_TOKEN_PREFIX,
  DEVICE_TOKEN_TTL_MS,
  generateOpaqueToken,
  hashToken,
  tokenPrefix,
} from './tokens.js';

export const PAIRING_DEFAULT_TTL_SECONDS = 300;
export const PAIRING_MIN_TTL_SECONDS = 60;
export const PAIRING_MAX_TTL_SECONDS = 900;

/** No 0/O/1/I: the code is read off a screen and typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePairingCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i += 1) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface PairingCreateInput {
  userId: string;
  connection: PairingConnection;
  ttlSeconds: number;
  hubUrl: string;
  initialWorkspaceId: string | null;
}

export function createPairing(db: ModuleDb, input: PairingCreateInput, now: number): PairingRow {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generatePairingCode();
    const clash = db
      .select({ id: pairingCodes.id })
      .from(pairingCodes)
      .where(eq(pairingCodes.code, code))
      .get();
    if (clash) continue;
    return db
      .insert(pairingCodes)
      .values({
        ownerId: input.userId,
        code,
        createdByUserId: input.userId,
        initialWorkspaceId: input.initialWorkspaceId,
        connection: input.connection,
        hubUrl: input.hubUrl,
        expiresAt: new Date(now + input.ttlSeconds * 1000),
      })
      .returning()
      .get();
  }
  throw new HubError('internal_error');
}

export function findPairing(db: ModuleDb, id: string): PairingRow | null {
  return db.select().from(pairingCodes).where(eq(pairingCodes.id, id)).get() ?? null;
}

/** Only pending pairings are cancelled; anything else is left as it is. */
export function cancelPairing(db: ModuleDb, row: PairingRow, now: number): void {
  if (pairingStatus(row, now) !== 'pending') return;
  db.update(pairingCodes)
    .set({ cancelledAt: new Date(now) })
    .where(eq(pairingCodes.id, row.id))
    .run();
}

/** Expired rows older than a day are dropped (the sweeper of docs/domain/auth.md). */
export function sweepExpiredPairings(db: ModuleDb, now: number): number {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000);
  return db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, cutoff)).run().changes;
}

export interface ClaimInput {
  pairingId: string;
  code: string;
  device: Omit<PairedDeviceInput, 'ownerId' | 'appTokenId'>;
  ip: string;
}

export interface ClaimResult {
  pairing: PairingRow;
  user: UserRow;
  device: DeviceRow;
  token: string;
  tokenId: string;
  expiresAt: Date;
}

export function claimPairing(db: ModuleDb, input: ClaimInput, now: number): ClaimResult {
  assertNotLocked(db, 'pairing', input.ip, now);
  const pairing = findPairing(db, input.pairingId);
  const status = pairing ? pairingStatus(pairing, now) : null;
  if (!pairing || status === 'expired' || status === 'cancelled') {
    throw new HubError('not_found', { messageKey: 'auth.pairing_not_found' });
  }
  if (status === 'claimed') throw new HubError('conflict', { messageKey: 'auth.pairing_claimed' });
  if (normalizeCode(input.code) !== normalizeCode(pairing.code)) {
    recordFailure(db, 'pairing', input.ip, now, pairing.createdByUserId);
    throw new HubError('unauthorized', { messageKey: 'auth.pairing_wrong_code' });
  }
  const user = db.select().from(users).where(eq(users.id, pairing.createdByUserId)).get();
  if (!user) throw new HubError('not_found', { messageKey: 'auth.pairing_not_found' });
  if (user.status !== 'active') {
    throw new HubError('forbidden', { messageKey: 'auth.pairing_user_disabled' });
  }
  clearFailures(db, 'pairing', input.ip);

  const token = generateOpaqueToken(APP_TOKEN_PREFIX);
  return db.transaction((tx) => {
    const t = tx as ModuleDb;
    const tokenRow = t
      .insert(appTokens)
      .values({
        ownerId: user.id,
        userId: user.id,
        kind: 'device',
        name: input.device.name,
        tokenHash: hashToken(token),
        tokenPrefix: tokenPrefix(token),
        scopes: ['read', 'write', 'device'],
        expiresAt: new Date(now + DEVICE_TOKEN_TTL_MS),
        lastUsedAt: new Date(now),
      })
      .returning()
      .get();
    const { device, previousTokenId } = registerPairedDevice(
      t,
      { ...input.device, ownerId: user.id, appTokenId: tokenRow.id },
      now,
    );
    if (previousTokenId && previousTokenId !== tokenRow.id) {
      t.update(appTokens)
        .set({ revokedAt: new Date(now) })
        .where(eq(appTokens.id, previousTokenId))
        .run();
    }
    t.update(appTokens).set({ deviceId: device.id }).where(eq(appTokens.id, tokenRow.id)).run();
    const claimed = t
      .update(pairingCodes)
      .set({ consumedAt: new Date(now), deviceId: device.id, appTokenId: tokenRow.id })
      .where(and(eq(pairingCodes.id, pairing.id)))
      .returning()
      .get()!;
    return {
      pairing: claimed,
      user,
      device,
      token,
      tokenId: tokenRow.id,
      expiresAt: tokenRow.expiresAt!,
    };
  });
}
