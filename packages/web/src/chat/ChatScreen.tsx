import { HubApiError } from '@majlis/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { usePatchSession, usePreferences } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { sessionTitle } from '../sessions/SessionList.js';
import type { ContentBlock } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { AgentChips } from './AgentChips.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Composer } from './Composer.js';
import { starterSuggestions } from './starters.js';
import { takeFirstMessage } from './firstMessage.js';
import { MessageView } from './MessageView.js';
import { activeRun, isBusy } from './transcript.js';
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
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-lg font-medium">{t('chat.pick_one')}</p>
          <Link to={routeOf('new_chat')} className="btn btn-primary">
            {t('nav.new_chat')}
          </Link>
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
    const run = activeRun(state);
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
          <WorkingDirPicker
            value={state.session?.working_dir ?? null}
            onChange={(next) => patch.mutate({ working_dir: next })}
            lockedReason={hasRun ? t('working_dir.locked') : null}
          />
          {patch.isError && (
            <span className="text-xs text-danger-soft-text">{describeError(patch.error, t)}</span>
          )}
        </div>
        {stream.status === 'loading' && <Spinner label={t('common.loading')} />}
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
        <div className="chat-stream">
          {state.messages.map((message) => (
            <MessageView key={message.id} message={message} showReasoning={showReasoning} />
          ))}
          {Object.values(state.approvals).map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
          {failedRun?.error &&
            // A failed run often leaves an empty assistant message; the badge alone would
            // hide the reason, so the notice is only suppressed when that message has text.
            !state.messages.some(
              (m) =>
                m.run_id === failedRun.id &&
                m.status === 'failed' &&
                m.content.some((part) => part.type === 'text' && part.text.trim() !== ''),
            ) && (
              <Notice tone="danger">
                {t('chat.run_failed', { error: failedRun.error.error, code: failedRun.error.code })}
              </Notice>
            )}
          <div ref={bottom} />
        </div>
        <Composer
          busy={busy}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          onSend={send}
          onCancel={cancel}
          chips={
            <AgentChips
              selectedId={agentId}
              mode="current"
              // The chips decide the agent of a *new* chat; the open one keeps its own.
              onSelect={(agent) => {
                if (agent.id !== agentId) navigate(`${routeOf('new_chat')}?agent=${agent.id}`);
              }}
            />
          }
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
