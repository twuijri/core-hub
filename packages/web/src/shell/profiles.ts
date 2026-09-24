/**
 * Profiles on lists that gather several (ADR 0016, owner 2026-09-24).
 *
 * The top selector is always one concrete profile — the one the person is in: new chats
 * are made there and configuration pages edit it. It never says "All". "All profiles" is a
 * filter of the chats list itself (`SessionList`), and the two never move each other.
 */
import { useProfiles } from '../hub/queries.js';

/** The chats-list filter's value for "All profiles"; never a slug (`^[a-z0-9]`). */
export const ALL_PROFILES = '*';

/** Whether items from more than one profile can be on screen, so a badge says which. */
export function useManyProfiles(): boolean {
  return (useProfiles().data ?? []).length > 1;
}

/** A profile's name for a badge; the slug until the hub has answered. */
export function useProfileName(): (slug: string) => string {
  const items = useProfiles().data ?? [];
  return (slug) => items.find((p) => p.slug === slug)?.name ?? slug;
}

/**
 * The profile a chat link carries (`?profile=`, chat/anchor.ts): always, once the person
 * has more than one profile — so a link opens the conversation where it lives whatever
 * profile they are in when they follow it — and never for someone with one, whose
 * addresses stay as they were.
 */
export function useProfileInLink(): (profile: string) => string | null {
  const many = useManyProfiles();
  return (profile) => (many ? profile : null);
}
