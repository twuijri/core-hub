/**
 * A question the agent is waiting on, above the composer (owner decision, 2026-09-23).
 *
 * The shape the owner pointed at in Codex and Claude: the question, the agent's choices as
 * numbered rows — a tap answers — and always a line to write one's own answer, with Skip
 * and Send. Nothing is skipped for the person: the card stays until they answer or press
 * Skip themselves (the agent's own limit is Hermes's `agent.clarify_timeout`).
 *
 * The agent's suggested choice arrives marked "(Recommended)" (Hermes's `clarify` adds it
 * to the first choice). The mark becomes a badge here; the answer sent is the choice as
 * the agent wrote it, and the adapter drops the mark before Hermes reads it.
 */
import { HubApiError } from '@majlis/contracts';
import { useState, type KeyboardEvent } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Approval, ApprovalDecision } from '../types.js';
import { Badge, Button, Notice } from '../ui/index.js';
import { IconArrowEnd, IconClose, IconHelp } from '../ui/icons.js';

const RECOMMENDED = / \(Recommended\)$/i;

export function QuestionCard({ approval }: { approval: Approval }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [own, setOwn] = useState('');

  const respond = async (body: { decision: ApprovalDecision | null; answer: string | null }) => {
    setBusy(true);
    setError(null);
    try {
      await client.request('post', '/approvals/{approval_id}/respond', {
        params: { approval_id: approval.id },
        body,
      });
    } catch (err) {
      // Answered elsewhere, or the agent stopped waiting: the resolved event says which.
      if (!(err instanceof HubApiError && err.status === 409)) setError(err);
    } finally {
      setBusy(false);
    }
  };
  const skip = () => void respond({ decision: 'deny', answer: null });
  const send = () => {
    const text = own.trim();
    if (text) void respond({ decision: null, answer: text });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <section className="question-card" aria-live="polite" data-testid="question-card">
      <header className="question-head">
        <IconHelp size={14} />
        <span>{t('question.title')}</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="ms-auto"
          aria-label={t('question.skip')}
          tooltip={t('question.skip')}
          icon={<IconClose size={14} />}
          disabled={busy}
          onClick={skip}
          data-testid="question-close"
        />
      </header>
      <p className="question-text" dir="auto">
        {approval.title}
      </p>
      {approval.choices.length > 0 && (
        <ol className="question-choices">
          {approval.choices.map((choice, index) => {
            const recommended = RECOMMENDED.test(choice.label);
            return (
              <li key={choice.value}>
                <button
                  type="button"
                  className="question-choice"
                  disabled={busy}
                  onClick={() => void respond({ decision: null, answer: choice.value })}
                  data-testid="question-choice"
                >
                  <span className="question-number">{index + 1}</span>
                  <span className="question-label" dir="auto">
                    {choice.label.replace(RECOMMENDED, '')}
                  </span>
                  {recommended && <Badge tone="accent">{t('question.recommended')}</Badge>}
                  <IconArrowEnd size={14} className="question-go" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
      <div className="question-own">
        <input
          className="question-input"
          dir="auto"
          value={own}
          onChange={(event) => setOwn(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('question.own')}
          aria-label={t('question.own')}
          disabled={busy}
          data-testid="question-own"
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={skip}
          data-testid="question-skip"
        >
          {t('question.skip')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || own.trim() === ''}
          loading={busy}
          onClick={send}
          data-testid="question-send"
        >
          {t('question.send')}
        </Button>
      </div>
    </section>
  );
}
