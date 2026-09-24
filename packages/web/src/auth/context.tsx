import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { HubClient } from '@majlis/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n/context.js';
import { createClientBundle } from './client.js';
import { expiresAt, type SessionStore, type StoredSession, type StoredUser } from './store.js';

export interface AuthValue {
  baseUrl: string;
  session: StoredSession | null;
  user: StoredUser | null;
  /**
   * The workspace scope every request carries (ADR 0005). Inside a `ProfileScope` it is
   * that item's profile (a conversation from another profile); everywhere else it is
   * `homeProfile`.
   */
  profile: string;
  /**
   * The concrete profile the person is in: where a new chat or task is created and which
   * profile a configuration page edits (ADR 0016). Never changed by opening an item.
   */
  homeProfile: string;
  setProfile(slug: string): void;
  /**
   * Lists gather every profile the person may enter (ADR 0016). On by default every time
   * the app is entered; kept in memory only, so a reload starts on "All profiles" again.
   */
  allProfiles: boolean;
  setAllProfiles(on: boolean): void;
  client: HubClient;
  anonymous: HubClient;
  signIn(username: string, password: string): Promise<StoredSession>;
  /** First run only (ADR 0011): trade the hub's setup token for the owner account. */
  completeSetup(input: SetupInput): Promise<StoredSession>;
  signOut(): Promise<void>;
}

export interface SetupInput {
  token: string;
  username: string;
  password: string;
  displayName?: string;
  workspaceName?: string;
}

const AuthContext = createContext<AuthValue | null>(null);
/** The provider's own value, which no `ProfileScope` overrides (`ChromeScope`). */
const RootAuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({
  children,
  store,
  baseUrl = typeof window === 'undefined' ? '' : window.location.origin,
  fetchImpl,
}: {
  children: ReactNode;
  store: SessionStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}) {
  const { language } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const queryClient = useQueryClient();
  const session = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.read(),
    () => store.read(),
  );

  const bundle = useMemo(
    () =>
      createClientBundle({
        baseUrl,
        store,
        language: () => languageRef.current,
        profile: () => store.read()?.profile,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onSignedOut: () => queryClient.clear(),
      }),
    [baseUrl, store, fetchImpl, queryClient],
  );

  /** `auth.login` and `auth.completeSetup` answer the same `TokenPair`; one place stores it. */
  const remember = useCallback(
    (data: {
      access_token: string;
      refresh_token: string | null;
      expires_in: number;
      user: {
        id: string;
        username: string;
        display_name: string;
        role: string;
        default_profile: string;
      };
    }) => {
      const next: StoredSession = {
        profile: data.user.default_profile,
        token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt(data.expires_in),
        user: {
          id: data.user.id,
          username: data.user.username,
          display_name: data.user.display_name,
          role: data.user.role,
        },
      };
      store.save(next);
      return next;
    },
    [store],
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      const { data } = await bundle.anonymous.request('post', '/auth/login', {
        body: { username: username.trim(), password },
        headers: { 'Accept-Language': languageRef.current },
      });
      return remember(data);
    },
    [bundle, remember],
  );

  const completeSetup = useCallback(
    async (input: SetupInput) => {
      const { data } = await bundle.anonymous.request('post', '/auth/setup', {
        body: {
          token: input.token.trim(),
          username: input.username.trim(),
          password: input.password,
          ...(input.displayName?.trim() ? { display_name: input.displayName.trim() } : {}),
          ...(input.workspaceName?.trim() ? { workspace_name: input.workspaceName.trim() } : {}),
        },
        headers: { 'Accept-Language': languageRef.current },
      });
      // The hub is set up now: anything that cached "setup required" must ask again.
      await queryClient.invalidateQueries();
      return remember(data);
    },
    [bundle, remember, queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await bundle.client.request('post', '/auth/logout');
    } catch {
      // Already revoked or unreachable: forgetting it locally is still right.
    } finally {
      store.clear();
      queryClient.clear();
    }
  }, [bundle, store, queryClient]);

  // Every entry into the app starts on "All profiles" (owner, 2026-09-24: «كل البروفايلات
  // افتراضيا»), not on the last profile the lists were narrowed to.
  const [allProfiles, setAllProfiles] = useState(true);

  const setProfile = useCallback(
    (slug: string) => {
      const current = store.read();
      if (!current || current.profile === slug) return;
      store.save({ ...current, profile: slug });
      // A workspace is a filter, not a route: every scoped query refetches, nothing navigates.
      void queryClient.invalidateQueries();
    },
    [store, queryClient],
  );

  const value = useMemo<AuthValue>(
    () => ({
      baseUrl,
      session,
      user: session?.user ?? null,
      profile: session?.profile ?? 'default',
      homeProfile: session?.profile ?? 'default',
      setProfile,
      allProfiles,
      setAllProfiles,
      client: bundle.client,
      anonymous: bundle.anonymous,
      signIn,
      completeSetup,
      signOut,
    }),
    [baseUrl, session, setProfile, allProfiles, bundle, signIn, completeSetup, signOut],
  );
  return (
    <RootAuthContext.Provider value={value}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </RootAuthContext.Provider>
  );
}

/**
 * Everything inside works in `profile` — one conversation from another profile — without
 * touching the person's own profile or the top selector (ADR 0016). Each request carries
 * `X-Hub-Profile: <profile>` unless it names one itself, and every query key built from
 * `useAuth().profile` is that profile's, so its models, agents and settings are its own.
 */
export function ProfileScope({ profile, children }: { profile: string; children: ReactNode }) {
  const parent = useAuth();
  const value = useMemo<AuthValue>(() => {
    if (profile === parent.profile) return parent;
    const raw: HubClient['raw'] = (method, path, init) =>
      parent.client.raw(method, path, {
        ...init,
        headers: { 'X-Hub-Profile': profile, ...init?.headers },
      });
    return {
      ...parent,
      profile,
      client: { raw, request: raw as unknown as HubClient['request'] },
    };
  }, [parent, profile]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The frame around a page — sidebar, top bar — always speaks for the person, never for the
 * item a page has scoped itself to: the chats list and the selector stay where they were
 * while a conversation from another profile is open.
 */
export function ChromeScope({ children }: { children: ReactNode }) {
  const root = useContext(RootAuthContext);
  if (!root) return <>{children}</>;
  return <AuthContext.Provider value={root}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
