/**
 * Which model answered a turn, and what it took over from (contract decision §54), in the
 * words the chat and the trajectory show. Pure, so the wording rules are tested on their own.
 */
import { createContext } from 'react';
import type { Model, Run, RunFallback } from '../types.js';

/**
 * A catalogue key (`<provider slug>/<model>`) as people know it — the provider's name and the
 * model's (owner, 2026-09-30: "custom-cli-proxy-api/gemini-3-flash answered" said the slug) — or
 * `null` when the catalogue does not have it. Provided by the chat screen; absent, the key.
 */
export type ModelNames = (key: string) => string | null;
export const ModelNamesContext = createContext<ModelNames | null>(null);

/** A `ModelNames` over the profile's catalogue: «<provider> · <model>». */
export function catalogueNames(catalogue: readonly Model[]): ModelNames {
  const byKey = new Map(catalogue.map((model) => [model.key, model]));
  return (key) => {
    const model = byKey.get(key);
    return model ? `${model.provider} · ${model.alias ?? model.model}` : null;
  };
}

/** One chain member as a person reads it: its names, else `provider/model`, or the model alone. */
export function modelName(
  attempt: { model: string; provider: string | null },
  names?: ModelNames | null,
): string {
  const key = attempt.provider ? `${attempt.provider}/${attempt.model}` : attempt.model;
  return names?.(key) ?? key;
}

/** The models that failed, joined with the list separator of the language. */
export function failedNames(
  fallback: RunFallback,
  language: string,
  names?: ModelNames | null,
): string {
  const list = fallback.failed.map((attempt) => modelName(attempt, names));
  return list.join(language === 'ar' ? '، ' : ', ');
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
