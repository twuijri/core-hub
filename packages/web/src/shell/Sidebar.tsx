// The sidebar of NAVIGATION §1: header, rail, segments, the selected segment's list, footer.
// Entry labels come from the same term key as the screen titles (rule "entry = title").
import type { ReactElement } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useTheme, THEME_CHOICES } from '../design/theme.js';
import { useI18n } from '../i18n/context.js';
import { navigation, routeOf, termKey, visibleEntries } from '../navigation/manifest.js';
import { useRealtime } from '../realtime/context.js';
import { SessionList } from '../sessions/SessionList.js';
import { IconGlobe, IconPlus, IconSearch, IconSettings, IconSignOut } from '../ui/icons.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

const RAIL_ICONS: Record<string, (p: { size?: number }) => ReactElement> = {
  new_chat: IconPlus,
  search: IconSearch,
};

const SEGMENT_STORAGE = 'majlis.segment';

export function segmentFromPath(pathname: string): string | null {
  for (const id of navigation.segments) {
    const base = routeOf(id).split('/:')[0] ?? '';
    if (pathname === base || pathname.startsWith(`${base}/`)) return id;
  }
  return null;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t, language } = useI18n();
  const { user, signOut } = useAuth();
  const { prefs, update } = useTheme();
  const realtime = useRealtime();
  const location = useLocation();
  const navigate = useNavigate();
  const role = user?.role ?? 'member';
  const rail = visibleEntries(navigation.rail, role);
  const segments = visibleEntries(navigation.segments, role);
  const stored = (() => {
    try {
      return localStorage.getItem(SEGMENT_STORAGE);
    } catch {
      return null;
    }
  })();
  // Opening a session from History or Search does not change the selected segment (rule §1).
  const fromPath = segmentFromPath(location.pathname);
  const selected = fromPath === 'history' ? (stored ?? 'chat') : (fromPath ?? stored ?? 'chat');
  const chooseSegment = (id: string) => {
    try {
      localStorage.setItem(SEGMENT_STORAGE, id);
    } catch {
      // fine
    }
    if (id === 'history') {
      navigate(routeOf('history'));
      onNavigate?.();
    } else if (segmentFromPath(location.pathname) !== id)
      navigate(routeOf(id).split('/:')[0] ?? '/');
  };
  const nextTheme =
    THEME_CHOICES[(THEME_CHOICES.indexOf(prefs.theme) + 1) % THEME_CHOICES.length] ?? 'system';

  return (
    <nav
      className="glass flex h-full w-[var(--mj-layout-sidebar-width)] shrink-0 flex-col border-e"
      aria-label={t('shell.sidebar')}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <span
          className="inline-grid size-7 place-items-center rounded-md bg-accent text-accent-text"
          aria-hidden
        >
          م
        </span>
        <span className="text-base font-semibold">{t('app.name')}</span>
      </div>

      {/* Slim by design (NAVIGATION §1, 2026-09-22): starting a chat, finding one, and the
          list. Everything configured once lives on a page inside Settings. */}
      <ul className="flex flex-col gap-1 px-2" data-testid="rail">
        {rail.map((d, index) => {
          const Icon = RAIL_ICONS[d.id] ?? IconSearch;
          const primary = index === 0;
          return (
            <li key={d.id}>
              <NavLink
                to={routeOf(d.id)}
                onClick={onNavigate}
                data-nav-id={d.id}
                className={({ isActive }) =>
                  primary
                    ? 'btn btn-primary w-full justify-start'
                    : `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-ui hover:bg-surface-2 ${isActive ? 'bg-surface-2 font-medium' : ''}`
                }
              >
                <Icon size={18} />
                <span>{t(termKey(d.id))}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>

      <div
        className="segmented mx-2 mt-3"
        role="tablist"
        aria-label={t('shell.segments')}
        data-testid="segments"
      >
        {segments.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={selected === d.id}
            aria-pressed={selected === d.id}
            data-nav-id={d.id}
            onClick={() => chooseSegment(d.id)}
          >
            {t(termKey(d.id))}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {selected === 'chat' ? (
          <SessionList {...(onNavigate ? { onOpen: onNavigate } : {})} />
        ) : selected === 'history' ? (
          <p className="px-2 text-xs text-muted">{t('shell.history_is_page')}</p>
        ) : (
          <p className="px-2 text-xs text-muted">
            {t('shell.segment_later', { name: t(termKey(selected)) })}
          </p>
        )}
      </div>

      <footer
        className="flex flex-col gap-2 border-t border-line px-3 py-2 text-xs"
        data-testid="footer"
      >
        <div className="flex flex-wrap items-center gap-2">
          <WorkspaceSwitcher compact />
          <span className="chip" title={t('shell.model_chip')}>
            {t('shell.model_default')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full ${realtime.state === 'connected' ? 'bg-accent' : realtime.state === 'connecting' ? 'bg-warning-soft-text' : 'bg-danger'}`}
            role="status"
            aria-label={t(`shell.connection.${realtime.state}`)}
            title={t(`shell.connection.${realtime.state}`)}
          />
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {user?.display_name ?? user?.username}
          </span>
          {visibleEntries(navigation.footer, role).map((d) => (
            <NavLink
              key={d.id}
              to={routeOf(d.id)}
              onClick={onNavigate}
              data-nav-id={d.id}
              className="btn btn-ghost px-1.5"
              aria-label={t(termKey(d.id))}
              title={t(termKey(d.id))}
            >
              <IconSettings />
            </NavLink>
          ))}
          <button
            type="button"
            className="btn btn-ghost px-1.5"
            onClick={() => void signOut()}
            aria-label={t('nav.sign_out')}
            title={t('nav.sign_out')}
          >
            <IconSignOut />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="chip"
            onClick={() => update({ language: language === 'ar' ? 'en' : 'ar' })}
            aria-label={t('shell.language_chip')}
          >
            <IconGlobe size={12} /> {language === 'ar' ? 'العربية' : 'English'}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => update({ theme: nextTheme })}
            aria-label={t('shell.theme_chip')}
            data-testid="theme-chip"
          >
            {t(`display.theme.${prefs.theme}`)}
          </button>
          <span className="ms-auto text-faint">v{__APP_VERSION__}</span>
        </div>
      </footer>
    </nav>
  );
}
