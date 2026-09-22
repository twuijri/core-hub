// The decision the agent is blocked on: once / this session / always / deny for tool and
// write approvals (`always` only when the hub allows it), a free answer or a choice for
// questions. Every answer goes over HTTP (`sessions.respondApproval`).
//
// It is the one card in the transcript that is not a message, so it says so: an accent
// card with the agent named above the question, and the answer a real multi-line field —
// an agent that asks "what should I call it?" may be answered in a sentence.
import { HubApiError } from '@majlis/contracts';
import { useState, type KeyboardEvent } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Approval, ApprovalDecision } from '../types.js';
import { Badge, Button, Card, Label, Notice, Textarea } from '../ui/index.js';

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

  const sendAnswer = () => {
    const text = answer.trim();
    void respond(text ? { decision: null, answer: text } : { decision: 'deny', answer: null });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a new line — the same bargain the composer makes.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendAnswer();
    }
  };

  return (
    <Card
      as="section"
      tone="accent"
      className="approval-card"
      aria-live="polite"
      testId="approval-card"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">{t('approval.waiting')}</Badge>
        <span className="text-xs text-muted">
          {t('approval.from', { agent: approval.agent.name })}
        </span>
      </header>
      <h3 className="font-semibold" dir="auto">
        {approval.title}
      </h3>
      {approval.description && (
        <p className="text-sm text-muted" dir="auto">
          {approval.description}
        </p>
      )}
      {approval.command && (
        <pre className="approval-command" dir="ltr">
          {approval.command}
        </pre>
      )}
      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
      {isQuestion ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            sendAnswer();
          }}
        >
          {approval.choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {approval.choices.map((choice) => (
                <Button
                  key={choice.value}
                  disabled={busy}
                  onClick={() => void respond({ decision: null, answer: choice.value })}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
          )}
          {approval.answer_mode !== 'choice' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`approval-answer-${approval.id}`}>{t('approval.answer')}</Label>
              <Textarea
                id={`approval-answer-${approval.id}`}
                rows={2}
                dir="auto"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('approval.answer_hint')}
                data-testid="approval-answer"
              />
              <Button type="submit" variant="primary" className="self-start" loading={busy}>
                {t('approval.send')}
              </Button>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => void respond({ decision: 'deny', answer: null })}
          >
            {t('approval.skip')}
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {decisionsFor(approval).map((d) => (
            <Button
              key={d.id}
              variant={d.id === 'deny' ? 'danger' : d.id === 'once' ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => void respond({ decision: d.value, answer: null })}
              data-testid={`approve-${d.id}`}
            >
              {t(`approval.${d.id}`)}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}
