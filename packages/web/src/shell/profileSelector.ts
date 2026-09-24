/**
 * What the top profile selector means (ADR 0016, owner 2026-09-24).
 *
 * Two kinds of page, and the selector says something different on each:
 *
 * - **Lists** (chats, new chat, search): lists gather every profile the person may enter.
 *   The selector offers "All profiles" — the default on entering the app — and a profile,
 *   which narrows the lists to it and becomes where new chats are made.
 * - **One profile** (Models, the agents' pages, settings, …): a page that edits one
 *   profile's configuration. The selector shows that profile, concretely, with no "All"
 *   to choose: it is which profile you are editing. Picking another changes what the page
 *   edits and where new things are made; the lists keep the view they had.
 *
 * With a single profile there is nothing to gather or choose between: no "All".
 */
import { createContext, useContext } from 'react';
import { useAuth } from '../auth/context.js';
import { useProfiles } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';

/** The selector's value for "All profiles"; never a slug (`^[a-z0-9]`). */
export const ALL_PROFILES = '*';

export type ProfilePageKind = 'lists' | 'one';

/** Which kind of page the frame is showing; `AppShell` provides it. */
export const ProfilePageContext = createContext<ProfilePageKind>('one');

export interface ProfileSelector {
  value: string;
  options: { value: string; label: string }[];
  onValueChange(next: string | null): void;
}

export function useProfileSelector(): ProfileSelector {
  const { t } = useI18n();
  const { homeProfile, allProfiles, setProfile, setAllProfiles } = useAuth();
  const kind = useContext(ProfilePageContext);
  const items = useProfiles().data ?? [];
  // Until the hub answers, the slug we are in is the only profile we can name.
  const profiles =
    items.length === 0
      ? [{ value: homeProfile, label: homeProfile }]
      : items.map((p) => ({ value: p.slug, label: p.name }));
  const offersAll = kind === 'lists' && items.length > 1;
  return {
    value: offersAll && allProfiles ? ALL_PROFILES : homeProfile,
    options: offersAll
      ? [{ value: ALL_PROFILES, label: t('shell.all_profiles') }, ...profiles]
      : profiles,
    onValueChange(next) {
      if (!next) return;
      if (next === ALL_PROFILES) {
        setAllProfiles(true);
        return;
      }
      setProfile(next);
      // On a list, a profile is a filter as well as a place; on a page that edits one
      // profile it only says which one.
      if (kind === 'lists') setAllProfiles(false);
    },
  };
}

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
