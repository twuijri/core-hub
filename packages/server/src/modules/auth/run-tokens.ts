/**
 * Run tokens: the principal an agent's call to the hub's own tools acts as (contract
 * decision §67).
 *
 * A run token is minted when a run of the hub's starts and revoked when it ends. It names
 * **one person in one profile**, and nothing more: the principal it resolves to
 *
 * - is the run's owner, re-read on every call (a disabled person's token stops at once),
 * - enters only the profile the run was in (`pinnedWorkspaceId`; `canEnter` and
 *   `listWorkspacesFor` honour it, so neither a header nor `profiles=all` reaches further),
 * - is never an admin: its role is `member` whatever the person's is, and its scopes are
 *   `read` and `write`, so every admin-only route refuses it as it would a member.
 *
 * It lives in memory only. A run does not survive a restart, and neither should anything
 * that acts in its name; nothing here is ever written to disk or shown to anyone.
 */
import { createHash, randomBytes } from 'node:crypto';

export const RUN_TOKEN_PREFIX = 'hub_run_';

/** Past this a run token is refused even if its run never said it ended. */
export const RUN_TOKEN_MAX_TTL_MS = 12 * 60 * 60 * 1000;

export interface RunGrant {
  userId: string;
  workspaceId: string;
  runId: string;
  sessionId: string | null;
  expiresAt: number;
}

const grants = new Map<string, RunGrant>();

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isRunToken(token: string): boolean {
  return token.startsWith(RUN_TOKEN_PREFIX);
}

/** Mint one run token. The caller keeps it, uses it for the run's calls and revokes it. */
export function issueRunToken(
  input: Omit<RunGrant, 'expiresAt'> & { ttlMs?: number },
  now: number = Date.now(),
): string {
  sweep(now);
  const token = `${RUN_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const ttl = Math.min(input.ttlMs ?? RUN_TOKEN_MAX_TTL_MS, RUN_TOKEN_MAX_TTL_MS);
  grants.set(hashOf(token), {
    userId: input.userId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    sessionId: input.sessionId,
    expiresAt: now + ttl,
  });
  return token;
}

export function revokeRunToken(token: string): void {
  grants.delete(hashOf(token));
}

/** The grant behind a live token, or null (unknown, revoked or past its time). */
export function runGrantOf(token: string, now: number = Date.now()): RunGrant | null {
  const grant = grants.get(hashOf(token));
  if (!grant) return null;
  if (grant.expiresAt <= now) {
    grants.delete(hashOf(token));
    return null;
  }
  return grant;
}

function sweep(now: number): void {
  for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
}
