/**
 * The lines the Logs screen reads (`audit.listLogLines`, contract decision §51).
 *
 * Kept in memory, in bounded rings — one for the hub and one per Hermes profile — rather
 * than in the database or a file: a log is only worth keeping while somebody may want to
 * read what just happened, the container's own stdout already keeps the full history for
 * whoever runs `docker logs`, and a ring cannot fill a disk or slow a write. One ring per
 * source, so a chatty WhatsApp gateway cannot push the hub's own last error out of view.
 * A restart empties them; the screen says so.
 *
 * Every line gets a `seq` from one counter across the rings, which is what a live tail
 * asks with (`after`): "anything newer than the last line I have".
 */
import { format } from 'node:util';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogSource = 'hub' | 'hermes';

export interface LogLine {
  seq: number;
  at: string;
  level: LogLevel;
  source: LogSource;
  /** The Hermes profile whose gateway wrote it; `tui` for the TUI gateway; null for the hub. */
  profile: string | null;
  message: string;
}

export interface LogLineInput {
  at?: number;
  level: LogLevel;
  source: LogSource;
  profile?: string | null;
  message: string;
}

export interface LogQuery {
  source?: 'all' | 'hub' | 'hermes' | 'errors';
  profile?: string | undefined;
  /** The least severe level shown. */
  level?: LogLevel | undefined;
  q?: string | undefined;
  limit?: number;
  after?: number | undefined;
}

export interface LogPage {
  lines: LogLine[];
  last_seq: number;
  capacity: number;
  sources: Array<{ source: LogSource; profile: string | null; lines: number }>;
}

/** The most the screen offers (200 · 1000 · 5000), so the most a ring has to keep. */
export const LOG_RING_CAPACITY = 5000;
/** A line longer than this is cut: a log line is read, not stored as a document. */
export const LOG_LINE_MAX = 4000;
/** Profiles are few; this only stops a bug that invents names from growing memory. */
const MAX_SOURCES = 64;

const SEVERITY: Record<LogLevel, number> = { error: 3, warn: 2, info: 1, debug: 0 };

/** One fixed-size ring: the newest `capacity` lines, oldest first when read. */
class Ring {
  private readonly items: Array<LogLine | undefined>;
  private next = 0;
  size = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<LogLine | undefined>(capacity);
  }

  push(line: LogLine): void {
    this.items[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Oldest first. */
  *lines(): Generator<LogLine> {
    const start = (this.next - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      const line = this.items[(start + i) % this.capacity];
      if (line) yield line;
    }
  }
}

export class LogRing {
  private readonly rings = new Map<
    string,
    { source: LogSource; profile: string | null; ring: Ring }
  >();
  private seq = 0;

  constructor(readonly capacity: number = LOG_RING_CAPACITY) {}

  push(input: LogLineInput): LogLine | null {
    const profile = input.source === 'hub' ? null : (input.profile ?? 'default');
    const key = `${input.source}:${profile ?? ''}`;
    let entry = this.rings.get(key);
    if (!entry) {
      if (this.rings.size >= MAX_SOURCES) return null;
      entry = { source: input.source, profile, ring: new Ring(this.capacity) };
      this.rings.set(key, entry);
    }
    this.seq += 1;
    const message =
      input.message.length > LOG_LINE_MAX
        ? `${input.message.slice(0, LOG_LINE_MAX)}…`
        : input.message;
    const line: LogLine = {
      seq: this.seq,
      at: new Date(input.at ?? Date.now()).toISOString(),
      level: input.level,
      source: input.source,
      profile,
      message,
    };
    entry.ring.push(line);
    return line;
  }

  /** The newest `limit` lines that match, oldest first. */
  query(query: LogQuery = {}): LogPage {
    const source = query.source ?? 'all';
    const floor = SEVERITY[query.level ?? 'debug'];
    const needle = query.q?.trim().toLowerCase() || null;
    const limit = Math.max(1, Math.min(query.limit ?? 200, LOG_RING_CAPACITY));
    const after = query.after ?? 0;

    const matched: LogLine[] = [];
    for (const entry of this.rings.values()) {
      if (source === 'hub' && entry.source !== 'hub') continue;
      if (source === 'hermes' && entry.source !== 'hermes') continue;
      if (query.profile && entry.profile !== query.profile) continue;
      for (const line of entry.ring.lines()) {
        if (line.seq <= after) continue;
        if (source === 'errors' ? line.level !== 'error' : SEVERITY[line.level] < floor) continue;
        if (needle && !line.message.toLowerCase().includes(needle)) continue;
        matched.push(line);
      }
    }
    matched.sort((a, b) => a.seq - b.seq);
    return {
      lines: matched.slice(-limit),
      last_seq: this.seq,
      capacity: this.capacity,
      sources: [...this.rings.values()]
        .map((entry) => ({ source: entry.source, profile: entry.profile, lines: entry.ring.size }))
        .sort((a, b) =>
          a.source === b.source
            ? (a.profile ?? '').localeCompare(b.profile ?? '')
            : a.source === 'hub'
              ? -1
              : 1,
        ),
    };
  }
}

// ------------------------------------------------------------ from the logger

const PINO_LEVELS: Array<[number, LogLevel]> = [
  [50, 'error'], // error and fatal
  [40, 'warn'],
  [30, 'info'],
  [0, 'debug'], // debug and trace
];

export function levelOfPino(level: number): LogLevel {
  return PINO_LEVELS.find(([floor]) => level >= floor)?.[1] ?? 'debug';
}

/**
 * The level a Hermes line says it is. Hermes writes Python's logging format to its output
 * (`… - ERROR - …`, `[WARNING]`, a traceback), and the hub pipes stdout as `info` and
 * stderr as `warn` — so the words in the line are a better answer than which pipe it came
 * through. A line that names no level keeps the pipe's.
 */
export function levelOfHermesLine(text: string, fallback: LogLevel): LogLevel {
  if (/\b(ERROR|CRITICAL|FATAL)\b|^Traceback \(most recent call last\)/.test(text)) return 'error';
  if (/\bWARN(ING)?\b/.test(text)) return 'warn';
  if (/\bINFO\b/.test(text)) return 'info';
  if (/\bDEBUG\b/.test(text)) return 'debug';
  return fallback;
}

/**
 * Turns one pino call (`log.info(obj, msg, ...args)` or `log.info(msg, ...args)`) into a
 * line, or `null` for a line the ring does not keep.
 *
 * Only the message and an error's message are kept, never the object's other fields — the
 * ring is filled before pino's redaction runs, so copying fields would copy the secrets
 * redaction exists to remove. Fastify's per-request access lines (`req` / `res` and no
 * error) are left out: the Logs screen polls, and its own requests would fill the ring.
 */
export function lineOfPinoCall(args: unknown[], level: number): LogLineInput | null {
  let fields: Record<string, unknown> = {};
  let rest = args;
  const first = args[0];
  if (first instanceof Error) {
    fields = { err: first };
    rest = args.slice(1);
  } else if (first !== null && typeof first === 'object') {
    fields = first as Record<string, unknown>;
    rest = args.slice(1);
  }
  const error = fields.err instanceof Error ? fields.err : null;
  if (!error && ('req' in fields || 'res' in fields)) return null;

  let message = rest.length > 0 ? format(...(rest as [unknown, ...unknown[]])) : '';
  if (error) message = message ? `${message}: ${error.message}` : error.message;
  if (!message) return null;

  const hermes = fields.hermes === true;
  const pinoLevel = levelOfPino(level);
  return {
    level: hermes ? levelOfHermesLine(message, pinoLevel) : pinoLevel,
    source: hermes ? 'hermes' : 'hub',
    profile: hermes ? (typeof fields.profile === 'string' ? fields.profile : 'default') : null,
    message,
  };
}
