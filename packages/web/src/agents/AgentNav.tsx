/**
 * One agent, in the sidebar (NAVIGATION §4).
 *
 * The owner's decision (2026-09-24): an agent's pages are entered from the small buttons on
 * its card, «كاني دخلت بمسار سريع لاعدادات الايجنت», and inside them the sidebar becomes the
 * agent's own list — the pattern Settings set (`settings/SettingsNav.tsx`). A back row returns
 * to the Agents page; under it the agent's name and mark; then its pages in manifest order,
 * only those its adapter declares, the current one highlighted.
 *
 * The rows come from `agentSections`, the same answer the card's chips use, so the card and
 * the list can never offer different pages.
 */
import { Link, NavLink } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { agentRoute, navigation, routeOf, termKey } from '../navigation/manifest.js';
import { destinationIcons, IconArrowStart, IconRestart } from '../ui/icons.js';
import {
  Avatar,
  Button,
  agentMark,
  Notice,
  SidebarGroup,
  SidebarRow,
  useSidebarFolded,
  Skeleton,
  SkeletonGroup,
} from '../ui/index.js';
import { agentSections } from './sections.js';
import { canRestart, useRestartAgent } from './useRestartAgent.js';

/** «رجوع إلى الوكلاء»: where the rail was, the way Settings has «رجوع إلى المحادثات». */
export function AgentBackRow({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { t } = useI18n();
  return (
    <SidebarGroup testId="agent-back">
      <SidebarRow
        icon={<IconArrowStart size={18} />}
        label={t(`nav.${navigation.agentShell.back}`)}
        render={({ className, children }) => (
          <Link
            to={routeOf(navigation.agentShell.returnsTo)}
            onClick={onNavigate}
            className={className}
            data-testid="back-to-agents"
          >
            {children}
          </Link>
        )}
      />
    </SidebarGroup>
  );
}

export function AgentNav({
  agentId,
  current,
  onNavigate,
}: {
  agentId: string;
  /** The destination id of the page that is open (`agent_memory`, …). */
  current: string;
  onNavigate?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const agents = useAgents();
  const agent = agents.data?.find((entry) => entry.id === agentId);
  // Beside the name, for whoever may restart it (owner, 2026-09-25): «خل جنب كلمة هرمز
  // والايقونه زر ريستارت … اذا ضغطته يدور واذا اكتمل يوقف ويطلع تنبيه انه دن».
  const restarter = useRestartAgent(agent?.id);
  // In the folded rail the agent is its face alone; its name is the face's tooltip.
  const folded = useSidebarFolded();

  if (agents.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="2.25rem" radius="md" />
        <Skeleton height="1.75rem" radius="md" />
        <Skeleton height="1.75rem" radius="md" />
      </SkeletonGroup>
    );
  if (!agent)
    return (
      <div className="px-2" data-testid="agent-nav">
        <Notice tone={agents.isError ? 'danger' : 'warning'}>{t('agents.not_found')}</Notice>
      </div>
    );

  const sections = agentSections(agent, user?.role ?? 'member');
  return (
    <div data-testid="agent-nav" data-agent-slug={agent.slug}>
      <div
        className={`flex items-center gap-2 py-2 ${folded ? 'justify-center' : 'px-2'}`}
        data-testid="agent-nav-head"
      >
        <Avatar name={agent.name} size="sm" mark={agentMark(agent.slug, 14)} />
        {!folded && (
          <span className="min-w-0 truncate font-semibold" dir="auto">
            {agent.name}
          </span>
        )}
        {!folded && canRestart(agent, user?.role) && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="ms-auto"
            aria-label={t('agents.restart_named', { name: agent.name })}
            tooltip={t('agents.restart_named', { name: agent.name })}
            aria-busy={restarter.pending}
            disabled={restarter.pending}
            icon={
              <IconRestart
                size={16}
                className={restarter.pending ? 'animate-spin' : undefined}
                data-testid="agent-restart-icon"
              />
            }
            onClick={() => void restarter.restart()}
            data-testid="agent-restart"
          />
        )}
      </div>
      <SidebarGroup testId="agent-sections">
        <nav aria-label={t('agents.sections', { name: agent.name })}>
          {sections.map((d) => {
            const Icon = destinationIcons[d.id];
            return (
              <SidebarRow
                key={d.id}
                label={t(termKey(d.id))}
                {...(Icon ? { icon: <Icon size={16} /> } : {})}
                render={({ className, children }) => (
                  <NavLink
                    to={agentRoute(d.id, agent.id)}
                    onClick={onNavigate}
                    data-nav-id={d.id}
                    className={className}
                    aria-current={current === d.id ? 'page' : undefined}
                  >
                    {children}
                  </NavLink>
                )}
              />
            );
          })}
        </nav>
      </SidebarGroup>
    </div>
  );
}
