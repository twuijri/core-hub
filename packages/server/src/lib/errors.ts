// The one error envelope every client sees: `{ error, code }` (TEAM-RULES §4).
import { t, type Language } from '../i18n/index.js';

/** The fixed list from `ErrorCode` in packages/contracts/openapi.yaml. Adding one is a
 * contract change; every code has an `errors.<code>` string in both locales. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'profile_required',
  'unauthorized',
  'token_expired',
  'forbidden',
  'not_found',
  'profile_not_found',
  'conflict',
  'state_invalid',
  'already_running',
  'payload_too_large',
  'unsupported_media_type',
  'agent_unavailable',
  'agent_error',
  'rate_limited',
  'internal',
  'not_implemented',
  'service_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  profile_required: 400,
  unauthorized: 401,
  token_expired: 401,
  forbidden: 403,
  not_found: 404,
  profile_not_found: 404,
  conflict: 409,
  state_invalid: 409,
  already_running: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  agent_unavailable: 422,
  agent_error: 422,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  service_unavailable: 503,
};

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  details?: unknown;
}

export interface HubErrorOptions {
  message?: string;
  details?: unknown;
  status?: number;
  /** i18n key (`errors.*` or a module key) used for `error` instead of the code's default text. */
  messageKey?: string;
  /** Response headers to send with the envelope (`Retry-After` on a lockout). */
  headers?: Record<string, string>;
}

export class HubError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly messageKey: string | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(code: ErrorCode, options: HubErrorOptions = {}) {
    super(options.message ?? code);
    this.name = 'HubError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
    this.messageKey = options.messageKey;
    this.headers = options.headers;
  }

  toEnvelope(language: Language): ErrorEnvelope {
    const envelope: ErrorEnvelope = {
      error: t(this.messageKey ?? `errors.${this.code}`, language),
      code: this.code,
    };
    if (this.details !== undefined) envelope.details = this.details;
    return envelope;
  }
}

export const badRequest = (details?: unknown) => new HubError('bad_request', { details });
export const notFound = (details?: unknown) => new HubError('not_found', { details });
export const conflict = (
  code: 'conflict' | 'state_invalid' | 'already_running',
  details?: unknown,
) => new HubError(code, { details });
export const notImplemented = (details?: unknown) => new HubError('not_implemented', { details });
export const validationFailed = (details?: unknown) =>
  new HubError('validation_failed', { details });
