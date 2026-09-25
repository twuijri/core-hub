import { PRODUCT } from '@corehub/contracts';
import { useMeta } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { IconMenu, IconPanel } from '../ui/icons.js';
import { usePane } from './pane.js';
import { BackgroundTasks } from './BackgroundTasks.js';
import { PendingActions } from './PendingActions.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

export function TopBar({ title, onMenu }: { title: string; onMenu: () => void }) {
  const { t } = useI18n();
  const pane = usePane();
  const meta = useMeta();
  // The hub answers its name in English; the product's own name reads in the person's
  // language («كور هب»), and a name the owner set is shown as they wrote it.
  const served = meta.data?.name;
  const hubName = !served || served === PRODUCT.name ? t('app.name') : served;
  return (
    <header
      className="glass sticky top-0 z-[var(--ch-z-chrome)] flex items-center gap-2 border-b px-3"
      style={{ blockSize: 'var(--ch-layout-topbar-height)' }}
    >
      <button
        type="button"
        className="btn btn-ghost px-1.5 md:hidden"
        onClick={onMenu}
        aria-label={t('shell.open_menu')}
      >
        <IconMenu />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold" dir="auto">
        {title}
      </h1>
      <span className="hidden text-xs text-muted sm:inline" dir="auto">
        {hubName}
      </span>
      <BackgroundTasks />
      <PendingActions />
      <WorkspaceSwitcher />
      {pane.content && pane.collapsed && (
        <button
          type="button"
          className="btn btn-ghost px-1.5"
          onClick={pane.toggle}
          aria-label={t('pane.expand')}
        >
          <IconPanel />
        </button>
      )}
    </header>
  );
}
