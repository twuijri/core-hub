// New chat: pick an agent from the server's registry (never a client-side list) and open a
// draft session — the server mints the id (contract: sessions.create).
import { Link, useNavigate } from 'react-router';
import { useAgents, useCreateSession } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { Notice, Spinner } from '../ui/Notice.js';

export function NewChatScreen() {
  const { t } = useI18n();
  const agents = useAgents();
  const create = useCreateSession();
  const navigate = useNavigate();
  const title = t(termKey('new_chat'));
  const selectable = (agents.data ?? []).filter((a) => a.enabled && a.status !== 'disabled');

  const start = async (agentId: string) => {
    const session = await create.mutateAsync({ agent_id: agentId });
    navigate(routeOf('chat').replace(':sessionId?', session.id));
  };

  return (
    <AppShell title={title}>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{t('new_chat.pick_agent')}</p>
      {agents.isPending && <Spinner label={t('common.loading')} />}
      {agents.isError && <Notice tone="danger">{describeError(agents.error, t)}</Notice>}
      {agents.data && selectable.length === 0 && (
        <Notice tone="warning">{t('new_chat.no_agents')}</Notice>
      )}
      {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
      {agents.data &&
        selectable.length > 0 &&
        selectable.every((agent) => agent.status === 'not_installed') && (
          // Every card disabled with no word why is a dead end; say what to do instead.
          <Notice tone="warning">
            {t('new_chat.none_ready')}{' '}
            <Link to={routeOf('agent_manager')}>{t('nav.agent_manager')}</Link>
          </Notice>
        )}
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {selectable.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              className="card flex w-full items-center gap-3 text-start hover:bg-surface-2 disabled:opacity-60"
              onClick={() => void start(agent.id)}
              disabled={create.isPending || agent.status === 'not_installed'}
              data-testid="pick-agent"
              data-agent-slug={agent.slug}
            >
              <span
                className="inline-grid size-9 place-items-center rounded-md bg-accent-soft text-accent-soft-text"
                aria-hidden
              >
                {agent.name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block font-medium" dir="auto">
                  {agent.name}
                </span>
                <span className="block text-xs text-muted">
                  {t(`agents.status.${agent.status}`)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
