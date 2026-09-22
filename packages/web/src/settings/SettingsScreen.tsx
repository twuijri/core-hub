// One settings screen (NAVIGATION §2). The list of everything Settings holds is in the
// sidebar, which becomes that list while you are here (`settings/SettingsNav.tsx`), so the
// page itself carries one destination and nothing else. Each row is its own URL, so the
// back button works and a settings page can be linked to.
import { useI18n } from '../i18n/context.js';
import { destinationsById, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { phaseOf } from '../screens/PlaceholderScreen.js';
import { EmptyState, Notice } from '../ui/index.js';
import { IconSettings } from '../ui/icons.js';
import { NotificationsTab } from '../notify/NotificationsTab.js';
import { AccountTab } from './AccountTab.js';
import { AuditReport } from './AuditReport.js';
import { DisplayTab } from './DisplayTab.js';
import { ThemeTool } from './ThemeTool.js';

export function SettingsScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const current = id === 'settings' ? 'account' : id;
  const destination = destinationsById.get(id);
  const title = t(termKey(id));

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      {destination?.global && <Notice className="mb-3">{t('settings.global_note')}</Notice>}
      <section aria-labelledby="settings-section">
        <h2 id="settings-section" className="mb-3 text-lg font-semibold">
          {t(termKey(current))}
        </h2>
        {current === 'account' && <AccountTab />}
        {current === 'notifications' && <NotificationsTab />}
        {current === 'display' && <DisplayTab />}
        {current === 'theme' && <ThemeTool />}
        {/* The three reports the audit module answers; `skills` is still a 501 and stays
            a placeholder, which is what the hub itself says about it. */}
        {(current === 'usage' || current === 'logs' || current === 'performance') && (
          <AuditReport kind={current} />
        )}
        {current !== 'account' &&
          current !== 'notifications' &&
          current !== 'display' &&
          current !== 'theme' &&
          current !== 'usage' &&
          current !== 'logs' &&
          current !== 'performance' && (
            <EmptyState
              icon={<IconSettings size={20} />}
              title={t(termKey(current))}
              body={t('placeholder.later', {
                name: t(termKey(current)),
                phase: phaseOf(destination?.module),
              })}
            />
          )}
      </section>
    </AppShell>
  );
}
