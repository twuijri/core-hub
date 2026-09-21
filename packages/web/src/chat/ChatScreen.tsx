import { HubApiError } from '@majlis/contracts';
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { usePreferences } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { sessionTitle } from '../sessions/SessionList.js';
import type { ContentBlock } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Composer } from './Composer.js';
import { MessageView } from './MessageView.js';
import { activeRun, isBusy } from './transcript.js';
import { useSessionStream } from './useSessionStream.js';

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
  const { t } = useI18n();
  const { client } = useAuth();
  const stream = useSessionStream(sessionId);
  const preferences = usePreferences();
  const bottom = useRef<HTMLDivElement>(null);
  const { state } = stream;
  const busy = isBusy(state);
  const messageCount = state.messages.length;
  const lastText = state.messages.at(-1)?.content.length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messageCount, lastText, Object.keys(state.approvals).length]);

  const send = async (blocks: ContentBlock[]) => {
    await client.request('post', '/sessions/{session_id}/runs', {
      params: { session_id: sessionId },
      body: { content: blocks, when: preferences.data?.busy_input_mode ?? 'queue' },
    });
  };
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
  return (
    <AppShell title={title}>
      <div className="flex flex-1 flex-col" data-testid="chat-screen" data-session-id={sessionId}>
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
        {stream.status === 'ready' && state.messages.length === 0 && (
          <Notice>{t('chat.empty')}</Notice>
        )}
        <div className="flex-1">
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
          disabled={stream.status !== 'ready' || state.deleted}
          onSend={send}
          onCancel={cancel}
        />
      </div>
    </AppShell>
  );
}
