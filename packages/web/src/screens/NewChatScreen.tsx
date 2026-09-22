/**
 * A new chat is a chat, not a form (ADOPTION-BACKLOG 2.5, 2.10): the agent chips sit above
 * the composer, the folder this chat will work in sits in the header, and three starters
 * sit underneath. The session is minted by the hub on the first message — before that there
 * is nothing to keep, so nothing is created.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { AgentChips, enabledAgents, installedAgents } from '../chat/AgentChips.js';
import { Composer } from '../chat/Composer.js';
import { putFirstMessage } from '../chat/firstMessage.js';
import { starterSuggestions } from '../chat/starters.js';
import { useApprovalMode, useComposerModels } from '../chat/useComposerControls.js';
import { useRecentModels } from '../models/useModelPicker.js';
import { WorkingDirPicker } from '../chat/WorkingDirPicker.js';
import { useAgents, useCreateSession } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import type { ContentBlock } from '../types.js';
import { Notice } from '../ui/Notice.js';

export function NewChatScreen() {
  const { t, language } = useI18n();
  const agents = useAgents();
  const create = useCreateSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const title = t(termKey('new_chat'));

  // Only installed agents can start a chat (owner decision, 2026-09-22); the rest are an
  // errand for the Agent Manager, and the notice below is that errand, not a chip.
  const ready = installedAgents(agents.data ?? []);
  const enabled = enabledAgents(agents.data ?? []);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const models = useComposerModels();
  const { recent, remember } = useRecentModels();
  const approval = useApprovalMode(agentId);

  // The first agent is chosen for the person, so a fresh hub with Hermes alone never asks
  // a question with one answer. `?agent=` comes from a chip in an open session.
  useEffect(() => {
    if (agentId && ready.some((a) => a.id === agentId)) return;
    const asked = params.get('agent');
    const wanted = ready.find((a) => a.id === asked) ?? ready[0];
    setAgentId(wanted?.id ?? null);
  }, [ready, agentId, params]);

  // The registry has agents but none of them is on this host: the way out is the Agent
  // Manager, and saying so is the whole of this screen's job until one is installed.
  const noneInstalled = ready.length === 0 && enabled.length > 0;
  const disabledReason = agents.isPending
    ? t('common.loading')
    : noneInstalled
      ? t('new_chat.none_installed')
      : enabled.length === 0
        ? t('new_chat.no_agents')
        : !agentId
          ? t('new_chat.pick_agent')
          : null;

  /**
   * The first message mints the session and then hands the blocks to the chat screen, which
   * sends them once it is subscribed. Posting the run here instead would start the stream
   * before anyone is listening, and the first deltas would only be seen on a replay.
   */
  const send = async (blocks: ContentBlock[]) => {
    if (!agentId) return;
    setError(null);
    const session = await create.mutateAsync({
      agent_id: agentId,
      model,
      working_dir: workingDir,
    });
    putFirstMessage(session.id, blocks);
    navigate(routeOf('chat').replace(':sessionId?', session.id));
  };

  return (
    <AppShell title={title}>
      {/* The same column an empty chat uses (`.chat-flow`), so nothing shifts when the
          first message turns this draft into a session. */}
      <div className="chat-flow" data-empty="true" data-testid="new-chat">
        <div className="chat-pad" aria-hidden />
        <div className="chat-lede">
          <h1 className="text-xl font-semibold">{t('new_chat.greeting')}</h1>
          <p className="max-w-prose text-sm text-muted">{t('new_chat.lede')}</p>
          <WorkingDirPicker value={workingDir} onChange={setWorkingDir} />
          {noneInstalled && (
            <Notice tone="warning">
              {t('new_chat.none_installed')}{' '}
              <Link to={routeOf('agent_manager')} className="link underline">
                {t('nav.agent_manager')}
              </Link>
            </Notice>
          )}
          {(error || create.isError) && (
            <Notice tone="danger">{describeError(error ?? create.error, t)}</Notice>
          )}
        </div>
        <Composer
          busy={false}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          onSend={send}
          onCancel={async () => {}}
          chips={
            <AgentChips
              selectedId={agentId}
              onSelect={(agent) => setAgentId(agent.id)}
              mode="select"
            />
          }
          model={model}
          models={models}
          recentModels={recent}
          onModel={(value) => {
            remember(value);
            setModel(value);
          }}
          approvalMode={approval.mode}
          approvalOptions={approval.options}
          onApprovalMode={approval.set}
          approvalDisabledReason={approval.disabledReason}
          starters={starterSuggestions(language)}
        />
        <div className="chat-pad" aria-hidden />
      </div>
    </AppShell>
  );
}
