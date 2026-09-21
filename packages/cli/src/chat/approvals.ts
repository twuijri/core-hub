// How a person's reply to an approval or a question becomes the contract's
// `ApprovalResponse` (`sessions.respondApproval`). Pure, so the mapping is unit-tested.
import type { ApprovalDecision } from '../types.js';

export const DECISIONS = ['once', 'session', 'always', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_OF: Record<Decision, ApprovalDecision> = {
  once: 'approve_once',
  session: 'approve_session',
  always: 'approve_always',
  deny: 'deny',
};

const BY_NUMBER: Readonly<Record<string, Decision>> = {
  '1': 'once',
  '2': 'session',
  '3': 'always',
  '4': 'deny',
};

/** `1`–`4` or the word itself; `always` only when the hub allows it; `undefined` = ask again. */
export function parseDecision(reply: string, allowAlways: boolean): Decision | undefined {
  const text = reply.trim().toLowerCase();
  const picked =
    BY_NUMBER[text] ??
    ((DECISIONS as readonly string[]).includes(text) ? (text as Decision) : undefined);
  if (picked === 'always' && !allowAlways) return undefined;
  return picked;
}

/** A choice number resolves to that choice's value; otherwise the trimmed text; empty is `null`. */
export function parseAnswer(
  reply: string,
  choices: ReadonlyArray<{ value: string }>,
): string | null {
  const text = reply.trim();
  if (text === '') return null;
  const index = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  const choice = Number.isInteger(index) ? choices[index - 1] : undefined;
  return choice ? choice.value : text;
}
