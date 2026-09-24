/**
 * Who this conversation is with, in the chat header — and how to change it.
 *
 * The chip row above the composer belongs to an *empty* chat (owner decision,
 * 2026-09-22). Once there are messages the question has been answered, so the answer is
 * stated here quietly instead: the agent's mark and its name, with the whole control
 * being a menu.
 *
 * The menu offers one thing, "continue with another agent", and it is deliberately not
 * the same gesture as changing the model:
 *
 * - the **model** is a setting of the running conversation (the composer's selector,
 *   `sessions.update`) — same agent, same transcript;
 * - the **agent** is who the conversation is with, so choosing one forks the session
 *   (`sessions.fork` with `agent_id`, contract decision §26): the transcript travels, the
 *   fork opens, and the original stays where it was.
 *
 * One line in the menu says that difference in the person's own language, because a
 * gesture that silently duplicates a conversation is a gesture nobody would risk twice.
 */
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useAgents, useForkSession } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import type { Agent } from '../types.js';
import { agentMark } from '../ui/brand/marks.js';
import { IconAgents, IconChevron } from '../ui/icons.js';
import { Button, Menu, MenuItem, MenuNote, MenuSeparator } from '../ui/index.js';
import { installedAgents } from './AgentChips.js';
import { chatHref } from './anchor.js';
import { useProfileInLink } from '../shell/profiles.js';

export function SessionAgent({
  sessionId,
  agentId,
}: {
  sessionId: string;
  /** `null` only while the session document is still loading. */
  agentId: string | null;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const inLink = useProfileInLink();
  const agents = useAgents();
  const fork = useForkSession(sessionId);

  const all = agents.data ?? [];
  const current: Agent | undefined = all.find((agent) => agent.id === agentId);
  // Only installed agents can continue a conversation, for the same reason only installed
  // agents get a chip: the rest are an errand, not a choice.
  const others = installedAgents(all).filter((agent) => agent.id !== agentId);

  const continueWith = (agent: Agent) => {
    fork.mutate(
      { agent_id: agent.id },
      {
        // The fork is the conversation now; the original is one click back in the list.
        // A fork is made in the conversation's own profile, and opens there.
        onSuccess: (session) =>
          navigate(chatHref((session as { id: string }).id, null, undefined, inLink(profile))),
      },
    );
  };

  // The header must not invent a name for an agent the registry has not answered for yet.
  if (!current) return null;

  return (
    <>
      <Menu
        align="start"
        testId="session-agent-menu"
        tooltip={t('chat.agent_menu', { name: current.name })}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            loading={fork.isPending}
            aria-label={t('chat.agent_menu', { name: current.name })}
            data-testid="session-agent"
            data-agent-id={current.id}
            icon={agentMark(current.slug, 14) ?? <IconAgents size={14} />}
          >
            <span dir="auto">{current.name}</span>
            <IconChevron size={12} />
          </Button>
        }
      >
        <MenuNote>{t('chat.agent_of_session')}</MenuNote>
        <MenuSeparator />
        <MenuNote>{t('chat.fork_explains')}</MenuNote>
        {others.length === 0 ? (
          <MenuNote>{t('chat.no_other_agent')}</MenuNote>
        ) : (
          others.map((agent) => (
            <MenuItem
              key={agent.id}
              icon={agentMark(agent.slug, 14) ?? <IconAgents size={14} />}
              onSelect={() => continueWith(agent)}
            >
              <span dir="auto" data-testid="continue-with" data-agent-id={agent.id}>
                {t('chat.continue_with', { name: agent.name })}
              </span>
            </MenuItem>
          ))
        )}
      </Menu>
      {fork.isError && (
        <span className="text-xs text-danger-soft-text" data-testid="fork-error">
          {describeError(fork.error, t)}
        </span>
      )}
    </>
  );
}
