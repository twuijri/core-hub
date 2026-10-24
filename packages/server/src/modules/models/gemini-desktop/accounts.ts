/**
 * Where a Gemini Desktop row keeps its accounts and its conversations (DECISIONS §155): the hub's
 * encrypted `secrets` table (ADR 0010), one row per account and one for the row's conversation
 * ids, under the provider row's own scope. They are never a provider key, so Settings → Secrets
 * does not list them, and the profile export scrubs their bytes like every stored secret.
 */
import { createHash } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import type { ModuleDb } from '../../../lib/db.js';
import type { SecretStore } from '../secrets.js';
import { secrets } from '../schema.js';
import type { NativeMode } from './modes.js';
import type { TokenSet } from './oauth.js';
import type { Threads } from './threads.js';

export interface StoredAccount extends TokenSet {
  id: string;
  /** The modes the account offered when last asked; kept when asking again fails. */
  modes: NativeMode[];
  modesAt: number | null;
  disabled: boolean;
  createdAt: number;
  refreshedAt: number | null;
}

/** The provider row an account belongs to. */
export interface AccountScope {
  id: string;
  workspace: string;
  ownerId: string;
}

const NAME = 'gemini-desktop';

/** An account's id: the same Google account signed in again is the same account. */
export function accountIdOf(email: string): string {
  return `g${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 20)}`;
}

function accountName(rowId: string, accountId: string): string {
  return `${NAME}:${rowId}:${accountId}`;
}
function threadsName(rowId: string): string {
  return `${NAME}:${rowId}:threads`;
}

function parseAccount(value: string | null): StoredAccount | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as StoredAccount;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.refreshToken !== 'string')
      return null;
    return { ...parsed, modes: Array.isArray(parsed.modes) ? parsed.modes : [] };
  } catch {
    return null;
  }
}

/** What the provider needs of its storage; tests hand an in-memory one. */
export interface AccountStorage {
  list(row: AccountScope): StoredAccount[];
  get(row: AccountScope, accountId: string): StoredAccount | null;
  save(row: AccountScope, account: StoredAccount): void;
  remove(row: AccountScope, accountId: string): boolean;
  removeAll(row: AccountScope): void;
  threads(row: AccountScope): Threads;
  saveThreads(row: AccountScope, threads: Threads): void;
}

export class AccountStore implements AccountStorage {
  constructor(
    private readonly db: ModuleDb,
    private readonly secrets: SecretStore,
  ) {}

  private rows(row: AccountScope) {
    return this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.workspace, row.workspace), like(secrets.name, `${NAME}:${row.id}:%`)))
      .all()
      .filter((secret) => !!secret.ciphertext && !secret.wipedAt);
  }

  /** The row's accounts, oldest first. */
  list(row: AccountScope): StoredAccount[] {
    const out: StoredAccount[] = [];
    for (const secret of this.rows(row)) {
      if (secret.name === threadsName(row.id)) continue;
      let value: string | null;
      try {
        value = this.secrets.reveal(row.workspace, secret.id);
      } catch {
        continue; // sealed under a key the ring no longer has
      }
      const account = parseAccount(value);
      if (account) out.push(account);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  get(row: AccountScope, accountId: string): StoredAccount | null {
    return this.list(row).find((account) => account.id === accountId) ?? null;
  }

  save(row: AccountScope, account: StoredAccount): void {
    this.secrets.put(
      { workspace: row.workspace, ownerId: row.ownerId },
      accountName(row.id, account.id),
      JSON.stringify(account),
      'token',
    );
  }

  remove(row: AccountScope, accountId: string): boolean {
    const secret = this.rows(row).find((one) => one.name === accountName(row.id, accountId));
    if (!secret) return false;
    this.secrets.wipe(row.workspace, secret.id);
    return true;
  }

  /** Everything the row kept: its accounts and its conversations. */
  removeAll(row: AccountScope): void {
    for (const secret of this.rows(row)) this.secrets.wipe(row.workspace, secret.id);
  }

  threads(row: AccountScope): Threads {
    const secret = this.rows(row).find((one) => one.name === threadsName(row.id));
    if (!secret) return {};
    try {
      const value = this.secrets.reveal(row.workspace, secret.id);
      const parsed = value ? (JSON.parse(value) as Threads) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  saveThreads(row: AccountScope, threads: Threads): void {
    this.secrets.put(
      { workspace: row.workspace, ownerId: row.ownerId },
      threadsName(row.id),
      JSON.stringify(threads),
      'generic',
    );
  }
}
