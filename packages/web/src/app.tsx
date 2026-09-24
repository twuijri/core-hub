import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HubApiError } from '@majlis/contracts';
import { useMemo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './auth/context.js';
import { SessionStore } from './auth/store.js';
import { ThemeProvider, useTheme } from './design/theme.js';
import { I18nProvider } from './i18n/context.js';
import { canOpen, legacyRedirect, navigation } from './navigation/manifest.js';
import { HOME_PATH, LOGIN_PATH, SETUP_PATH, routes } from './navigation/routes.js';
import { RealtimeProvider } from './realtime/context.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { SetupScreen } from './screens/SetupScreen.js';
import { ProfileGate } from './shell/ProfileGate.js';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();
  if (!session) return <Navigate to={LOGIN_PATH} replace state={{ from: location.pathname }} />;
  return (
    <ProfileGate>
      <RealtimeProvider>{children}</RealtimeProvider>
    </ProfileGate>
  );
}

/**
 * A destination the person's role may not open is not drawn for them: the router refuses what
 * the menu hides (NAVIGATION rule 6), and sends them home. The hub refuses the data anyway;
 * this keeps a typed or bookmarked URL from opening a shell full of refusals.
 */
function RequireRole({ id, children }: { id: string; children: ReactNode }) {
  const { session } = useAuth();
  if (!canOpen(id, session?.user.role ?? 'member')) return <Navigate to={HOME_PATH} replace />;
  return children;
}

/** An old URL (`legacyRoutes.web`) goes to where that page lives now, the rest kept. */
function LegacyRedirect() {
  const location = useLocation();
  const pathname = legacyRedirect(location.pathname) ?? HOME_PATH;
  return <Navigate to={{ pathname, search: location.search, hash: location.hash }} replace />;
}

const LEGACY_PREFIXES = Object.keys(navigation.legacyRoutes?.web ?? {}).filter(
  (from) => !from.startsWith('$'),
);

function Localised({ children }: { children: ReactNode }) {
  const { prefs } = useTheme();
  return <I18nProvider language={prefs.language}>{children}</I18nProvider>;
}

export interface AppProps {
  store?: SessionStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  router?: (children: ReactNode) => ReactNode;
}

export function App({ store, baseUrl, fetchImpl, router }: AppProps) {
  const sessionStore = useMemo(
    () => store ?? new SessionStore(typeof localStorage === 'undefined' ? null : localStorage),
    [store],
  );
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, error) => !(error instanceof HubApiError) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
    [],
  );
  const tree = (
    <Routes>
      <Route path={LOGIN_PATH} element={<LoginScreen />} />
      <Route path={SETUP_PATH} element={<SetupScreen />} />
      <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
      {routes.map((route) => (
        <Route
          key={route.id}
          path={route.path}
          element={
            <RequireAuth>
              <RequireRole id={route.id}>{route.element}</RequireRole>
            </RequireAuth>
          }
        />
      ))}
      {LEGACY_PREFIXES.map((from) => (
        <Route key={from} path={`${from}/*`} element={<LegacyRedirect />} />
      ))}
      <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
    </Routes>
  );
  return (
    <ThemeProvider>
      <Localised>
        <QueryClientProvider client={queryClient}>
          <AuthProvider
            store={sessionStore}
            {...(baseUrl !== undefined ? { baseUrl } : {})}
            {...(fetchImpl ? { fetchImpl } : {})}
          >
            {router ? router(tree) : <BrowserRouter>{tree}</BrowserRouter>}
          </AuthProvider>
        </QueryClientProvider>
      </Localised>
    </ThemeProvider>
  );
}
