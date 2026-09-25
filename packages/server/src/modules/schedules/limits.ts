/**
 * What one workflow run may take (DECISIONS §53): a time budget, a cost budget and a
 * per-step timeout. This file is the pure half — reading what a person wrote, merging a
 * run's own limits over its workflow's, and the arithmetic in micro-USD; the engine
 * (`workflow-engine.ts`) enforces them.
 *
 * Every limit is optional (`null`). Money is the contract's decimal string in USD, because
 * the hub's per-turn estimate (`Usage.cost`) is in USD and a budget in another currency
 * could only be compared through a rate the hub does not have.
 */
import { conflict } from '../../lib/errors.js';
import type { WorkflowLimits } from './schema.js';

export const NO_LIMITS: WorkflowLimits = {
  max_duration_seconds: null,
  max_cost: null,
  step_timeout_seconds: null,
};

/** The contract's bounds, repeated here for a caller that is not a route (an import). */
const MAX_DURATION_SECONDS = 7 * 24 * 3600;
const MAX_STEP_SECONDS = 24 * 3600;

/** `"2.50"` → 2_500_000. Digits beyond the sixth decimal are dropped, not rounded up. */
export function microUsdOf(amount: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return Number.NaN;
  const [, sign, whole, fraction = ''] = match;
  const micro = Number(whole) * 1_000_000 + Number(fraction.slice(0, 6).padEnd(6, '0'));
  return sign === '-' ? -micro : micro;
}

/** 2_500_000 → `{ amount: "2.500000", currency: "USD" }`, the shape `Usage.cost` has. */
export function moneyOfMicro(microUsd: number): { amount: string; currency: 'USD' } {
  const sign = microUsd < 0 ? '-' : '';
  const abs = Math.abs(Math.round(microUsd));
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, '0');
  return { amount: `${sign}${whole}.${fraction}`, currency: 'USD' };
}

/** `2_500_000` → `"$2.50"`, for the words of an error a person reads. */
export function dollars(microUsd: number): string {
  const value = microUsd / 1_000_000;
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** `5400` → `"1 h 30 min"`, for the same words. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest && !hours) parts.push(`${rest} s`);
  return parts.join(' ');
}

function seconds(value: unknown, field: string, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw conflict({ reason: 'limit_invalid', field });
  }
  return value;
}

function cost(value: unknown, field: string): WorkflowLimits['max_cost'] {
  if (value === null || value === undefined) return null;
  const money = value as { amount?: unknown; currency?: unknown };
  const amount = typeof money.amount === 'string' ? money.amount : '';
  if (money.currency !== 'USD' || !(microUsdOf(amount) > 0)) {
    throw conflict({ reason: 'limit_invalid', field });
  }
  return { amount, currency: 'USD' };
}

/**
 * A workflow's limits as a person wrote them (`WorkflowWrite.limits`), checked: a cost in
 * another currency, or not above zero, is `409 limit_invalid` with the field. Absent is none.
 */
export function limitsOf(input: unknown): WorkflowLimits {
  if (input === null || input === undefined) return { ...NO_LIMITS };
  const raw = input as Record<string, unknown>;
  return {
    max_duration_seconds: seconds(
      raw.max_duration_seconds,
      'limits.max_duration_seconds',
      MAX_DURATION_SECONDS,
    ),
    max_cost: cost(raw.max_cost, 'limits.max_cost'),
    step_timeout_seconds: seconds(
      raw.step_timeout_seconds,
      'limits.step_timeout_seconds',
      MAX_STEP_SECONDS,
    ),
  };
}

/**
 * One run's limits: the workflow's, with each field the run asked for over it — a value
 * replaces, `null` lifts, absent keeps (`WorkflowLimitsOverride`). `timeout_ms` is the
 * older spelling of the time budget; `limits.max_duration_seconds` wins over it.
 */
export function runLimits(
  base: WorkflowLimits | undefined,
  override: Record<string, unknown> | null | undefined,
  timeoutMs?: number | null,
): WorkflowLimits {
  const limits: WorkflowLimits = { ...NO_LIMITS, ...(base ?? {}) };
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    limits.max_duration_seconds = Math.min(Math.ceil(timeoutMs / 1000), MAX_DURATION_SECONDS);
  }
  if (!override) return limits;
  if ('max_duration_seconds' in override) {
    limits.max_duration_seconds = seconds(
      override.max_duration_seconds,
      'limits.max_duration_seconds',
      MAX_DURATION_SECONDS,
    );
  }
  if ('max_cost' in override) limits.max_cost = cost(override.max_cost, 'limits.max_cost');
  if ('step_timeout_seconds' in override) {
    limits.step_timeout_seconds = seconds(
      override.step_timeout_seconds,
      'limits.step_timeout_seconds',
      MAX_STEP_SECONDS,
    );
  }
  return limits;
}
