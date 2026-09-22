import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { Sheet } from '../ui/index.js';
import { PaneProvider } from './pane.js';
import { Sidebar } from './Sidebar.js';
import { SplitPane } from './SplitPane.js';
import { TopBar } from './TopBar.js';

/**
 * The frame: sidebar (glass) · one centred reading column · the split pane at the inline end.
 * The column width is the layout token `reading-max` (≈48rem); the composer floats inside it.
 */
export function AppShell({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    document.title = `${title} · ${t('app.name')}`;
  }, [title, t]);

  return (
    <PaneProvider>
      <div className="flex h-dvh overflow-hidden bg-bg text-ink">
        <div className="hidden shrink-0 md:block">
          <Sidebar />
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
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </Sheet>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar title={title} onMenu={() => setMenuOpen(true)} />
          <div className="flex min-h-0 flex-1">
            <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto" id="main">
              <div
                className={`mx-auto flex w-full flex-1 flex-col px-4 py-4 ${wide ? '' : 'max-w-[var(--mj-layout-reading-max)]'}`}
              >
                {children}
              </div>
            </main>
            <SplitPane />
          </div>
        </div>
      </div>
    </PaneProvider>
  );
}
