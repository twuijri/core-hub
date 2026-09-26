import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ChromeScope } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { DesktopUpdateNotice } from '../desktop/UpdateNotice.js';
import { agentPageFromPath, navigation, routeOf } from '../navigation/manifest.js';
import { IconArrowStart } from '../ui/icons.js';
import { Sheet } from '../ui/index.js';
import { PaneProvider } from './pane.js';
import { Sidebar } from './Sidebar.js';
import { SplitPane } from './SplitPane.js';
import { TopBar } from './TopBar.js';
import { TopBarSlotProvider } from './topBarSlot.js';

/**
 * The frame: sidebar (glass) · the page · the split pane at the inline end.
 *
 * Every page takes the whole width beside the sidebar (owner decision, 2026-09-23: «كل مكان
 * بالسستم ما ياخذ كل الصفحه كل شي يتوسط؟» → «كل شي بعرض كامل»). What must stay narrow to be
 * read — the composer, a dialog — keeps its own width.
 */
export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  // The place in the top bar a page puts its own controls in (`topBarSlot.tsx`).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    document.title = `${title} · ${t('app.name')}`;
  }, [title, t]);

  return (
    <PaneProvider>
      <div className="flex h-dvh overflow-hidden bg-bg text-ink">
        {/* The frame speaks for the person, whatever profile the page's own content is in
            (`ChromeScope`, ADR 0016): the list and the selector never follow an opened item. */}
        <div className="hidden shrink-0 md:block">
          <ChromeScope>
            <Sidebar />
          </ChromeScope>
        </div>
        {/* On a phone the same sidebar arrives as a drawer. It is the kit's `Sheet` — one
            focus trap, one Escape, one scrim, and it slides from the reading direction's
            own side without a second rule (DESIGN §UI policy). */}
        <Sheet
          open={menuOpen}
          onOpenChange={setMenuOpen}
          side="inline-start"
          title={t('shell.sidebar')}
          closeLabel={t('shell.close_menu')}
          testId="menu-drawer"
        >
          <ChromeScope>
            <Sidebar onNavigate={() => setMenuOpen(false)} />
          </ChromeScope>
        </Sheet>
        <div className="flex min-w-0 flex-1 flex-col">
          <ChromeScope>
            <TopBar title={title} onMenu={() => setMenuOpen(true)} slotRef={setSlot} />
          </ChromeScope>
          <div className="flex min-h-0 flex-1">
            <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto" id="main">
              <div className="flex w-full flex-1 flex-col px-4 py-4">
                {/* On a phone the agent's list is the drawer, so the page it opened shows
                    the way back itself (the Settings pattern, NAVIGATION §4). */}
                {agentPageFromPath(location.pathname) && (
                  <Link
                    to={routeOf(navigation.agentShell.returnsTo)}
                    className="mb-3 inline-flex items-center gap-1 self-start text-sm text-muted md:hidden"
                    data-testid="agent-page-back"
                  >
                    <IconArrowStart size={16} />
                    {t(`nav.${navigation.agentShell.back}`)}
                  </Link>
                )}
                <TopBarSlotProvider value={slot}>{children}</TopBarSlotProvider>
              </div>
            </main>
            <SplitPane />
          </div>
        </div>
        {/* The desktop app's new version, when there is one (nothing in a browser). */}
        <DesktopUpdateNotice />
      </div>
    </PaneProvider>
  );
}
