// The Logs screen's rings (lib/log-ring.ts): bounded per source, filtered by source, profile,
// least level and text, tailed by `seq`; and filled by the hub's own logger without copying
// the fields redaction exists to hide.
import { describe, expect, it } from 'vitest';
import {
  LOG_LINE_MAX,
  LogRing,
  levelOfHermesLine,
  lineOfPinoCall,
} from '../../src/lib/log-ring.js';
import { createLogger, logRingOf } from '../../src/lib/logger.js';
import { capturingLogger } from './helpers.js';

function filled(): LogRing {
  const ring = new LogRing(10);
  ring.push({ level: 'info', source: 'hub', message: 'core hub listening' });
  ring.push({ level: 'warn', source: 'hermes', profile: 'default', message: 'slow provider' });
  ring.push({ level: 'error', source: 'hermes', profile: 'work', message: 'bridge exited' });
  ring.push({ level: 'debug', source: 'hub', message: 'sampled' });
  ring.push({ level: 'error', source: 'hub', message: 'Database locked' });
  return ring;
}

describe('LogRing', () => {
  it('keeps each source to its capacity, so a loud one cannot push another out', () => {
    const ring = new LogRing(3);
    ring.push({ level: 'error', source: 'hub', message: 'the one hub error' });
    for (let i = 0; i < 50; i += 1) {
      ring.push({ level: 'info', source: 'hermes', profile: 'work', message: `chatter ${i}` });
    }
    const page = ring.query({ limit: 100 });
    expect(page.lines.map((line) => line.message)).toEqual([
      'the one hub error',
      'chatter 47',
      'chatter 48',
      'chatter 49',
    ]);
    expect(page.sources).toEqual([
      { source: 'hub', profile: null, lines: 1 },
      { source: 'hermes', profile: 'work', lines: 3 },
    ]);
    expect(page.last_seq).toBe(51);
    expect(page.capacity).toBe(3);
  });

  it('returns the newest lines oldest first, cut to the limit', () => {
    const page = filled().query({ limit: 2 });
    expect(page.lines.map((line) => line.message)).toEqual(['sampled', 'Database locked']);
    expect(page.lines.map((line) => line.seq)).toEqual([4, 5]);
  });

  it('filters by source and by the profile of a Hermes gateway', () => {
    const ring = filled();
    expect(ring.query({ source: 'hub' }).lines.map((l) => l.message)).toEqual([
      'core hub listening',
      'sampled',
      'Database locked',
    ]);
    expect(ring.query({ source: 'hermes' }).lines.map((l) => l.profile)).toEqual([
      'default',
      'work',
    ]);
    expect(ring.query({ source: 'hermes', profile: 'work' }).lines.map((l) => l.message)).toEqual([
      'bridge exited',
    ]);
  });

  it('"errors only" is every source’s errors, whatever level is asked', () => {
    const lines = filled().query({ source: 'errors', level: 'debug' }).lines;
    expect(lines.map((l) => [l.source, l.message])).toEqual([
      ['hermes', 'bridge exited'],
      ['hub', 'Database locked'],
    ]);
  });

  it('shows a level and everything more severe', () => {
    expect(
      filled()
        .query({ level: 'warn' })
        .lines.map((l) => l.level),
    ).toEqual(['warn', 'error', 'error']);
    expect(filled().query({ level: 'debug' }).lines).toHaveLength(5);
  });

  it('searches the text without regard to case', () => {
    expect(
      filled()
        .query({ q: 'database' })
        .lines.map((l) => l.message),
    ).toEqual(['Database locked']);
    expect(filled().query({ q: '  ' }).lines).toHaveLength(5);
  });

  it('tails: only lines newer than the last one the client has', () => {
    const ring = filled();
    const first = ring.query({});
    ring.push({ level: 'info', source: 'hub', message: 'new line' });
    const next = ring.query({ after: first.last_seq });
    expect(next.lines.map((l) => l.message)).toEqual(['new line']);
    expect(next.last_seq).toBe(first.last_seq + 1);
  });

  it('cuts a very long line', () => {
    const ring = new LogRing(2);
    ring.push({ level: 'info', source: 'hub', message: 'x'.repeat(LOG_LINE_MAX + 50) });
    expect(ring.query({}).lines[0]!.message).toHaveLength(LOG_LINE_MAX + 1);
  });
});

describe('lines from the logger', () => {
  it('keeps the message and an error’s message, never the other fields', () => {
    const line = lineOfPinoCall(
      [{ apiKey: 'sk-secret', err: new Error('connect ECONNREFUSED') }, 'models: probe failed'],
      50,
    );
    expect(line).toEqual({
      level: 'error',
      source: 'hub',
      profile: null,
      message: 'models: probe failed: connect ECONNREFUSED',
    });
    expect(JSON.stringify(line)).not.toContain('sk-secret');
  });

  it('leaves out the per-request access lines, which the screen’s own polling would fill', () => {
    expect(
      lineOfPinoCall([{ req: { url: '/api/v1/audit/logs/lines' } }, 'incoming request'], 30),
    ).toBeNull();
    expect(lineOfPinoCall([{ res: { statusCode: 200 } }, 'request completed'], 30)).toBeNull();
    // A request that failed is kept.
    expect(
      lineOfPinoCall([{ req: {}, err: new Error('boom') }, 'request errored'], 50)?.message,
    ).toBe('request errored: boom');
  });

  it('files Hermes lines under their profile, at the level the line itself says', () => {
    expect(lineOfPinoCall([{ hermes: true }, 'INFO gateway: connected'], 40)).toEqual({
      level: 'info',
      source: 'hermes',
      profile: 'default',
      message: 'INFO gateway: connected',
    });
    expect(
      lineOfPinoCall([{ hermes: true, profile: 'work' }, 'ERROR whatsapp: bridge exited'], 30),
    ).toMatchObject({ level: 'error', source: 'hermes', profile: 'work' });
    expect(levelOfHermesLine('Traceback (most recent call last):', 'info')).toBe('error');
    expect(levelOfHermesLine('2026-09-25 10:00 - WARNING - slow', 'info')).toBe('warn');
    expect(levelOfHermesLine('plain words', 'warn')).toBe('warn');
  });

  it('is filled by the logger the hub is built with, child loggers too', () => {
    const { logger } = capturingLogger();
    const ring = logRingOf(logger)!;
    expect(ring).toBeInstanceOf(LogRing);
    logger.info('hub started');
    logger.child({ module: 'agents' }).warn({ hermes: true, profile: 'work' }, 'WARNING x');
    logger.debug('fine detail');
    expect(ring.query({}).lines.map((l) => [l.source, l.profile, l.level, l.message])).toEqual([
      ['hub', null, 'info', 'hub started'],
      ['hermes', 'work', 'warn', 'WARNING x'],
      ['hub', null, 'debug', 'fine detail'],
    ]);
  });

  it('keeps nothing below the logger’s own level, and a given ring is the one filled', () => {
    const ring = new LogRing();
    const logger = createLogger({ level: 'warn', ring, destination: { write: () => undefined } });
    logger.info('not written anywhere');
    logger.error('written');
    expect(logRingOf(logger)).toBe(ring);
    expect(ring.query({}).lines.map((l) => l.message)).toEqual(['written']);
  });
});
