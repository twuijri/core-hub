/**
 * The chat model's fallback chain as the Defaults tab edits it (contract decision §54): an
 * ordered list of models, tried in turn when the one before them fails with an error another
 * model could get past. Pure, so the order rules are tested without a screen.
 */
import type { ModelRef } from './queries.js';

const same = (a: ModelRef, b: ModelRef) => a.provider_id === b.provider_id && a.model === b.model;

/** Adds a model at the end — never twice, and never the chat model it falls back from. */
export function addFallback(
  chain: readonly ModelRef[],
  ref: ModelRef,
  primary: ModelRef | null,
): ModelRef[] {
  if (primary && same(primary, ref)) return [...chain];
  if (chain.some((each) => same(each, ref))) return [...chain];
  return [...chain, ref];
}

/** Moves one entry a place earlier (`-1`) or later (`+1`); the ends stay where they are. */
export function moveFallback(chain: readonly ModelRef[], index: number, by: -1 | 1): ModelRef[] {
  const target = index + by;
  if (index < 0 || index >= chain.length || target < 0 || target >= chain.length) {
    return [...chain];
  }
  const next = [...chain];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as ModelRef);
  return next;
}

export function removeFallback(chain: readonly ModelRef[], index: number): ModelRef[] {
  return chain.filter((_, at) => at !== index);
}
