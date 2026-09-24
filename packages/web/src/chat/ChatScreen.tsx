import { HubApiError } from '@majlis/contracts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAgents, useForkSession, usePatchSession, usePreferences } from '../hub/queries.js';
import { ProfileScope, useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { sessionTitle } from '../sessions/SessionList.js';
import type { ContentBlock, Message, ReasoningEffort } from '../types.js';
import { Button, buttonClass, EmptyState, Notice, SkeletonText } from '../ui/index.js';
import { IconClose, IconSpark } from '../ui/icons.js';
import { AgentChips } from './AgentChips.js';
import {
  ANCHOR_PARAM,
  QUERY_PARAM,
  chatHref,
  readAnchor,
  readProfileParam,
  type Anchor,
} from './anchor.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Composer } from './Composer.js';
import { starterSuggestions } from './starters.js';
import { takeFirstMessage } from './firstMessage.js';
import { ContextRing, contextUse } from './ContextRing.js';
import { MessageQueue } from './MessageQueue.js';
import { Transcript } from './MessageView.js';
import { holdsBack, queued, type QueuedMessage } from './outbox.js';
import { QuestionCard } from './QuestionCard.js';
import { RunStatus } from './RunStatus.js';
import { RunFailureNotice } from './RunFailureNotice.js';
import { SessionAgent } from './SessionAgent.js';
import { useCatalogue, useRuntimeReport } from '../models/queries.js';
import { activeRun, isBusy, textOf } from './transcript.js';
import { runProgress, turnsOf } from './turns.js';
import { useRecentModels } from '../models/useModelPicker.js';
import { useApprovalMode, useComposerModels } from './useComposerControls.js';
import { useFollowBottom } from './followBottom.js';
import { useSessionStream } from './useSessionStream.js';
import { WorkingDirPicker } from './WorkingDirPicker.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles, useProfileInLink } from '../shell/profileSelector.js';

export function ChatScreen() {
  const { t } = useI18n();
  const { sessionId } = useParams();
  const [params] = useSearchParams();
  const { homeProfile } = useAuth();
  const title = t(termKey('chat'));
  if (!sessionId) {
    return (
      <AppShell title={title} profiles="lists">
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
  // The conversation is opened in its own profile (ADR 0016): a list across profiles puts
  // it in the address, and everything inside — the transcript, the models, the agents —
  // asks that profile. The person's own profile and the top selector do not move.
  return (
    <ProfileScope profile={readProfileParam(params) ?? homeProfile}>
      <OpenSession sessionId={sessionId} />
    </ProfileScope>
  );
}

/**
 * Where an anchored open is (anchor.ts): waiting for the transcript, showing the message,
 * let go (the person sent or scrolled to the bottom), or the message is not there.
 */
type AnchorPhase = 'loading' | 'shown' | 'released' | 'missing';
type OpenAnchor = Anchor & { sessionId: string; phase: AnchorPhase };

function OpenSession({ sessionId }: { sessionId: string }) {
  const { t, language } = useI18n();
  const { client, profile } = useAuth();
  const manyProfiles = useManyProfiles();
  const inLink = useProfileInLink();
  const navigate = useNavigate();

  // A search result opens the chat at the message that matched (`?m=`, anchor.ts). The
  // anchor lives in state from here on: the address is cleaned once the jump is made.
  const [params, setParams] = useSearchParams();
  const fromUrl = readAnchor(params);
  const [anchorState, setAnchorState] = useState<OpenAnchor | null>(() =>
    fromUrl ? { ...fromUrl, sessionId, phase: 'loading' } : null,
  );
  if (
    fromUrl &&
    (anchorState?.sessionId !== sessionId ||
      anchorState.messageId !== fromUrl.messageId ||
      anchorState.query !== fromUrl.query)
  ) {
    setAnchorState({ ...fromUrl, sessionId, phase: 'loading' });
  }
  const anchor = anchorState?.sessionId === sessionId ? anchorState : null;
  const setPhase = useCallback(
    (from: readonly AnchorPhase[], phase: AnchorPhase) =>
      setAnchorState((current) =>
        current && from.includes(current.phase) ? { ...current, phase } : current,
      ),
    [],
  );
  const holding = anchor?.phase === 'loading' || anchor?.phase === 'shown';

  const stream = useSessionStream(sessionId, anchor?.messageId ?? null);
  const preferences = usePreferences();
  const patch = usePatchSession(sessionId);
  const transcript = useRef<HTMLDivElement>(null);
  const { state } = stream;
  const busy = isBusy(state);
  const messageCount = state.messages.length;
  // The transcript follows a growing reply while the person is at its bottom
  // (followBottom.ts); what the person just sent always brings them there. An anchored
  // open holds still until the person scrolls to the bottom themselves.
  const follow = useFollowBottom(transcript, {
    hold: holding,
    onBottom: () => setPhase(['shown'], 'released'),
  });
  const lastRole = state.messages.at(-1)?.role;
  useEffect(() => {
    if (lastRole === 'user' && !holding) follow();
  }, [messageCount, lastRole, follow, holding]);

  /**
   * The jump itself: once the transcript is on the page, the anchored message is scrolled
   * to the middle and flashed (`data-anchored`, styles/chat.css). Before paint, so the
   * person never sees the bottom first. A message that is no longer there says so, and
   * the chat opens at the bottom as usual.
   */
  const anchorPhase = anchor?.phase;
  const anchorId = anchor?.messageId;
  useLayoutEffect(() => {
    if (anchorPhase !== 'loading' || !anchorId || stream.status !== 'ready') return;
    const node = transcript.current?.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      setPhase(['loading'], 'shown');
    } else {
      setPhase(['loading'], 'missing');
      follow();
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(ANCHOR_PARAM);
        next.delete(QUERY_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [anchorPhase, anchorId, stream.status, follow, setPhase, setParams]);

  const agentId = state.session?.agent_id ?? null;
  const agents = useAgents();
  const catalogue = useCatalogue();
  const models = useComposerModels();
  const { recent, remember } = useRecentModels();
  const approval = useApprovalMode(agentId);

  // Who spoke, and where each turn begins (turns.ts). Recomputed only when the transcript
  // actually changes, because a streaming reply rewrites the last message every few ms.
  const turns = useMemo(() => turnsOf(state.messages), [state.messages]);
  const run = activeRun(state);
  const progress = runProgress(state, run);
  // The oldest question the agent is still waiting on; the next shows once it is answered.
  const question =
    Object.values(state.approvals).find((approval) => approval.kind === 'question') ?? null;

  /**
   * Replying to one message, and forking from one (owner, 2026-09-22). Both are the
   * contract's own gestures, not new ones: `RunCreate.reply_to_message_id` says which
   * message the next turn answers, and `sessions.fork` with `at_message_id` copies the
   * transcript up to that point and leaves the original alone.
   */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const fork = useForkSession(sessionId);
  const forkFrom = (message: Message) => {
    fork.mutate(
      { at_message_id: message.id },
      {
        onSuccess: (session) =>
          navigate(chatHref((session as { id: string }).id, null, undefined, inLink(profile))),
      },
    );
  };

  /**
   * The messages this tab is holding back while a turn is alive (`outbox.ts`). They are
   * not in the hub's queue: they were never sent, so each one can still be sent now,
   * used to steer the live turn, or dropped.
   */
  const [outbox, setOutbox] = useState<QueuedMessage[]>([]);
  const post = useCallback(
    async (blocks: ContentBlock[], when: 'queue' | 'next' | 'interrupt', replyId?: string) => {
      await client.request('post', '/sessions/{session_id}/runs', {
        params: { session_id: sessionId },
        body: {
          content: blocks,
          when,
          ...(replyId ? { reply_to_message_id: replyId } : {}),
        },
      });
    },
    [client, sessionId],
  );

  const send = useCallback(
    async (blocks: ContentBlock[]) => {
      // What one just said is where one wants to be, even after a search opened the chat.
      setPhase(['loading', 'shown'], 'released');
      const mode = preferences.data?.busy_input_mode;
      if (holdsBack(mode, busy)) {
        setOutbox((current) => [...current, queued(blocks)]);
        setReplyTo(null);
        return;
      }
      await post(
        blocks,
        (mode as 'queue' | 'next' | 'interrupt' | undefined) ?? 'queue',
        replyTo?.id,
      );
      setReplyTo(null);
    },
    [post, preferences.data?.busy_input_mode, busy, replyTo, setPhase],
  );

  const [queueError, setQueueError] = useState<unknown>(null);
  const release = useCallback(
    (item: QueuedMessage, when: 'queue' | 'next' | 'interrupt') => {
      setOutbox((current) => current.filter((q) => q.key !== item.key));
      post(item.blocks, when).catch(setQueueError);
    },
    [post],
  );

  /**
   * The queue drains itself: the moment nothing is running, the oldest waiting message
   * goes. One at a time, because the next one has to wait for the turn this one starts.
   */
  useEffect(() => {
    if (busy || outbox.length === 0) return;
    const [first] = outbox;
    if (first) release(first, 'queue');
  }, [busy, outbox, release]);

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

  /**
   * How full the window is: the catalogue's `context_window` for the session's model, and
   * the tokens the provider counted for the last finished turn. Either missing means no
   * ring, never an invented number.
   */
  const contextRing = contextUse(
    state.runs,
    (catalogue.data ?? []).find((model) => model.key === state.session?.model)?.context_window ??
      null,
  );

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
    // The whole width (owner decision, 2026-09-23): the agent's replies reach the left
    // edge and the person's the right, while the composer keeps its reading column.
    <AppShell title={title} profiles="lists">
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
          {/* Which profile this conversation is in, once there is more than one: its
              models and settings are that profile's (ADR 0016). */}
          {manyProfiles && <ProfileBadge profile={profile} testId="chat-profile" />}
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
        {anchor?.phase === 'missing' && (
          <Notice tone="info" className="mb-2">
            {t('chat.anchor_missing')}
          </Notice>
        )}
        {firstError !== null && <Notice tone="danger">{describeError(firstError, t)}</Notice>}
        {/* A held-back message that failed on its way out says so: it is no longer in the
            queue, so silence here would lose it without a word. */}
        {queueError !== null && <Notice tone="danger">{describeError(queueError, t)}</Notice>}
        <div className="chat-pad" aria-hidden />
        {/* An empty chat is an invitation, centred with the composer; the first message
            docks the composer and hands the column to the transcript. */}
        <div className="chat-lede">
          <h2 className="text-xl font-semibold">{t('chat.empty_title')}</h2>
          <p className="max-w-prose text-sm text-muted">{t('chat.empty')}</p>
        </div>
        <div className="chat-stream chat-turns" ref={transcript}>
          <Transcript
            turns={turns}
            showReasoning={showReasoning}
            showCost={preferences.data?.show_cost ?? false}
            runs={state.runs}
            slugOf={(id) => (agents.data ?? []).find((agent) => agent.id === id)?.slug}
            anchor={anchor && anchor.phase !== 'missing' ? anchor : null}
            onReply={setReplyTo}
            onFork={forkFrom}
          />
          {/* Questions wait above the composer (QuestionCard); decisions stay in the thread. */}
          {Object.values(state.approvals)
            .filter((approval) => approval.kind !== 'question')
            .map((approval) => (
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
        </div>
        <Composer
          busy={busy}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          onSend={send}
          onCancel={cancel}
          // While a run is alive the composer carries the live indicator: something moving,
          // the word, and the seconds counting up (owner decision, 2026-09-22).
          // Not while a question is open: the agent is not thinking, it is waiting on the
          // person, and the card above says so.
          {...(progress && !question ? { status: <RunStatus progress={progress} /> } : {})}
          {...(question
            ? { question: <QuestionCard key={question.id} approval={question} /> }
            : {})}
          {...(outbox.length > 0
            ? {
                queue: (
                  <MessageQueue
                    items={outbox}
                    onSendNow={(item) => release(item, 'next')}
                    onSteer={(item) => release(item, 'interrupt')}
                    onRemove={(item) =>
                      setOutbox((current) => current.filter((q) => q.key !== item.key))
                    }
                  />
                ),
              }
            : {})}
          {...(contextRing ? { context: <ContextRing use={contextRing} /> } : {})}
          {...(replyTo
            ? {
                reply: (
                  <div className="composer-reply" data-testid="composer-reply">
                    <span className="truncate" dir="auto">
                      {t('chat.replying_to', { text: previewOf(replyTo) })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={t('common.cancel')}
                      tooltip={t('common.cancel')}
                      icon={<IconClose size={14} />}
                      onClick={() => setReplyTo(null)}
                      data-testid="composer-reply-clear"
                    />
                  </div>
                ),
              }
            : {})}
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
          reasoningEffort={state.session?.reasoning_effort ?? null}
          onReasoningEffort={(value) =>
            patch.mutate({ reasoning_effort: value as ReasoningEffort | null })
          }
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

/** A few words of the message being answered — enough to recognise it, never the whole. */
function previewOf(message: Message): string {
  const text = textOf(message).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
