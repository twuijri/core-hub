// One settings screen (NAVIGATION §2): tabs across the top, the Tools section at the bottom.
// Each tab and each tool is its own destination; this component renders whichever is open.
import { NavLink } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import {
  destinationsById,
  navigation,
  routeOf,
  termKey,
  visibleEntries,
} from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { phaseOf } from '../screens/PlaceholderScreen.js';
import { Notice } from '../ui/Notice.js';
import { AccountTab } from './AccountTab.js';
import { DisplayTab } from './DisplayTab.js';
import { ThemeTool } from './ThemeTool.js';

export function SettingsScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const role = user?.role ?? 'member';
  const tabs = visibleEntries(navigation.settingsTabs, role);
  const tools = visibleEntries(navigation.settingsTools, role);
  const current = id === 'settings' ? 'account' : id;
  const destination = destinationsById.get(id);
  const isTool = navigation.settingsTools.includes(id);
  const title = t(termKey(id));

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      {!isTool && (
        <nav
          className="mb-4 flex flex-wrap gap-1 border-b border-line pb-2"
          aria-label={t('nav.settings')}
          data-testid="settings-tabs"
        >
          {tabs.map((d) => (
            <NavLink
              key={d.id}
              to={routeOf(d.id)}
              data-nav-id={d.id}
              className={`rounded-md px-3 py-1 text-sm ${current === d.id ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2'}`}
            >
              {t(termKey(d.id))}
            </NavLink>
          ))}
        </nav>
      )}
      {destination?.global && <Notice className="mb-3">{t('settings.global_note')}</Notice>}
      <section aria-labelledby="settings-section">
        <h2 id="settings-section" className="mb-3 text-lg font-semibold">
          {t(termKey(current))}
        </h2>
        {current === 'account' && <AccountTab />}
        {current === 'display' && <DisplayTab />}
        {current === 'theme' && <ThemeTool />}
        {current !== 'account' && current !== 'display' && current !== 'theme' && (
          <Notice>
            {t('placeholder.later', {
              name: t(termKey(current)),
              phase: phaseOf(destination?.module),
            })}
          </Notice>
        )}
      </section>
      {!isTool && (
        <section className="mt-8 border-t border-line pt-4" aria-labelledby="settings-tools">
          <h2 id="settings-tools" className="mb-2 text-sm font-medium text-muted">
            {t('settings.tools')}
          </h2>
          <ul className="flex flex-wrap gap-2" data-testid="settings-tools">
            {tools.map((d) => (
              <li key={d.id}>
                <NavLink to={routeOf(d.id)} data-nav-id={d.id} className="btn">
                  {t(termKey(d.id))}
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {isTool && (
        <p className="mt-6">
          <NavLink to={routeOf('settings')} className="link text-sm underline">
            {t('settings.back')}
          </NavLink>
        </p>
      )}
    </AppShell>
  );
}
