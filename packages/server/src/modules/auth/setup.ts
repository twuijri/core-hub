// First-run setup (ADR 0011): while the hub has no user at all it writes a random claim token
// to `<DATA_DIR>/setup-token.txt` (mode 0600) and logs it once, and `POST /auth/setup` trades
// that token for the owner account. The token is the proof that the caller can read the
// server's disk or its log — the hub is reachable on a public domain, so "no user exists yet"
// is not by itself permission to create one.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';
import { hashPassword } from './passwords.js';
import { users, workspaces, type Locale } from './schema.js';
import type { UserRow } from './serialize.js';
import { DEFAULT_WORKSPACE_SLUG, defaultWorkspace } from './workspace.js';

export const SETUP_TOKEN_FILE = 'setup-token.txt';
/** 24 random bytes as hex: 48 characters, the same strength as the refresh tokens. */
const SETUP_TOKEN_BYTES = 24;

export function setupTokenPath(dataDir: string): string {
  return path.join(dataDir, SETUP_TOKEN_FILE);
}

/**
 * Writes a fresh token, replacing any previous one. Called on every boot while setup is still
 * pending, so a token that leaked into an old log stops working the next time the hub starts.
 */
export function issueSetupToken(dataDir: string): string {
  const token = randomBytes(SETUP_TOKEN_BYTES).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  const file = setupTokenPath(dataDir);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function readSetupToken(dataDir: string): string | null {
  const file = setupTokenPath(dataDir);
  if (!existsSync(file)) return null;
  const token = readFileSync(file, 'utf8').trim();
  return token === '' ? null : token;
}

/** Deleting the file is what closes first-run setup on disk; safe to call when it is gone. */
export function clearSetupToken(dataDir: string): void {
  rmSync(setupTokenPath(dataDir), { force: true });
}

/**
 * Constant-time comparison. The digests are compared, not the strings, so two tokens of
 * different lengths still take the same time and no length is leaked.
 */
export function setupTokenMatches(expected: string, provided: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

/** The one line an operator needs; the token is a boot secret, not a stored credential. */
export function setupTokenLog(dataDir: string, token: string): string {
  return [
    'auth: first-run setup is required — no owner account exists yet.',
    `Open the hub in a browser and paste this setup token: ${token}`,
    `It is also in the data directory: ${setupTokenPath(dataDir)}`,
    '  docker compose logs hub          # this line again',
    '  docker compose exec hub cat /data/setup-token.txt',
    'A new token is generated on every restart until the owner account exists.',
  ].join('\n');
}

export interface SetupInput {
  username: string;
  password: string;
  displayName?: string | undefined;
  workspaceName?: string | undefined;
  locale?: Locale;
}

/**
 * Creates the owner and the `default` workspace in one transaction — the same rows
 * `bootstrap()` creates from `HUB_ADMIN_PASSWORD`, so the two paths cannot drift.
 */
export async function completeSetup(
  db: ModuleDb,
  input: SetupInput,
  now: number,
): Promise<UserRow> {
  const ownerId = newUlid(now);
  const passwordHash = await hashPassword(input.password);
  return db.transaction((tx) => {
    const row = tx
      .insert(users)
      .values({
        id: ownerId,
        ownerId,
        username: input.username,
        displayName: input.displayName ?? null,
        role: 'owner',
        status: 'active',
        passwordHash,
        passwordChangedAt: new Date(now),
        locale: input.locale ?? 'ar',
      })
      .returning()
      .get();
    if (!defaultWorkspace(tx as ModuleDb)) {
      tx.insert(workspaces)
        .values({
          ownerId,
          slug: DEFAULT_WORKSPACE_SLUG,
          name: input.workspaceName?.trim() || 'Default',
          isDefault: true,
          settings: {},
        })
        .run();
    }
    return tx.select().from(users).where(eq(users.id, row.id)).get()!;
  });
}
