// Exit codes and the errors the CLI raises itself. Server errors arrive as `HubApiError`
// from the generated client and keep the contract's `{ error, code }` envelope.
import { HubApiError } from '@majlis/contracts';
import type { Params, Translator } from './i18n/index.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;

export class CliError extends Error {
  readonly exitCode: number;
  readonly key: string | undefined;
  readonly params: Params | undefined;

  constructor(key: string, params?: Params, exitCode: number = EXIT_ERROR) {
    super(key);
    this.name = 'CliError';
    this.key = key;
    this.params = params;
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(key: string, params?: Params) {
    super(key, params, EXIT_USAGE);
    this.name = 'UsageError';
  }
}

export class AuthError extends CliError {
  constructor(key = 'errors.not_signed_in', params?: Params) {
    super(key, params, EXIT_AUTH);
    this.name = 'AuthError';
  }
}

export function exitCodeOf(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof HubApiError)
    return error.status === 401 || error.status === 403 ? EXIT_AUTH : EXIT_ERROR;
  return EXIT_ERROR;
}

/** `fetch` failures surface as a TypeError whose `cause` names the socket error. */
export function isConnectionError(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) return (cause as { code?: string }).code ?? cause.message;
  return error instanceof Error ? error.message : String(error);
}

/** One human sentence for any error, in the CLI's language. */
export function describeError(error: unknown, t: Translator, server?: string): string {
  if (error instanceof CliError) return t(error.key ?? 'errors.unexpected', error.params);
  if (error instanceof HubApiError) {
    if (error.status === 501) {
      const details = (error.body as { details?: { operationId?: string } } | undefined)?.details;
      return t('errors.not_implemented', { operation: details?.operationId ?? '?' });
    }
    return t('errors.api', { message: error.message, code: error.code, status: error.status });
  }
  if (isConnectionError(error))
    return t('errors.connection', { server: server ?? '?', reason: reasonOf(error) });
  return t('errors.unexpected', {
    message: error instanceof Error ? error.message : String(error),
  });
}
