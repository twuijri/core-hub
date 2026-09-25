// Structured JSON logging with secret redaction. Nothing secret is ever written to a log
// (ARCHITECTURE §Data ownership); add new secret field names here, not at call sites.
import { derived } from '@corehub/contracts';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { LogRing, lineOfPinoCall } from './log-ring.js';

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
  /**
   * Where the Logs screen reads this logger's lines from (`log-ring.ts`). A new ring when
   * none is given, so every logger the hub is built with has one (`logRingOf`).
   */
  ring?: LogRing;
}

const RINGS = new WeakMap<Logger, LogRing>();

/** The ring a logger made by `createLogger` writes into; null for any other logger. */
export function logRingOf(logger: object): LogRing | null {
  return RINGS.get(logger as Logger) ?? null;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const ring = config.ring ?? new LogRing();
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    base: { service: derived.serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      // Called for every line the level lets through, child loggers included. A line the
      // ring cannot take must never cost the log line itself.
      logMethod(args, method, level) {
        try {
          const line = lineOfPinoCall(args, level);
          if (line) ring.push(line);
        } catch {
          // nothing: the ring is a convenience, the log is not
        }
        return method.apply(this, args);
      },
    },
  };
  let logger: Logger;
  if (config.destination) logger = pino(options, config.destination);
  else if (config.pretty && canPretty()) {
    logger = pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  } else logger = pino(options);
  RINGS.set(logger, ring);
  return logger;
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
