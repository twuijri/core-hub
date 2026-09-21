// Per-IP throttling of the three guessable flows (password, app token, pairing code):
// five failures inside the window lock the IP for the lockout period; a success clears it.
import { and, eq, gt } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { loginLockouts, type LockoutKind } from './schema.js';

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export type LockoutRow = typeof loginLockouts.$inferSelect;

function find(db: ModuleDb, kind: LockoutKind, ip: string): LockoutRow | undefined {
  return db
    .select()
    .from(loginLockouts)
    .where(
      and(
        eq(loginLockouts.subjectKind, 'ip'),
        eq(loginLockouts.subject, ip),
        eq(loginLockouts.kind, kind),
      ),
    )
    .get();
}

/** Throws `429 rate_limited` with `Retry-After` while the IP is locked for this flow. */
export function assertNotLocked(db: ModuleDb, kind: LockoutKind, ip: string, now: number): void {
  const row = find(db, kind, ip);
  if (!row?.lockedUntil || row.lockedUntil.getTime() <= now) return;
  const retryAfterMs = row.lockedUntil.getTime() - now;
  throw new HubError('rate_limited', {
    messageKey: 'auth.locked_out',
    details: { kind, retry_after_ms: retryAfterMs },
    headers: { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) },
  });
}

/** Counts a failure; returns true when this failure locked the IP. */
export function recordFailure(
  db: ModuleDb,
  kind: LockoutKind,
  ip: string,
  now: number,
  ownerId: string,
): boolean {
  const existing = find(db, kind, ip);
  const inWindow =
    existing?.lastFailureAt !== null &&
    existing?.lastFailureAt !== undefined &&
    existing.lastFailureAt.getTime() + LOCKOUT_WINDOW_MS > now;
  const failures = inWindow ? existing.failures + 1 : 1;
  const locked = failures >= LOCKOUT_MAX_FAILURES;
  const lockedUntil = locked ? new Date(now + LOCKOUT_DURATION_MS) : null;
  if (existing) {
    db.update(loginLockouts)
      .set({ failures, lastFailureAt: new Date(now), lockedUntil })
      .where(eq(loginLockouts.id, existing.id))
      .run();
  } else {
    db.insert(loginLockouts)
      .values({
        ownerId,
        subjectKind: 'ip',
        subject: ip,
        kind,
        failures,
        lastFailureAt: new Date(now),
        lockedUntil,
      })
      .run();
  }
  return locked;
}

export function clearFailures(db: ModuleDb, kind: LockoutKind, ip: string): void {
  db.delete(loginLockouts)
    .where(
      and(
        eq(loginLockouts.subjectKind, 'ip'),
        eq(loginLockouts.subject, ip),
        eq(loginLockouts.kind, kind),
      ),
    )
    .run();
}

/** Currently locked IPs (the admin screen). */
export function listLockouts(db: ModuleDb, now: number): LockoutRow[] {
  return db
    .select()
    .from(loginLockouts)
    .where(and(eq(loginLockouts.subjectKind, 'ip'), gt(loginLockouts.lockedUntil, new Date(now))))
    .all();
}

/** Deletes every lockout row, or those of one IP; returns how many were locked. */
export function clearLockouts(db: ModuleDb, now: number, ip?: string): number {
  const locked = listLockouts(db, now).filter((row) => ip === undefined || row.subject === ip);
  if (ip === undefined) db.delete(loginLockouts).run();
  else db.delete(loginLockouts).where(eq(loginLockouts.subject, ip)).run();
  return locked.length;
}
