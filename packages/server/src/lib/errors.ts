// The one error envelope every client sees: `{ error, code }` (TEAM-RULES §4).
import { t, type Language } from '../i18n/index.js';

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'profile_required'
  | 'rate_limited'
  | 'not_implemented'
  | 'internal_error';

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  profile_required: 400,
  rate_limited: 429,
  not_implemented: 501,
  internal_error: 500,
};

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  details?: unknown;
}

export class HubError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: unknown; status?: number } = {},
  ) {
    super(options.message ?? code);
    this.name = 'HubError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
  }

  toEnvelope(language: Language): ErrorEnvelope {
    const envelope: ErrorEnvelope = { error: t(`errors.${this.code}`, language), code: this.code };
    if (this.details !== undefined) envelope.details = this.details;
    return envelope;
  }
}

export const notFound = (details?: unknown) => new HubError('not_found', { details });
export const notImplemented = (details?: unknown) => new HubError('not_implemented', { details });
export const validationFailed = (details?: unknown) =>
  new HubError('validation_failed', { details });
