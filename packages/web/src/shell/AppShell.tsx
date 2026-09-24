import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ChromeScope } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { Sheet } from '../ui/index.js';
import { PaneProvider } from './pane.js';
import { ProfilePageContext, type ProfilePageKind } from './profileSelector.js';
import { Sidebar } from './Sidebar.js';
import { SplitPane } from './SplitPane.js';
import { TopBar } from './TopBar.js';

/**
 * The frame: sidebar (glass) · the page · the split pane at the inline end.
 *
 * Every page takes the whole width beside the sidebar (owner decision, 2026-09-23: «كل مكان
 * بالسستم ما ياخذ كل الصفحه كل شي يتوسط؟» → «كل شي بعرض كامل»). What must stay narrow to be
 * read — the composer, a dialog — keeps its own width.
 */
export function AppShell({
  title,
  children,
  profiles = 'one',
}: {
  title: string;
  children: ReactNode;
  /**
   * `lists` for the pages that gather every profile (chats, new chat, search), `one` for a
   * page that edits one profile — what the top selector offers (ADR 0016).
   */
  profiles?: ProfilePageKind;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    document.title = `${title} · ${t('app.name')}`;
  }, [title, t]);

  // The frame speaks for the person, whatever profile the page's own content is in
  // (`ChromeScope`): the chats list and the selector never follow an opened item.
  return (
    <PaneProvider>
      <ProfilePageContext.Provider value={profiles}>
        <div className="flex h-dvh overflow-hidden bg-bg text-ink">
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
              <TopBar title={title} onMenu={() => setMenuOpen(true)} />
            </ChromeScope>
            <div className="flex min-h-0 flex-1">
              <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto" id="main">
                <div className="flex w-full flex-1 flex-col px-4 py-4">{children}</div>
              </main>
              <SplitPane />
            </div>
          </div>
        </div>
      </ProfilePageContext.Provider>
    </PaneProvider>
  );
}
