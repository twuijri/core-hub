// One settings screen (NAVIGATION §2). The list of everything Settings holds is in the
// sidebar, which becomes that list while you are here (`settings/SettingsNav.tsx`), so the
// page itself carries one destination and nothing else. Each row is its own URL, so the
// back button works and a settings page can be linked to.
import type { ReactElement } from 'react';
import { useI18n } from '../i18n/context.js';
import { destinationsById, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { phaseOf } from '../screens/PlaceholderScreen.js';
import { EmptyState, Notice } from '../ui/index.js';
import { IconSettings } from '../ui/icons.js';
import { NotificationsTab } from '../notify/NotificationsTab.js';
import { WebhooksTab } from '../notify/WebhooksTab.js';
import { UsersTab } from '../people/UsersTab.js';
import { WorkspacesTab } from '../people/WorkspacesTab.js';
import { AboutTab } from './AboutTab.js';
import { AccountTab } from './AccountTab.js';
import { AuditReport } from './AuditReport.js';
import { DisplayTab } from './DisplayTab.js';
import { KnowledgeTab } from './KnowledgeTab.js';
import { PluginsTab } from './PluginsTab.js';
import { PrivacyTab } from './PrivacyTab.js';
import { UpdatesTab } from './UpdatesTab.js';
import { ThemeTool } from './ThemeTool.js';
import { TerminalTool } from '../terminal/TerminalTool.js';

/**
 * Which section draws which destination.
 *
 * A map rather than a chain of `&&`, because a chain has to be edited in three places to
 * add one page — the branch, the negated list below it, and the import — and three
 * branches adding three pages conflict three times in the same file. Here a page is one
 * entry, and a destination with no entry is the placeholder by default rather than by an
 * `if` somebody has to remember to extend.
 */
const SECTIONS: Record<string, () => ReactElement> = {
  account: () => <AccountTab />,
  users: () => <UsersTab />,
  workspaces: () => <WorkspacesTab />,
  notifications: () => <NotificationsTab />,
  knowledge: () => <KnowledgeTab />,
  plugins: () => <PluginsTab />,
  updates: () => <UpdatesTab />,
  about: () => <AboutTab />,
  display: () => <DisplayTab />,
  theme: () => <ThemeTool />,
  webhooks: () => <WebhooksTab />,
  privacy: () => <PrivacyTab />,
  // The three reports the audit module answers; `skills` is still a 501 and stays a
  // placeholder, which is what the hub itself says about it.
  usage: () => <AuditReport kind="usage" />,
  logs: () => <AuditReport kind="logs" />,
  performance: () => <AuditReport kind="performance" />,
  // The owner's shell on the hub (DECISIONS §70); the emulator itself loads only here.
  terminal: () => <TerminalTool />,
};

export function SettingsScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const current = id === 'settings' ? 'account' : id;
  const destination = destinationsById.get(id);
  const title = t(termKey(id));
  const section = SECTIONS[current];

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      {destination?.global && <Notice className="mb-3">{t('settings.global_note')}</Notice>}
      <section aria-labelledby="settings-section">
        <h2 id="settings-section" className="mb-3 text-lg font-semibold">
          {t(termKey(current))}
        </h2>
        {section ? (
          section()
        ) : (
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
