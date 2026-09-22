/**
 * When a schedule runs next. These are the rules a scheduler is trusted or distrusted for,
 * so they are tested against fixed instants and named timezones, never against "now".
 */
import { describe, expect, it } from 'vitest';
import { CronError, nextCron, nextRunAt, parseCron, partsIn } from './cron.js';

const at = (iso: string) => new Date(Date.parse(iso));
const next = (expr: string, from: string, zone = 'UTC') =>
  nextCron(parseCron(expr), at(from), zone)?.toISOString() ?? null;

describe('reading a cron expression', () => {
  it('refuses anything that is not five fields, and says how many it saw', () => {
    expect(() => parseCron('* * * *')).toThrow(CronError);
    expect(() => parseCron('* * * * * *')).toThrow(/five fields, not 6/);
  });

  it('refuses a field outside its range instead of firing at a strange time', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minute/);
    expect(() => parseCron('* 24 * * *')).toThrow(/hour/);
    expect(() => parseCron('* * 0 * *')).toThrow(/day/);
    expect(() => parseCron('* * * 13 *')).toThrow(/month/);
    expect(() => parseCron('* * * * 7')).toThrow(/weekday/);
  });

  it('refuses the shorthands it cannot evaluate, rather than never firing', () => {
    expect(() => parseCron('@daily')).toThrow(CronError);
    expect(() => parseCron('0 0 L * *')).toThrow(CronError);
  });

  it('reads stars, numbers, ranges, lists and steps', () => {
    expect([...parseCron('0 * * * *').minute]).toEqual([0]);
    expect([...parseCron('0,30 * * * *').minute]).toEqual([0, 30]);
    expect([...parseCron('0-3 * * * *').minute]).toEqual([0, 1, 2, 3]);
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0-30/10 * * * *').minute]).toEqual([0, 10, 20, 30]);
  });
});

describe('the next minute that matches', () => {
  it('is always strictly after the moment asked about, never the same minute twice', () => {
    expect(next('* * * * *', '2026-09-22T10:00:00Z')).toBe('2026-09-22T10:01:00.000Z');
    expect(next('0 * * * *', '2026-09-22T10:00:00Z')).toBe('2026-09-22T11:00:00.000Z');
  });

  it('crosses days, months and years', () => {
    expect(next('0 0 * * *', '2026-09-22T23:30:00Z')).toBe('2026-09-23T00:00:00.000Z');
    expect(next('0 0 1 * *', '2026-09-22T00:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(next('0 0 1 1 *', '2026-09-22T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('finds 29 February without being told it is rare', () => {
    expect(next('0 0 29 2 *', '2026-09-22T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('answers "never" for an expression that can never match, instead of hanging', () => {
    expect(next('0 0 31 2 *', '2026-09-22T00:00:00Z')).toBeNull();
  });

  it('runs in the schedule’s own timezone, not the server’s', () => {
    // 09:00 in Riyadh is 06:00 UTC.
    expect(next('0 9 * * *', '2026-09-22T00:00:00Z', 'Asia/Riyadh')).toBe(
      '2026-09-22T06:00:00.000Z',
    );
  });

  it('or-s day-of-month with day-of-week, the way every cron does', () => {
    // "the 1st, and every Monday" — 2026-09-28 is a Monday, 2026-10-01 is the 1st.
    expect(next('0 0 1 * 1', '2026-09-22T00:00:00Z')).toBe('2026-09-28T00:00:00.000Z');
  });

  it('reads the hour of midnight as 0, whatever the platform formats it as', () => {
    expect(partsIn(at('2026-09-22T00:30:00Z'), 'UTC').hour).toBe(0);
  });
});

describe('the next run of a schedule', () => {
  it('a one-off runs once, and then never again', () => {
    const trigger = { kind: 'once' as const, runAt: at('2026-09-23T10:00:00Z') };
    expect(nextRunAt(trigger, at('2026-09-22T00:00:00Z'), null)?.toISOString()).toBe(
      '2026-09-23T10:00:00.000Z',
    );
    // Already run: there is no next time.
    expect(nextRunAt(trigger, at('2026-09-22T00:00:00Z'), at('2026-09-22T00:00:00Z'))).toBeNull();
    // The moment has passed and it never ran: it is not fired late.
    expect(nextRunAt(trigger, at('2026-09-24T00:00:00Z'), null)).toBeNull();
  });

  it('an interval counts from the last run, and from now when there was none', () => {
    const trigger = { kind: 'interval' as const, intervalSeconds: 3600 };
    expect(nextRunAt(trigger, at('2026-09-22T10:00:00Z'), null)?.toISOString()).toBe(
      '2026-09-22T11:00:00.000Z',
    );
    expect(
      nextRunAt(trigger, at('2026-09-22T10:00:00Z'), at('2026-09-22T09:30:00Z'))?.toISOString(),
    ).toBe('2026-09-22T10:30:00.000Z');
  });

  it('a schedule that was asleep does not fire once for every interval it missed', () => {
    const trigger = { kind: 'interval' as const, intervalSeconds: 3600 };
    // Last run a week ago: the answer is one hour from now, not 168 firings.
    const from = at('2026-09-22T10:00:00Z');
    expect(nextRunAt(trigger, from, at('2026-09-15T10:00:00Z'))?.toISOString()).toBe(
      '2026-09-22T11:00:00.000Z',
    );
  });

  it('answers "never" for a trigger it cannot read, instead of guessing', () => {
    expect(
      nextRunAt({ kind: 'cron', cron: '@daily' }, at('2026-09-22T10:00:00Z'), null),
    ).toBeNull();
    expect(nextRunAt({ kind: 'cron', cron: null }, at('2026-09-22T10:00:00Z'), null)).toBeNull();
    expect(
      nextRunAt({ kind: 'interval', intervalSeconds: 0 }, at('2026-09-22T10:00:00Z'), null),
    ).toBeNull();
  });
});
