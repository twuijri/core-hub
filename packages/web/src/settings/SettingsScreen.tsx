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
import { AccountTab } from './AccountTab.js';
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
        {current === 'display' && <DisplayTab />}
        {current === 'theme' && <ThemeTool />}
        {current !== 'account' && current !== 'display' && current !== 'theme' && (
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
