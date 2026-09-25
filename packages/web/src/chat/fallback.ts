/**
 * Which model answered a turn, and what it took over from (contract decision §49), in the
 * words the chat and the trajectory show. Pure, so the wording rules are tested on their own.
 */
import type { Run, RunFallback } from '../types.js';

/** One chain member as a person reads it: `provider/model`, or the model alone. */
export function modelName(attempt: { model: string; provider: string | null }): string {
  return attempt.provider ? `${attempt.provider}/${attempt.model}` : attempt.model;
}

/** The models that failed, joined with the list separator of the language. */
export function failedNames(fallback: RunFallback, language: string): string {
  const names = fallback.failed.map(modelName);
  return names.join(language === 'ar' ? '، ' : ', ');
}

/** The reasons the models gave, without repeats; `null` when none said why. */
export function failureReasons(fallback: RunFallback): string | null {
  const reasons = [
    ...new Set(fallback.failed.map((attempt) => attempt.error?.trim() ?? '').filter(Boolean)),
  ];
  return reasons.length > 0 ? reasons.join(' · ') : null;
}

/** The note a finished turn carries, or `null` when the chosen model answered. */
export function fallbackOf(
  run: Run | undefined,
): { answered: string; fallback: RunFallback } | null {
  if (!run?.fallback || run.fallback.failed.length === 0) return null;
  return { answered: run.model ?? '', fallback: run.fallback };
}
