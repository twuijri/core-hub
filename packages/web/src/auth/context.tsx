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
  signOut(): Promise<void>;
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

  const signIn = useCallback(
    async (username: string, password: string) => {
      const { data } = await bundle.anonymous.request('post', '/auth/login', {
        body: { username: username.trim(), password },
        headers: { 'Accept-Language': languageRef.current },
      });
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
    [bundle, store],
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
      signOut,
    }),
    [baseUrl, session, setProfile, bundle, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
