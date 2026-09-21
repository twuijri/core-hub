import { HubApiError } from '@majlis/contracts';
import { authenticatedClient, type AuthenticatedClient } from '../client.js';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';

export function requireSession(ctx: CommandContext): AuthenticatedClient {
  return authenticatedClient(ctx.store, {
    language: ctx.language,
    profile: ctx.globals.profile,
  });
}

export function optionString(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.options[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function optionInteger(
  ctx: CommandContext,
  name: string,
  fallback: number,
  range?: { min: number; max: number },
): number {
  const raw = optionString(ctx, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || (range && (value < range.min || value > range.max)))
    throw new UsageError('usage.invalid_option', { option: `--${name}`, value: raw });
  return value;
}

export function optionEnum<T extends string>(
  ctx: CommandContext,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = optionString(ctx, name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw))
    throw new UsageError('usage.invalid_option', { option: `--${name}`, value: raw });
  return raw as T;
}

export const isNotImplemented = (error: unknown): boolean =>
  error instanceof HubApiError && error.status === 501;

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, 'Z');
}
