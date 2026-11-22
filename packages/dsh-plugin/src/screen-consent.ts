/**
 * The consent answerer of the screen profile (ADR 0033 §5), loaded only in the headless session
 * a screen task runs in. Computer Use asks before it touches an application (a `user-questions`
 * approval); in a one-shot run no one could answer, and the person already allowed this task
 * on the computer. So: an approval for the requested app (or any app when the task named none)
 * is granted for this session only — never "always" — and any other app is refused. A plain
 * question from the model is answered "decide yourself": no one is watching.
 *
 * Registered on the documented `user-questions/request` waterfall (dsh-user-questions).
 */
import Schema from '@deepseek-ai/schemastery';

export const name = 'corehub-screen-consent';

export interface Config {
  app: string | null;
}

export const Config = Schema.object({
  app: Schema.union([Schema.string(), Schema.const(null)]).default(null),
});

interface Question {
  id: string;
  options?: Array<{ label: string }>;
  intent?: {
    kind: string;
    approve?: string;
    reject?: string;
    subject?: { name?: string };
  };
}

export interface Answer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

/** Whether `subject` (the app Computer Use asks about) is the app the task named. */
export function sameApp(wanted: string, subject: string | undefined): boolean {
  if (!subject) return false;
  const a = wanted.trim().toLowerCase();
  const b = subject.trim().toLowerCase();
  return a === b || b.includes(a) || a.includes(b);
}

/** The answer for one request, or null to let another answerer take it. */
export function answerFor(questions: readonly Question[], app: string | null): Answer | null {
  if (questions.length === 0) return null;
  return {
    answers: questions.map((q) => {
      if (q.intent?.kind === 'approval' && q.intent.approve && q.intent.reject) {
        const ok = app === null || sameApp(app, q.intent.subject?.name);
        return { id: q.id, selected: [ok ? q.intent.approve : q.intent.reject] };
      }
      if (q.intent?.kind === 'plan-review' && q.intent.approve)
        return { id: q.id, selected: [q.intent.approve] };
      return {
        id: q.id,
        selected: [],
        custom: 'No one is at the computer to answer. Decide yourself, within the task.',
      };
    }),
  };
}

interface Ctx {
  on(
    event: 'user-questions/request',
    listener: (request: { questions: Question[] }, next: () => Promise<Answer>) => Promise<Answer>,
  ): () => boolean;
}

export function apply(ctx: Ctx, config: Config): void {
  ctx.on('user-questions/request', async (request, next) => {
    const answer = answerFor(request.questions ?? [], config.app ?? null);
    return answer ?? next();
  });
}
