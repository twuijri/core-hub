/**
 * When a schedule runs next.
 *
 * A schedule is one of three things, and each has one honest answer:
 *
 * - **once**: the moment it was given, and never again after it passes;
 * - **interval**: the last run plus n seconds, or now plus n when it has never run;
 * - **cron**: the next minute that matches a five-field expression, in the schedule's own
 *   timezone.
 *
 * The cron evaluator is deliberately small and deliberately complete for what the contract
 * allows: a star, a number, `a-b`, `a,b,c`, and either of those with a `/n` step, on
 * the five standard fields.
 * It does **not** accept the shorthands (`@daily`, `L`, `#`) — an expression the hub cannot
 * evaluate is refused when the schedule is saved rather than silently never firing, which
 * is the failure mode that makes people distrust schedulers.
 *
 * It searches forward minute by minute for at most four years, which is what makes
 * "29 February" answerable and an impossible expression (`0 0 31 2 *`) answerable too —
 * with `null`, meaning "never", not with a hang.
 */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** `*` on a field means "any", which matters for the day/weekday pair below. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const RANGES: Array<[keyof Omit<CronFields, 'anyDay' | 'anyWeekday'>, number, number]> = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day', 1, 31],
  ['month', 1, 12],
  ['weekday', 0, 6],
];

export class CronError extends Error {}

/** Parses a five-field expression, or throws `CronError` naming the field that is wrong. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`a cron expression has five fields, not ${parts.length}`);
  }
  const fields: Partial<CronFields> = {};
  for (const [index, [name, min, max]] of RANGES.entries()) {
    const raw = parts[index] as string;
    fields[name] = parseField(raw, min, max, name);
  }
  return {
    ...(fields as Omit<CronFields, 'anyDay' | 'anyWeekday'>),
    anyDay: parts[2] === '*',
    anyWeekday: parts[4] === '*',
  };
}

function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const piece of raw.split(',')) {
    const [range, stepText] = piece.split('/', 2);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`${name}: "${piece}" has no usable step`);
    }
    let from: number;
    let to: number;
    if (range === '*' || range === undefined) {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-', 2);
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(range);
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new CronError(`${name}: "${piece}" is outside ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) out.add(value);
  }
  if (out.size === 0) throw new CronError(`${name}: "${raw}" matches nothing`);
  return out;
}

/** The parts of an instant in a named timezone. Throws for a zone the platform rejects. */
export function partsIn(
  at: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  );
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // `24` is midnight in some locales' 24-hour formatting; the hour of a new day is 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: Math.max(0, weekdays.indexOf(String(parts.weekday))),
  };
}

const MINUTE_MS = 60_000;
/** Four years of days: enough for 29 February, short enough to answer "never" quickly. */
const HORIZON_DAYS = 4 * 366;

/**
 * The instant that reads as this wall clock in that timezone.
 *
 * There is no standard inverse of `Intl.DateTimeFormat`, so this guesses (the wall clock
 * as if it were UTC), measures how far the guess lands from the wanted clock, and corrects
 * by that much. One correction is always enough, because an offset is constant within the
 * hour either side of any transition.
 *
 * Returns `null` for a wall clock that does not exist — the hour a spring-forward skips.
 * A schedule set for 02:30 in a zone that jumps 02:00 to 03:00 does not run that day, and
 * saying so is better than inventing 03:30.
 */
function instantOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const seen = partsIn(new Date(wanted), timezone);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - wanted;
  const corrected = new Date(wanted - offset);
  const check = partsIn(corrected, timezone);
  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    return null;
  }
  return corrected;
}

/**
 * The first minute strictly after `from` that matches, or `null` when the expression can
 * never match (`0 0 31 2 *`).
 *
 * The search walks **days**, not minutes: a day either matches the month/day/weekday rules
 * or it does not, and only a matching day is asked about its hours. That is what makes an
 * impossible expression answerable in milliseconds instead of two million iterations.
 *
 * Day-of-month and day-of-week are **or**-ed when both are restricted, which is what every
 * cron does and what surprises everyone who has not met it before: `0 9 1 * 1` is "the
 * first of the month **and** every Monday", not "a Monday that is the first".
 */
export function nextCron(fields: CronFields, from: Date, timezone: string): Date | null {
  const hours = [...fields.hour].sort((a, b) => a - b);
  const minutes = [...fields.minute].sort((a, b) => a - b);
  // A schedule never fires twice in the same minute, so the search starts at the next one.
  const after = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS - 1;
  const start = partsIn(new Date(after), timezone);
  // Walk local days from midnight UTC of the same calendar date; the zone is applied when
  // each candidate instant is built.
  let cursor = Date.UTC(start.year, start.month - 1, start.day);

  for (let day = 0; day < HORIZON_DAYS; day += 1) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dayOfMonth = date.getUTCDate();
    const weekday = date.getUTCDay();
    const dayMatches =
      fields.anyDay && fields.anyWeekday
        ? true
        : fields.anyDay
          ? fields.weekday.has(weekday)
          : fields.anyWeekday
            ? fields.day.has(dayOfMonth)
            : fields.day.has(dayOfMonth) || fields.weekday.has(weekday);
    if (fields.month.has(month) && dayMatches) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const at = instantOf(year, month, dayOfMonth, hour, minute, timezone);
          if (at && at.getTime() > after) return at;
        }
      }
    }
    cursor += 24 * 60 * MINUTE_MS;
  }
  return null;
}

export interface Trigger {
  kind: 'cron' | 'interval' | 'once';
  cron?: string | null;
  timezone?: string | null;
  intervalSeconds?: number | null;
  runAt?: Date | null;
}

/**
 * The next time a schedule should run, or `null` for "never again" — an exhausted `once`,
 * an impossible cron, or a trigger the hub cannot read.
 */
export function nextRunAt(trigger: Trigger, from: Date, lastRunAt: Date | null): Date | null {
  if (trigger.kind === 'once') {
    const at = trigger.runAt ?? null;
    if (!at) return null;
    // A one-off that has already run, or whose moment has passed, has no next time.
    if (lastRunAt) return null;
    return at.getTime() > from.getTime() ? at : null;
  }
  if (trigger.kind === 'interval') {
    const seconds = trigger.intervalSeconds ?? 0;
    if (seconds < 1) return null;
    const base = lastRunAt ?? from;
    const next = new Date(base.getTime() + seconds * 1000);
    // A schedule that was asleep does not fire for every interval it missed.
    return next.getTime() > from.getTime() ? next : new Date(from.getTime() + seconds * 1000);
  }
  if (!trigger.cron) return null;
  try {
    return nextCron(parseCron(trigger.cron), from, trigger.timezone ?? 'UTC');
  } catch {
    return null;
  }
}
