/**
 * A person's messaging accounts (contract decision §78): the Telegram and WhatsApp accounts a
 * person proved are theirs, so a message from one of them runs with that person's permissions
 * and the hub's own tools act as them.
 *
 * **Proven, never typed.** Nobody enters an account id. The person asks for a one-time code
 * (`auth.createChannelLinkCode`) and sends `/start <code>` to their agent's bot from the
 * account they want linked; the hook the hub keeps in Hermes's messaging gateway reports the
 * sender the platform named (`agents` module, `hub-tools/hook.ts`), and only then is the link
 * written. So a link names an account the person had in their hand, as the platform itself
 * identified it — the same id Hermes's own allowlists and pairing use.
 *
 * Codes live in memory for ten minutes, one per person (a new one replaces the old), hashed,
 * and work once. A restart forgets them: the person asks for another.
 *
 * **One link per account, for the hub.** Proposed (owner to confirm): a person is the same
 * person in every profile, and what they may do in each is already their membership. So the
 * link is hub-wide, and a message acts only in a profile the person may enter. An account
 * linked to somebody else is refused, not taken over: the other person (or an admin) unlinks
 * it first.
 */
import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import {
  CHANNEL_IDENTITY_PLATFORMS,
  channelIdentities,
  users,
  type ChannelIdentityPlatform,
} from './schema.js';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CODE_PREFIX = 'corehub_';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export type ChannelIdentityRow = typeof channelIdentities.$inferSelect;

interface PendingCode {
  userId: string;
  expiresAt: number;
}

/** The codes waiting to be sent, per hub (the auth context owns one). */
export class LinkCodes {
  private readonly byHash = new Map<string, PendingCode>();

  private static hash(code: string): string {
    return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
  }

  /** A fresh code for `userId`; the person's earlier one stops working. */
  issue(userId: string, now: number): { code: string; expiresAt: number } {
    this.sweep(now);
    for (const [hash, pending] of this.byHash)
      if (pending.userId === userId) this.byHash.delete(hash);
    let body = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) body += ALPHABET[randomInt(ALPHABET.length)];
    const code = `${LINK_CODE_PREFIX}${body}`;
    const expiresAt = now + LINK_CODE_TTL_MS;
    this.byHash.set(LinkCodes.hash(code.slice(LINK_CODE_PREFIX.length)), { userId, expiresAt });
    return { code, expiresAt };
  }

  /** The person a code was issued to, consuming it; `null` for anything else. */
  take(code: string, now: number): string | null {
    this.sweep(now);
    const body = code.trim().replace(/^corehub_/i, '');
    const hash = LinkCodes.hash(body);
    const pending = this.byHash.get(hash);
    if (!pending) return null;
    this.byHash.delete(hash);
    return pending.expiresAt > now ? pending.userId : null;
  }

  private sweep(now: number): void {
    for (const [hash, pending] of this.byHash)
      if (pending.expiresAt <= now) this.byHash.delete(hash);
  }
}

/** Whether `/start <argument>` looks like one of the hub's codes (anything else is not ours). */
export function looksLikeLinkCode(argument: string | null | undefined): boolean {
  return /^corehub_[a-z0-9]{4,40}$/i.test((argument ?? '').trim());
}

export function isIdentityPlatform(platform: string): platform is ChannelIdentityPlatform {
  return (CHANNEL_IDENTITY_PLATFORMS as readonly string[]).includes(platform);
}

/** The contract's `ChannelIdentity`. */
export function presentIdentity(row: ChannelIdentityRow) {
  return {
    id: row.id,
    user_id: row.userId,
    platform: row.platform,
    sender_id: row.senderId,
    linked_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

export function listIdentities(db: ModuleDb, userId?: string): ChannelIdentityRow[] {
  return db
    .select()
    .from(channelIdentities)
    .where(userId ? eq(channelIdentities.userId, userId) : undefined)
    .orderBy(desc(channelIdentities.createdAt), desc(channelIdentities.id))
    .all();
}

export function findIdentity(db: ModuleDb, id: string): ChannelIdentityRow | null {
  return db.select().from(channelIdentities).where(eq(channelIdentities.id, id)).get() ?? null;
}

export function deleteIdentity(db: ModuleDb, id: string): void {
  db.delete(channelIdentities).where(eq(channelIdentities.id, id)).run();
}

/** Who linked this account, if anybody. */
export function identityOf(
  db: ModuleDb,
  platform: string,
  senderId: string | null | undefined,
): ChannelIdentityRow | null {
  if (!senderId || !isIdentityPlatform(platform)) return null;
  return (
    db
      .select()
      .from(channelIdentities)
      .where(
        and(eq(channelIdentities.platform, platform), eq(channelIdentities.senderId, senderId)),
      )
      .get() ?? null
  );
}

export function touchIdentity(db: ModuleDb, id: string, now: number): void {
  db.update(channelIdentities)
    .set({ lastUsedAt: new Date(now) })
    .where(eq(channelIdentities.id, id))
    .run();
}

export type LinkOutcome =
  | { kind: 'linked'; row: ChannelIdentityRow; userName: string; again: boolean }
  | { kind: 'invalid' }
  | { kind: 'platform' }
  | { kind: 'taken' };

/** A code arrived from `platform`/`senderId`: link that account to the code's person. */
export function linkWithCode(
  db: ModuleDb,
  codes: LinkCodes,
  input: { code: string; platform: string; senderId: string | null },
  now: number,
): LinkOutcome {
  if (!input.senderId || !isIdentityPlatform(input.platform)) {
    // Not consumed: the same code still works from Telegram or WhatsApp.
    return { kind: 'platform' };
  }
  const userId = codes.take(input.code, now);
  if (!userId) return { kind: 'invalid' };
  const person = db.select().from(users).where(eq(users.id, userId)).get();
  if (!person || person.status !== 'active') return { kind: 'invalid' };
  const existing = identityOf(db, input.platform, input.senderId);
  const userName = person.displayName || person.username;
  if (existing && existing.userId !== userId) return { kind: 'taken' };
  if (existing) return { kind: 'linked', row: existing, userName, again: true };
  const at = new Date(now);
  const row = db
    .insert(channelIdentities)
    .values({
      ownerId: userId,
      userId,
      platform: input.platform,
      senderId: input.senderId,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return { kind: 'linked', row, userName, again: false };
}
