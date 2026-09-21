import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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
  /** The workspace scope every request and socket carries (ADR 0005). */
  profile: string;
  setProfile(slug: string): void;
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
      user: { id: string; username: string; display_name: string; role: string; default_profile: string };
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
      setProfile,
      client: bundle.client,
      anonymous: bundle.anonymous,
      signIn,
      completeSetup,
      signOut,
    }),
    [baseUrl, session, setProfile, bundle, signIn, completeSetup, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
