// Structured JSON logging with secret redaction. Nothing secret is ever written to a log
// (ARCHITECTURE §Data ownership); add new secret field names here, not at call sites.
import pino, { type Logger, type LoggerOptions } from 'pino';

export const REDACTED = '[redacted]';

const SECRET_FIELDS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'appToken',
  'apiKey',
  'api_key',
  'secret',
  'clientSecret',
  'privateKey',
  'authorization',
  'cookie',
  'HUB_ADMIN_PASSWORD',
  'DATABASE_URL',
];

/** pino redact paths: top-level, one level down, and inside req/res headers. */
export const REDACT_PATHS = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
  ...SECRET_FIELDS.map((field) => `*.*.${field}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export interface LoggerConfig {
  level?: string;
  /** Pretty-print for a terminal; JSON otherwise. Never on in the container. */
  pretty?: boolean;
  destination?: pino.DestinationStream;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    base: { service: 'corehub' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (config.destination) return pino(options, config.destination);
  if (config.pretty && canPretty()) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(options);
}

function canPretty(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export type { Logger };
