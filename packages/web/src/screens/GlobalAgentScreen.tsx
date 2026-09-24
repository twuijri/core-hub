/**
 * The global agent (NAVIGATION §4, contract decision §46): the person's one standing
 * conversation in a profile, outside the chats list. No menu leads here; search results
 * and the pending-actions bar do. The page asks the hub for it (`sessions.openGlobalAgent`,
 * which makes it the first time, with the first agent the person would start a chat with)
 * and then is that conversation, under the page's own name.
 */
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ProfileScope, useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { installedAgents } from '../chat/AgentChips.js';
import { arrangeAgents, readAgentOrder } from '../chat/agentOrder.js';
import { readProfileParam } from '../chat/anchor.js';
import { OpenSession } from '../chat/ChatScreen.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { pendingKeys } from '../pending/queries.js';
import { AppShell } from '../shell/AppShell.js';
import type { Session } from '../types.js';
import { EmptyState, Notice, SkeletonText } from '../ui/index.js';
import { IconSpark } from '../ui/icons.js';

export function GlobalAgentScreen() {
  const [params] = useSearchParams();
  const { homeProfile } = useAuth();
  // A search hit from another profile opens that profile's global agent (ADR 0016).
  return (
    <ProfileScope profile={readProfileParam(params) ?? homeProfile}>
      <GlobalAgent />
    </ProfileScope>
  );
}

function GlobalAgent() {
  const { t } = useI18n();
  const { client, profile, session } = useAuth();
  const title = t(termKey('global_agent'));
  const agents = useAgents();
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  // Only used the first time: an existing global agent keeps the agent it was made with.
  const agentId =
    arrangeAgents(installedAgents(agents.data ?? []), readAgentOrder(storage, profile))[0]?.id ??
    null;

  const opened = useQuery({
    queryKey: pendingKeys.globalAgent(profile),
    queryFn: async () =>
      (
        await client.request('post', '/sessions/global-agent', {
          body: { agent_id: agentId ?? '' },
        })
      ).data as Session,
    enabled: !!session && !!agentId,
    // The same conversation every time (it is made once); the transcript is kept live by
    // the conversation itself, not by asking again.
    staleTime: Infinity,
    retry: false,
  });

  if (opened.data) {
    return <OpenSession sessionId={opened.data.id} title={title} intro={t('global_agent.intro')} />;
  }
  const noAgent = agents.isSuccess && !agentId;
  return (
    <AppShell title={title}>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3" data-testid="global-agent">
        {noAgent ? (
          <EmptyState
            icon={<IconSpark size={20} />}
            title={title}
            body={t('global_agent.no_agent')}
            testId="global-agent-no-agent"
          />
        ) : opened.isError || agents.isError ? (
          <Notice tone="danger">{describeError(opened.error ?? agents.error, t)}</Notice>
        ) : (
          <SkeletonText lines={3} label={t('global_agent.opening')} />
        )}
      </div>
    </AppShell>
  );
}
