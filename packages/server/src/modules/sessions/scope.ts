/**
 * Who is asking, and in which workspace.
 *
 * Every scoped row carries `workspace` (the ULID of the workspace named by
 * `X-Hub-Profile`) and `owner_id` (the user who created it) — see
 * docs/domain/README.md §Conventions and invariant 3. Both belong to `auth`,
 * which owns `workspaces` and `users` and lands in a parallel branch. So this
 * module states what it needs as a port and ships a placeholder:
 *
 * - the workspace id is **derived** from the profile slug (stable, unique per
 *   slug, valid ULID shape), so scoping is genuinely enforced today — two
 *   profiles never see each other's rows — without inventing a workspaces
 *   table this module does not own;
 * - the owner is one derived "local owner" id, because nobody is signed in
 *   until `auth` exists.
 *
 * Neither is a fake success: no request is authorised that would otherwise be
 * refused, and the wire never shows these ids as a user identity — `profile`
 * is the slug the client sent. Wiring `auth`'s resolver is one line in
 * `src/modules/index.ts`; after that the ids are the real rows'.
 */
import { createHash } from 'node:crypto';

/** Crockford base32, as `src/db/ids.ts` uses it. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface RequestScope {
  /** ULID of the workspace row; the `workspace` column of every scoped table. */
  workspaceId: string;
  /** The slug the client sent in `X-Hub-Profile`; the wire's `profile`. */
  profile: string;
  /** ULID of the acting user; the `owner_id` column. */
  userId: string;
  /** Display name for `Message.author.name` of a user message. */
  userName: string;
}

export interface ScopeResolver {
  /** `null` when the profile does not exist — the caller answers `profile_not_found`. */
  resolve(profile: string): Promise<RequestScope | null>;
}

/**
 * A ULID-shaped id that is a pure function of `namespace` and `value`.
 * The first character is forced into 0–7 so it matches the contract's
 * `Ulid` pattern (`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`).
 */
export function derivedId(namespace: string, value: string): string {
  const digest = createHash('sha256').update(`${namespace}:${value}`).digest();
  let out = '';
  for (let i = 0; i < 26; i += 1) out += ENCODING.charAt((digest[i] ?? 0) & 31);
  return ENCODING.charAt((digest[0] ?? 0) & 7) + out.slice(1);
}

export const LOCAL_OWNER_ID = derivedId('majlis.user', 'local-owner');
export const LOCAL_OWNER_NAME = 'Owner';

/** The placeholder resolver: every well-formed profile slug resolves. */
export const derivedScopeResolver: ScopeResolver = {
  async resolve(profile: string): Promise<RequestScope | null> {
    return {
      workspaceId: derivedId('majlis.workspace', profile),
      profile,
      userId: LOCAL_OWNER_ID,
      userName: LOCAL_OWNER_NAME,
    };
  },
};
