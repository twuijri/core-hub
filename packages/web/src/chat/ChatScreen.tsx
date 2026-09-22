import { HubApiError } from '@majlis/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { usePatchSession, usePreferences } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { sessionTitle } from '../sessions/SessionList.js';
import type { ContentBlock } from '../types.js';
import { buttonClass, EmptyState, Notice, SkeletonText } from '../ui/index.js';
import { IconSpark } from '../ui/icons.js';
import { AgentChips } from './AgentChips.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Composer } from './Composer.js';
import { starterSuggestions } from './starters.js';
import { takeFirstMessage } from './firstMessage.js';
import { Transcript } from './MessageView.js';
import { RunStatus } from './RunStatus.js';
import { RunFailureNotice } from './RunFailureNotice.js';
import { SessionAgent } from './SessionAgent.js';
import { useRuntimeReport } from '../models/queries.js';
import { activeRun, isBusy } from './transcript.js';
import { runProgress, turnsOf } from './turns.js';
import { useRecentModels } from '../models/useModelPicker.js';
import { useApprovalMode, useComposerModels } from './useComposerControls.js';
import { useSessionStream } from './useSessionStream.js';
import { WorkingDirPicker } from './WorkingDirPicker.js';

export function ChatScreen() {
  const { t } = useI18n();
  const { sessionId } = useParams();
  const title = t(termKey('chat'));
  if (!sessionId) {
    return (
      <AppShell title={title}>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<IconSpark size={20} />}
            title={t('chat.pick_one')}
            body={t('chat.pick_one_body')}
            action={
              <Link to={routeOf('new_chat')} className={buttonClass('primary', 'md')}>
                <span className="mj-btn-label">{t('nav.new_chat')}</span>
              </Link>
            }
            testId="chat-none"
          />
        </div>
      </AppShell>
    );
  }
  return <OpenSession sessionId={sessionId} />;
}

function OpenSession({ sessionId }: { sessionId: string }) {
  const { t, language } = useI18n();
  const { client } = useAuth();
  const navigate = useNavigate();
  const stream = useSessionStream(sessionId);
  const preferences = usePreferences();
  const patch = usePatchSession(sessionId);
  const bottom = useRef<HTMLDivElement>(null);
  const { state } = stream;
  const busy = isBusy(state);
  const messageCount = state.messages.length;
  const lastText = state.messages.at(-1)?.content.length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messageCount, lastText, Object.keys(state.approvals).length]);

  const agentId = state.session?.agent_id ?? null;
  const models = useComposerModels();
  const { recent, remember } = useRecentModels();
  const approval = useApprovalMode(agentId);

  // Who spoke, and where each turn begins (turns.ts). Recomputed only when the transcript
  // actually changes, because a streaming reply rewrites the last message every few ms.
  const turns = useMemo(() => turnsOf(state.messages), [state.messages]);
  const run = activeRun(state);
  const progress = runProgress(state, run);

  const send = useCallback(
    async (blocks: ContentBlock[]) => {
      await client.request('post', '/sessions/{session_id}/runs', {
        params: { session_id: sessionId },
        body: { content: blocks, when: preferences.data?.busy_input_mode ?? 'queue' },
      });
    },
    [client, sessionId, preferences.data?.busy_input_mode],
  );

  /**
   * The message typed on the new-chat screen (`firstMessage.ts`). It is sent once, and only
   * after the stream is ready: the run must not start before this screen is subscribed.
   */
  const [firstError, setFirstError] = useState<unknown>(null);
  const sentFirst = useRef(false);
  useEffect(() => {
    if (sentFirst.current || stream.status !== 'ready') return;
    const blocks = takeFirstMessage(sessionId);
    if (!blocks) return;
    sentFirst.current = true;
    send(blocks).catch(setFirstError);
  }, [sessionId, stream.status, send]);
  const cancel = async () => {
    if (!run) return;
    try {
      await client.request('post', '/sessions/{session_id}/runs/{run_id}/cancel', {
        params: { session_id: sessionId, run_id: run.id },
      });
    } catch (error) {
      // Already finished: the terminal event is on its way.
      if (!(error instanceof HubApiError && error.status === 409)) throw error;
    }
  };

  const title = state.session ? sessionTitle(state.session, t) : t(termKey('chat'));
  const showReasoning = preferences.data?.show_reasoning ?? true;
  const failedRun = Object.values(state.runs).find((r) => r.status === 'failed' && r.error);
  // Only asked for once a run has failed for want of a provider, and then asked fresh:
  // the notice says which step of propagation is missing right now.
  const runtime = useRuntimeReport({
    enabled: failedRun?.error?.code === 'provider_not_configured',
  });
  // The folder moves freely until the first run; after that the transcript would no longer
  // describe where the work happened, and the hub refuses (`409 state_invalid`).
  const hasRun = messageCount > 0 || Object.keys(state.runs).length > 0;
  const disabledReason =
    stream.status === 'loading'
      ? t('common.loading')
      : stream.status === 'error'
        ? describeError(stream.error, t)
        : state.deleted
          ? t('chat.session_deleted')
          : null;
  return (
    <AppShell title={title}>
      <div
        className="chat-flow"
        data-empty={messageCount === 0 ? 'true' : 'false'}
        data-testid="chat-screen"
        data-session-id={sessionId}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="chat-header">
          {/* Who this conversation is with, stated quietly now that the chip row is gone
              (owner decision, 2026-09-22). Changing it here forks the session. */}
          <SessionAgent sessionId={sessionId} agentId={agentId} />
          <WorkingDirPicker
            value={state.session?.working_dir ?? null}
            onChange={(next) => patch.mutate({ working_dir: next })}
            lockedReason={hasRun ? t('working_dir.locked') : null}
          />
          {patch.isError && (
            <span className="text-xs text-danger-soft-text">{describeError(patch.error, t)}</span>
          )}
        </div>
        {stream.status === 'loading' && (
          <div className="flex flex-col gap-6 py-4">
            <SkeletonText lines={2} label={t('common.loading')} />
            <SkeletonText lines={4} label={t('common.loading')} />
          </div>
        )}
        {stream.status === 'error' && (
          <Notice tone="danger">
            {describeError(stream.error, t)}{' '}
            <button type="button" className="link underline" onClick={stream.reload}>
              {t('common.retry')}
            </button>
          </Notice>
        )}
        {stream.lastResume && (
          <Notice
            tone={stream.lastResume.truncated ? 'warning' : 'info'}
            className="mb-2"
            role="status"
          >
            {stream.lastResume.truncated
              ? t('chat.resynced')
              : t('chat.resumed', { replayed: stream.lastResume.replayed })}
          </Notice>
        )}
        {state.deleted && <Notice tone="warning">{t('chat.session_deleted')}</Notice>}
        {firstError !== null && <Notice tone="danger">{describeError(firstError, t)}</Notice>}
        <div className="chat-pad" aria-hidden />
        {/* An empty chat is an invitation, centred with the composer; the first message
            docks the composer and hands the column to the transcript. */}
        <div className="chat-lede">
          <h2 className="text-xl font-semibold">{t('chat.empty_title')}</h2>
          <p className="max-w-prose text-sm text-muted">{t('chat.empty')}</p>
        </div>
        <div className="chat-stream chat-turns">
          <Transcript turns={turns} showReasoning={showReasoning} runs={state.runs} />
          {Object.values(state.approvals).map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
          {failedRun?.error &&
            // A failed run often leaves an empty assistant message; the badge alone would
            // hide the reason, so the notice is only suppressed when that message has text
            // — except for the one failure whose way out the hub knows, which is never
            // suppressed: the agent's own text does not say where to go.
            (failedRun.error.code === 'provider_not_configured' ||
              !state.messages.some(
                (m) =>
                  m.run_id === failedRun.id &&
                  m.status === 'failed' &&
                  m.content.some((part) => part.type === 'text' && part.text.trim() !== ''),
              )) && <RunFailureNotice failure={failedRun.error} runtime={runtime.data} />}
          <div ref={bottom} />
        </div>
        <Composer
          busy={busy}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          onSend={send}
          onCancel={cancel}
          // While a run is alive the composer carries the live indicator: something moving,
          // the word, and the seconds counting up (owner decision, 2026-09-22).
          {...(progress ? { status: <RunStatus progress={progress} /> } : {})}
          // The row belongs to an empty chat only (owner decision, 2026-09-22): once the
          // conversation has turns, its agent is in the header and changing it is a fork.
          {...(messageCount === 0
            ? {
                chips: (
                  <AgentChips
                    selectedId={agentId}
                    mode="current"
                    // Before the first message nothing has been said yet, so another agent
                    // simply means another (still empty) chat.
                    onSelect={(agent) => {
                      if (agent.id !== agentId)
                        navigate(`${routeOf('new_chat')}?agent=${agent.id}`);
                    }}
                  />
                ),
              }
            : {})}
          model={state.session?.model ?? null}
          models={models}
          recentModels={recent}
          onModel={(value) => {
            remember(value);
            patch.mutate({ model: value });
          }}
          approvalMode={approval.mode}
          approvalOptions={approval.options}
          onApprovalMode={approval.set}
          approvalDisabledReason={approval.disabledReason}
          starters={messageCount === 0 ? starterSuggestions(language) : []}
        />
        <div className="chat-pad" aria-hidden />
      </div>
    </AppShell>
  );
}
