/**
 * The schedule strings the hub sends, read by **the real Hermes** parser.
 *
 * `hermesScheduleOf` writes Hermes's grammar; this asks Hermes's own `parse_schedule`
 * (`tests/fixtures/hermes-schedule.py`) what it makes of each one, so a grammar change in
 * a Hermes release fails here rather than as a schedule that never fires. Point
 * `HERMES_SRC` at a checkout of the release the image pins; without it the suite is
 * skipped and says why:
 *
 *   git clone --depth 1 --branch v2026.9.14 https://github.com/NousResearch/hermes-agent
 *   HERMES_SRC=$PWD/hermes-agent pnpm --filter @majlis/server test
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hermesScheduleOf } from './hermes-jobs.js';

const source = process.env.HERMES_SRC;
const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.resolve(here, '../../../tests/fixtures/hermes-schedule.py');

type Parsed = { ok: true; schedule: Record<string, unknown> } | { ok: false; error: string };

function parse(...texts: string[]): Parsed[] {
  const home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-cron-'));
  try {
    const out = execFileSync('python3', [shim, ...texts], {
      env: { PATH: process.env.PATH, PYTHONPATH: source, HERMES_HOME: home },
      encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').at(-1)!) as Parsed[];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!source)('Hermes cron grammar (real Hermes; set HERMES_SRC to run)', () => {
  it('reads an interval as the same interval', () => {
    const [parsed] = parse(hermesScheduleOf({ kind: 'interval', every_minutes: 45 }));
    expect(parsed).toMatchObject({ ok: true, schedule: { kind: 'interval', minutes: 45 } });
  });

  it('reads a one-shot as the same instant, whatever zone Hermes is in', () => {
    const at = '2026-10-01T06:00:00.000Z';
    const [parsed] = parse(hermesScheduleOf({ kind: 'once', run_at: at }));
    expect(parsed?.ok).toBe(true);
    const runAt = (parsed as { schedule: { run_at: string } }).schedule.run_at;
    expect(new Date(runAt).toISOString()).toBe(at);
  });

  it('reads a cron expression as itself, when croniter is there to check it', () => {
    const [parsed] = parse(hermesScheduleOf({ kind: 'cron', expression: '0 9 * * 1-5' }));
    if (!parsed?.ok && /croniter/.test(parsed!.error)) return; // Hermes's image has it
    expect(parsed).toMatchObject({ ok: true, schedule: { kind: 'cron', expr: '0 9 * * 1-5' } });
  });
});
