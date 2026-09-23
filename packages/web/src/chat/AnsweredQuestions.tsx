/**
 * What the agent asked, and what the person answered, kept in the conversation.
 *
 * Owner, 2026-09-23: «اذا اخترت خيار ما يعلمني اي خيار اخترت في الشات». The question card
 * leaves once it is answered, so the answer is read back from where it is kept for good:
 * Hermes's `clarify` tool call, whose result is `{question, choices_offered, user_response}`
 * (or, for several questions at once, `{responses: [{question, user_response}], timed_out}`).
 * An empty answer is a skip; a result that says `timed_out` is a question nobody answered.
 */
import { useI18n } from '../i18n/context.js';
import type { ToolCall } from '../types.js';
import { IconHelp } from '../ui/icons.js';

export interface AnsweredQuestion {
  id: string;
  question: string;
  /** `''` when skipped. */
  answer: string;
  timedOut: boolean;
}

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.filter((item) => typeof item === 'string').join('، ')
      : '';

/** The questions a turn's `clarify` calls asked and got an answer to; never throws. */
export function answeredQuestions(calls: readonly ToolCall[]): AnsweredQuestion[] {
  const out: AnsweredQuestion[] = [];
  for (const call of calls) {
    if (call.name !== 'clarify' || !call.output) continue;
    let result: unknown;
    try {
      result = JSON.parse(call.output);
    } catch {
      continue;
    }
    if (!result || typeof result !== 'object') continue;
    const record = result as Record<string, unknown>;
    const timedOut = record.timed_out === true;
    const asked = text(call.arguments?.question);
    if (Array.isArray(record.responses)) {
      record.responses.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const one = entry as Record<string, unknown>;
        const question = text(one.question);
        if (!question) return;
        out.push({
          id: `${call.id}:${index}`,
          question,
          answer: text(one.user_response),
          timedOut,
        });
      });
      continue;
    }
    const question = text(record.question) || asked;
    if (!question || !('user_response' in record)) continue;
    out.push({ id: call.id, question, answer: text(record.user_response), timedOut });
  }
  return out;
}

export function AnsweredQuestions({ calls }: { calls: readonly ToolCall[] }) {
  const { t } = useI18n();
  const answered = answeredQuestions(calls);
  if (answered.length === 0) return null;
  return (
    <ul className="answered-list">
      {answered.map((item) => (
        <li key={item.id} className="answered" data-testid="answered-question">
          <IconHelp size={14} className="answered-icon" />
          <div className="answered-body">
            <p className="answered-question" dir="auto">
              {item.question}
            </p>
            {item.answer ? (
              <p className="answered-answer">
                <span className="text-muted">{t('question.answered')}</span>{' '}
                <span dir="auto">{item.answer}</span>
              </p>
            ) : (
              <p className="answered-answer text-muted">
                {item.timedOut ? t('question.expired') : t('question.skipped')}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
