// The decision the agent is blocked on: once / this session / always / deny for tool and
// write approvals (`always` only when the hub allows it), a free answer or a choice for
// questions. Every answer goes over HTTP (`sessions.respondApproval`).
import { HubApiError } from '@majlis/contracts';
import { useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Approval, ApprovalDecision } from '../types.js';
import { Notice } from '../ui/Notice.js';

export const DECISIONS: ReadonlyArray<{
  id: 'once' | 'session' | 'always' | 'deny';
  value: ApprovalDecision;
}> = [
  { id: 'once', value: 'approve_once' },
  { id: 'session', value: 'approve_session' },
  { id: 'always', value: 'approve_always' },
  { id: 'deny', value: 'deny' },
];

export function decisionsFor(approval: Pick<Approval, 'allow_always'>) {
  return DECISIONS.filter((d) => d.id !== 'always' || approval.allow_always);
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [answer, setAnswer] = useState('');
  const isQuestion = approval.kind === 'question' || approval.answer_mode !== 'choice';

  const respond = async (body: { decision: ApprovalDecision | null; answer: string | null }) => {
    setBusy(true);
    setError(null);
    try {
      await client.request('post', '/approvals/{approval_id}/respond', {
        params: { approval_id: approval.id },
        body,
      });
    } catch (err) {
      // Someone else answered first, or it expired: the resolved event tells the story.
      if (!(err instanceof HubApiError && err.status === 409)) setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="card my-3 border-warning-soft-text/40 bg-warning-soft/40"
      aria-live="polite"
      data-testid="approval-card"
    >
      <p className="text-xs text-muted">{t('approval.from', { agent: approval.agent.name })}</p>
      <h3 className="mt-1 font-semibold" dir="auto">
        {approval.title}
      </h3>
      {approval.description && (
        <p className="mt-1 text-sm" dir="auto">
          {approval.description}
        </p>
      )}
      {approval.command && (
        <pre
          className="mt-2 overflow-x-auto rounded-md bg-code-bg p-2 font-mono text-xs text-code-text"
          dir="ltr"
        >
          {approval.command}
        </pre>
      )}
      {error !== null && (
        <Notice tone="danger" className="mt-2">
          {describeError(error, t)}
        </Notice>
      )}
      {isQuestion ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = answer.trim();
            void respond(
              text ? { decision: null, answer: text } : { decision: 'deny', answer: null },
            );
          }}
        >
          {approval.choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {approval.choices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void respond({ decision: null, answer: choice.value })}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {approval.answer_mode !== 'choice' && (
            <div className="flex gap-2">
              <input
                className="field"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={t('approval.answer')}
                aria-label={t('approval.answer')}
              />
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {t('approval.send')}
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn btn-ghost self-start text-xs"
            disabled={busy}
            onClick={() => void respond({ decision: 'deny', answer: null })}
          >
            {t('approval.skip')}
          </button>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {decisionsFor(approval).map((d) => (
            <button
              key={d.id}
              type="button"
              className={`btn ${d.id === 'deny' ? 'btn-danger' : d.id === 'once' ? 'btn-primary' : ''}`}
              disabled={busy}
              onClick={() => void respond({ decision: d.value, answer: null })}
              data-testid={`approve-${d.id}`}
            >
              {t(`approval.${d.id}`)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
