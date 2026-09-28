/**
 * The values a step is tried with (§124, §127): "Send test message" and "Test this step"
 * fill a template's `{{…}}` from a sample instead of a run.
 *
 * A sample comes from up to two places, the later winning:
 *
 *   1. a run of the workflow (`workflow_run_id`) — the event that started it, what a person
 *      typed, and every step that finished — exactly what that run's steps could read;
 *   2. values a person typed, one per variable, keyed by the path as the template writes it
 *      (`"steps.analysis.output": "…"`, `"trigger.body.task.name": "…"`).
 *
 * Both end up in one `Context`, so the text is rendered by `expr.ts`'s `render` — the code a
 * run uses — and a test cannot say something the run would not.
 */
import { isPath, read, stringify, type Context } from './expr.js';
import type { SchedulesService, Scope } from './service.js';

/** What the workflow's run could read, rebuilt from the run a person picked. */
export function runContext(service: SchedulesService, scope: Scope, runId: string): Context {
  const row = service.workflowRun(scope, runId);
  const stored = (row.input ?? {}) as { trigger?: unknown; input?: unknown };
  const steps: Record<string, { output: unknown }> = {};
  // `stepsOf` is newest first; the first success seen per node is its latest.
  for (const step of service.stepsOf(row.id)) {
    if (step.status === 'succeeded' && !(step.nodeKey in steps)) {
      steps[step.nodeKey] = { output: (step.output as { value?: unknown } | null)?.value ?? null };
    }
  }
  return {
    trigger: stored.trigger === undefined ? null : structuredClone(stored.trigger),
    input: stored.input ?? null,
    steps,
  };
}

/** Keys that are never data, so a typed path can never reach an object's prototype. */
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ROOTS = new Set(['input', 'trigger', 'steps']);

/**
 * Put one typed value at its path. Only the three roots a template may use are written, and
 * a path through something that is not an object replaces it: a sample is a sample.
 */
export function setPath(ctx: Context, path: string, value: string): boolean {
  if (!isPath(path)) return false;
  const parts = path.split('.');
  if (!ROOTS.has(parts[0]!) || parts.some((part) => FORBIDDEN.has(part))) return false;
  if (parts.length === 1) {
    if (parts[0] !== 'input') return false;
    ctx.input = value;
    return true;
  }
  let holder = ctx as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = Object.prototype.hasOwnProperty.call(holder, part) ? holder[part] : undefined;
    if (next === null || typeof next !== 'object') {
      const fresh: Record<string, unknown> = {};
      holder[part] = fresh;
      holder = fresh;
    } else {
      holder = next as Record<string, unknown>;
    }
  }
  holder[parts[parts.length - 1]!] = value;
  return true;
}

/** `base` with the typed values put in, one path at a time. */
export function withValues(
  base: Context,
  values: Record<string, unknown> | null | undefined,
): Context {
  const steps = Object.fromEntries(
    Object.entries(base.steps).map(([id, step]) => [id, { ...step }]),
  );
  const ctx: Context = { ...base, steps };
  if (ctx.trigger !== null && typeof ctx.trigger === 'object') {
    ctx.trigger = structuredClone(ctx.trigger);
  }
  for (const [path, value] of Object.entries(values ?? {})) {
    if (typeof value === 'string') setPath(ctx, path, value);
  }
  return ctx;
}

/** What each variable of `template` reads as in `ctx`; a variable with nothing is left out. */
export function valuesIn(paths: readonly string[], ctx: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    if (path in out) continue;
    const value = read(path, ctx);
    if (value !== undefined) out[path] = stringify(value);
  }
  return out;
}
