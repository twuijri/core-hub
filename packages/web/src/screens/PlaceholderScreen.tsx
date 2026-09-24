// A destination whose module has not landed yet still has a screen (parity rule 1) that says
// so explicitly — never a silent empty page (TEAM-RULES §4). The kit's `EmptyState` is the
// shape of "nothing here yet", and the breadcrumb says where "here" is.
import { Link, useParams } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { destinationsById, navigation, routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { Badge, Breadcrumb, EmptyState, type Crumb } from '../ui/index.js';
import { IconSpark } from '../ui/icons.js';

const PHASES: Record<string, number> = {
  rooms: 1,
  tasks: 1,
  schedules: 1,
  notify: 1,
  knowledge: 4,
  plugins: 4,
  updates: 4,
  audit: 4,
  models: 2,
  devices: 3,
  agents: 2,
  auth: 2,
  sessions: 2,
};

export function phaseOf(module: string | undefined): number {
  return module ? (PHASES[module] ?? 2) : 2;
}

export function PlaceholderScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const { agentId } = useParams();
  const destination = destinationsById.get(id);
  const title = t(termKey(id));
  const underSettings = navigation.settingsManagement.includes(id);
  // An agent's page has its side list too: the agent's own (`agents/AgentNav.tsx`).
  const hasSideList = underSettings || destination?.level === 'agent';
  const trail: Crumb[] = [
    ...(underSettings
      ? [
          {
            label: t('nav.settings'),
            href: routeOf('settings'),
            render: ({ href, children, className }) => (
              <Link to={href} className={className}>
                {children}
              </Link>
            ),
          } satisfies Crumb,
        ]
      : []),
    { label: title },
  ];
  const body = (
    <>
      {/* Under Settings and under an agent the side list already says where this page
          sits; a crumb would say it twice. Elsewhere the crumb is the only trail. */}
      {!hasSideList && <Breadcrumb label={t('ui.breadcrumb')} items={trail} />}
      <h1 className="mt-2 text-xl font-semibold">{title}</h1>
      {agentId && (
        <p className="mt-1 text-xs text-muted">{t('placeholder.agent', { id: agentId })}</p>
      )}
      <div className="mt-4">
        <EmptyState
          icon={<IconSpark size={20} />}
          title={title}
          body={t('placeholder.later', { name: title, phase: phaseOf(destination?.module) })}
          {...(destination?.note ? { action: <Badge tone="info">{destination.note}</Badge> } : {})}
        />
      </div>
    </>
  );
  return <AppShell title={title}>{body}</AppShell>;
}
