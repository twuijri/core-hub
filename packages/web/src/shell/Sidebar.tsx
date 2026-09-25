// The sidebar of NAVIGATION §1: header, rail, segments, the selected segment's list, footer.
// Entry labels come from the same term key as the screen titles (rule "entry = title").
//
// What it contains is decided here; what a sidebar *is* — the glass rail, the brand row,
// the row geometry, the scrolling middle, the footer — comes from `ui/SidebarShell.tsx`,
// so the phone drawer and any later rail are assembled from the same pieces rather than
// drawn again (docs/clients/DESIGN.md §UI policy).
import { derived } from '@corehub/contracts';
import { useEffect, type ReactElement } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useTheme, themeIcon, nextTheme } from '../design/theme.js';
import { useI18n } from '../i18n/context.js';
import { useMeta } from '../hub/queries.js';
import {
  agentPageFromPath,
  navigation,
  routeOf,
  termKey,
  visibleEntries,
} from '../navigation/manifest.js';
import { useRealtime } from '../realtime/context.js';
import { RoomList } from '../rooms/RoomList.js';
import { SessionList } from '../sessions/SessionList.js';
import { SettingsNav, settingsIdFromPath } from '../settings/SettingsNav.js';
import { AgentBackRow, AgentNav } from '../agents/AgentNav.js';
import {
  IconAgents,
  IconArrowStart,
  IconGlobe,
  IconPlus,
  IconSchedules,
  IconSearch,
  IconSettings,
  IconSignOut,
  IconTasks,
} from '../ui/icons.js';
import {
  Badge,
  CoreHubMark,
  Button,
  Segmented,
  SidebarBody,
  SidebarBrand,
  SidebarFooter,
  SidebarFrame,
  SidebarGroup,
  SidebarRow,
  Tooltip,
} from '../ui/index.js';
import { useNoticeStream } from '../notify/queries.js';
import { useDesktopEffects } from '../desktop/effects.js';

const RAIL_ICONS: Record<string, (p: { size?: number }) => ReactElement> = {
  new_chat: IconPlus,
  search: IconSearch,
  agent_manager: IconAgents,
  tasks: IconTasks,
  schedules: IconSchedules,
};

const SEGMENT_STORAGE = `${derived.storagePrefix}segment`;
/** The last page outside Settings, for the sidebar's way back (per tab, not per device). */
const LAST_OUTSIDE_SETTINGS = `${derived.storagePrefix}before-settings`;

export function segmentFromPath(pathname: string): string | null {
  for (const id of navigation.segments) {
    const base = routeOf(id).split('/:')[0] ?? '';
    if (pathname === base || pathname.startsWith(`${base}/`)) return id;
  }
  return null;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  // The inbox is watched here rather than on its own page: the unread count rides in the
  // Settings list, which is on screen when that page is not.
  useNoticeStream();
  useDesktopEffects();
  const { t, language } = useI18n();
  const { user, signOut } = useAuth();
  const { prefs, update } = useTheme();
  const realtime = useRealtime();
  const meta = useMeta();
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
  // Opening a session from Search does not change the selected segment (rule §1).
  const selected = segmentFromPath(location.pathname) ?? stored ?? 'chat';
  /**
   * Inside Settings the sidebar becomes the settings list (owner correction, 2026-09-22):
   * the list of places belongs here, and the page keeps the whole column for itself.
   */
  const settingsId = settingsIdFromPath(location.pathname);
  /**
   * Inside an agent's pages the sidebar becomes that agent's list, the same way (owner,
   * 2026-09-24): a row back to the Agents page, the agent, and its pages.
   */
  const agentPage = settingsId === null ? agentPageFromPath(location.pathname) : null;
  /**
   * Inside Settings the rail gives way to one row back to where the person was (owner,
   * 2026-09-23: «اذا دخلت الاعدادات تروح رسالة جديدة والسيرش … واذا برجع للمحادثات يصير فيه
   * زر رجوع»). Where they were is the last page outside Settings — the conversation they
   * had open — and a new chat when Settings was the first page of the visit.
   */
  useEffect(() => {
    if (settingsId !== null) return;
    try {
      sessionStorage.setItem(LAST_OUTSIDE_SETTINGS, `${location.pathname}${location.search}`);
    } catch {
      // fine: the way back is then a new chat
    }
  }, [settingsId, location.pathname, location.search]);
  const backTo = (() => {
    try {
      return sessionStorage.getItem(LAST_OUTSIDE_SETTINGS);
    } catch {
      return null;
    }
  })();
  const chooseSegment = (id: string) => {
    try {
      localStorage.setItem(SEGMENT_STORAGE, id);
    } catch {
      // fine
    }
    if (segmentFromPath(location.pathname) !== id) navigate(routeOf(id).split('/:')[0] ?? '/');
  };
  const connectionTone =
    realtime.state === 'connected'
      ? 'success'
      : realtime.state === 'connecting'
        ? 'warning'
        : 'danger';

  return (
    <SidebarFrame label={t('shell.sidebar')}>
      <SidebarBrand mark={<CoreHubMark size={28} />} name={t('app.name')} />

      {/* Slim by design (NAVIGATION §1): starting a chat, finding one, the agents, tasks,
          schedules, and the list. Everything configured once lives on a page inside
          Settings. */}
      {agentPage !== null ? (
        <AgentBackRow onNavigate={onNavigate} />
      ) : settingsId !== null ? (
        <SidebarGroup testId="settings-back">
          <SidebarRow
            icon={<IconArrowStart size={18} />}
            label={t('shell.back_to_chats')}
            render={({ className, children }) => (
              <Link
                to={backTo ?? routeOf('new_chat')}
                onClick={onNavigate}
                className={className}
                data-testid="back-to-chats"
              >
                {children}
              </Link>
            )}
          />
        </SidebarGroup>
      ) : (
        <SidebarGroup testId="rail">
          {rail.map((d, index) => {
            const Icon = RAIL_ICONS[d.id] ?? IconSearch;
            return (
              <SidebarRow
                key={d.id}
                icon={<Icon size={18} />}
                label={t(termKey(d.id))}
                emphasis={index === 0 ? 'primary' : 'normal'}
                render={({ className, children }) => (
                  <NavLink
                    to={routeOf(d.id)}
                    onClick={onNavigate}
                    data-nav-id={d.id}
                    className={({ isActive }) => `${className} ${isActive ? 'active' : ''}`}
                  >
                    {children}
                  </NavLink>
                )}
              />
            );
          })}
        </SidebarGroup>
      )}

      {settingsId === null && agentPage === null && (
        <div className="mx-2 mt-3">
          <Segmented
            label={t('shell.segments')}
            value={selected}
            onChange={chooseSegment}
            size="sm"
            stretch
            testId="segments"
            options={segments.map((d) => ({
              value: d.id,
              label: t(termKey(d.id)),
              itemProps: { 'data-nav-id': d.id },
            }))}
          />
        </div>
      )}

      <SidebarBody>
        {settingsId !== null ? (
          <SettingsNav current={settingsId} onNavigate={onNavigate} />
        ) : agentPage !== null ? (
          <AgentNav agentId={agentPage.agentId} current={agentPage.id} onNavigate={onNavigate} />
        ) : selected === 'chat' ? (
          <SessionList {...(onNavigate ? { onOpen: onNavigate } : {})} />
        ) : selected === 'rooms' ? (
          <RoomList {...(onNavigate ? { onOpen: onNavigate } : {})} />
        ) : (
          <p className="px-2 text-xs text-muted">
            {t('shell.segment_later', { name: t(termKey(selected)) })}
          </p>
        )}
      </SidebarBody>

      <SidebarFooter testId="footer">
        {/* The profile is switched in the top bar only, and the model in the composer and on
            Models: the footer no longer repeats either (owner, 2026-09-24). */}
        <div className="flex items-center gap-2">
          <Tooltip label={t(`shell.connection.${realtime.state}`)}>
            <span tabIndex={0} role="status" aria-label={t(`shell.connection.${realtime.state}`)}>
              <Badge tone={connectionTone} dot>
                {t(`shell.connection.${realtime.state}`)}
              </Badge>
            </span>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {user?.display_name ?? user?.username}
          </span>
          {visibleEntries(navigation.footer, role).map((d) => (
            <Tooltip key={d.id} label={t(termKey(d.id))}>
              <NavLink
                to={routeOf(d.id)}
                onClick={onNavigate}
                data-nav-id={d.id}
                className="ch-btn ch-btn-ghost ch-btn-sm"
                data-icon-only="true"
                aria-label={t(termKey(d.id))}
              >
                <IconSettings size={16} />
              </NavLink>
            </Tooltip>
          ))}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            tooltip={t('nav.sign_out')}
            aria-label={t('nav.sign_out')}
            icon={<IconSignOut size={16} />}
            onClick={() => void signOut()}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconGlobe size={12} />}
            aria-label={t('shell.language_chip')}
            onClick={() => update({ language: language === 'ar' ? 'en' : 'ar' })}
          >
            {language === 'ar' ? 'العربية' : 'English'}
          </Button>
          {/* One button, and a press moves to the next: light → dark → system → light.
              Three symbols side by side asked the person to work out which of them was
              the selected one, and in a dark theme the highlight that says so is the
              faintest thing on the row. One button has nothing to compare: what it shows
              is what is on. The full picker is still on the Display page, for choosing
              rather than cycling. */}
          <Tooltip label={t(`display.theme.${prefs.theme}`)}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('shell.theme_next', {
                next: t(`display.theme.${nextTheme(prefs.theme)}`),
              })}
              data-testid="theme-chip"
              data-theme-choice={prefs.theme}
              onClick={() => update({ theme: nextTheme(prefs.theme) })}
            >
              {themeIcon(prefs.theme, 15)}
            </Button>
          </Tooltip>
          {/* The version that is *running*, which is the hub's — the browser may be
              holding an older bundle. The build constant answers only until the hub does. */}
          <span className="ms-auto text-faint" data-testid="app-version">
            v{meta.data?.server_version ?? __APP_VERSION__}
          </span>
        </div>
      </SidebarFooter>
    </SidebarFrame>
  );
}
