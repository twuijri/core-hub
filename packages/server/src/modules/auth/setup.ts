// First-run setup (ADR 0011, amended by ADR 0019). While the hub has no owner:
// - for the first `COREHUB_SETUP_OPEN_MINUTES` (60) after the process started, `POST /auth/setup`
//   creates the owner for whoever arrives first, with no token — the window;
// - after it, the random claim token in `<DATA_DIR>/setup-token.txt` (mode 0600, also logged)
//   is required, as before. A restart opens a fresh window, so no terminal is ever needed.
// `COREHUB_RESET_OWNER=1` is the way back when somebody else got there first: it disables the
// owner on that boot (once) and setup opens again.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import { endPushForOwners } from '../devices/index.js';
import { hashPassword } from './passwords.js';
import { appTokens, users, workspaces, type Locale } from './schema.js';
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

// ---------------------------------------------------------------- the open window (ADR 0019)

/** When setup stops being open without the token; `null` = token only (`0` minutes). */
export function setupWindowUntil(startedAt: number, minutes: number): number | null {
  return minutes > 0 ? startedAt + minutes * 60_000 : null;
}

export function setupWindowOpen(openUntil: number | null, now: number): boolean {
  return openUntil !== null && now < openUntil;
}

/** The `Meta` fields of first run: what a client needs to pick the open form or the token. */
export interface SetupMeta {
  setup_required: boolean;
  setup_open: boolean;
  setup_open_until: string | null;
}

export function setupMeta(required: boolean, openUntil: number | null, now: number): SetupMeta {
  const open = required && setupWindowOpen(openUntil, now);
  return {
    setup_required: required,
    setup_open: open,
    setup_open_until: open ? new Date(openUntil!).toISOString() : null,
  };
}

/** The one line an operator needs; the token is a boot secret, not a stored credential. */
export function setupTokenLog(dataDir: string, token: string, openUntil: number | null): string {
  const window =
    openUntil === null
      ? ['Setup is token-only on this hub (COREHUB_SETUP_OPEN_MINUTES=0).']
      : [
          `Setup is OPEN to whoever opens the hub first until ${new Date(openUntil).toISOString()} — finish it now.`,
          'After that the setup token below is required; restarting the hub opens a fresh window.',
        ];
  return [
    'auth: first-run setup is required — no owner account exists yet.',
    ...window,
    `Setup token (when the window is closed): ${token}`,
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
 * "No owner yet" is checked again inside the transaction: two setups racing (both let in by
 * the open window) are serialized by SQLite, and exactly one of them creates the owner.
 */
export async function completeSetup(
  db: ModuleDb,
  input: SetupInput,
  now: number,
): Promise<UserRow> {
  const ownerId = newUlid(now);
  const passwordHash = await hashPassword(input.password);
  return db.transaction((tx) => {
    if (tx.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).get()) {
      throw new HubError('conflict', { messageKey: 'auth.setup_done' });
    }
    // After an owner reset the old accounts are still there, the old owner's name included.
    if (tx.select({ id: users.id }).from(users).where(eq(users.username, input.username)).get()) {
      throw new HubError('conflict', { messageKey: 'auth.username_taken' });
    }
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

// ---------------------------------------------------------------- owner reset (ADR 0019)

export const OWNER_RESET_MARKER = 'owner-reset.json';

interface OwnerResetMarker {
  reset_at: string;
  disabled_owner_ids: string[];
}

export type OwnerResetResult =
  | { state: 'off' }
  | { state: 'reset'; disabledOwnerIds: string[] }
  | { state: 'already_done'; resetAt: string | null; disabledOwnerIds: string[] };

function readMarker(file: string): OwnerResetMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OwnerResetMarker>;
    return {
      reset_at: typeof parsed.reset_at === 'string' ? parsed.reset_at : '',
      disabled_owner_ids: Array.isArray(parsed.disabled_owner_ids)
        ? parsed.disabled_owner_ids.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    // Unreadable is still "a reset already ran": never reset twice because a file was damaged.
    return { reset_at: '', disabled_owner_ids: [] };
  }
}

/**
 * `COREHUB_RESET_OWNER=1` on a boot: every owner account is disabled, stepped down to admin
 * (so the next owner can re-enable or delete it from Users — an owner row cannot be changed),
 * and every token and session it holds is revoked. Nothing is deleted. Runs once: the marker
 * in DATA_DIR names the owner ids it disabled, and while it exists the variable is ignored —
 * so the owner who claims the hub next is never reset by a variable left in the compose file.
 * A boot without the variable removes the marker, arming it again for a future reset.
 */
export function resetOwnerOnBoot(
  db: ModuleDb,
  dataDir: string,
  enabled: boolean,
  now: number,
): OwnerResetResult {
  const file = path.join(dataDir, OWNER_RESET_MARKER);
  if (!enabled) {
    rmSync(file, { force: true });
    return { state: 'off' };
  }
  if (existsSync(file)) {
    const marker = readMarker(file)!;
    return {
      state: 'already_done',
      resetAt: marker.reset_at || null,
      disabledOwnerIds: marker.disabled_owner_ids,
    };
  }
  const disabledOwnerIds = db.transaction((tx) => {
    const owners = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'owner'))
      .all()
      .map((row) => row.id);
    if (owners.length === 0) return owners;
    tx.update(users)
      .set({ role: 'admin', status: 'disabled' })
      .where(inArray(users.id, owners))
      .run();
    tx.update(appTokens)
      .set({ revokedAt: new Date(now) })
      .where(and(inArray(appTokens.userId, owners), isNull(appTokens.revokedAt)))
      .run();
    endPushForOwners(tx as ModuleDb, owners);
    return owners;
  });
  // Written even when there was no owner to disable: a variable set on the very first boot
  // must not reset the owner who is about to be created.
  mkdirSync(dataDir, { recursive: true });
  const marker: OwnerResetMarker = {
    reset_at: new Date(now).toISOString(),
    disabled_owner_ids: disabledOwnerIds,
  };
  writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return { state: 'reset', disabledOwnerIds };
}

/** Loud on purpose: a reset hands the hub to whoever opens it next. */
export function ownerResetLog(result: OwnerResetResult): string | null {
  if (result.state === 'reset') {
    return [
      '*** auth: COREHUB_RESET_OWNER=1 — OWNER RESET ***',
      result.disabledOwnerIds.length > 0
        ? `Disabled the owner account(s) ${result.disabledOwnerIds.join(', ')} and revoked their tokens and sessions. No data was deleted.`
        : 'There was no owner account to disable.',
      'First-run setup is open again: open the hub now and create the new owner.',
      'Remove COREHUB_RESET_OWNER from the environment. It will not reset again while the marker',
      `${OWNER_RESET_MARKER} is in the data directory, but it should not stay set.`,
    ].join('\n');
  }
  if (result.state === 'already_done') {
    return [
      'auth: COREHUB_RESET_OWNER is still set, but the reset already ran' +
        (result.resetAt ? ` (${result.resetAt})` : '') +
        ' — ignored.',
      'Remove the variable; set it again (after one boot without it) only for a new reset.',
    ].join('\n');
  }
  return null;
}
