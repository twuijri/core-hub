/**
 * The external entrance's own pieces (DECISIONS §156): the per-token rate limit and the admin
 * switch kept beside the gateway's state. The routes themselves are exercised through the
 * generated client in `tests/contract/external-gateway.contract.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalGatewaySettings, TokenRateLimiter } from './external.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the external entrance', () => {
  it('limits each token to its calls a minute, and says when to try again', () => {
    let now = 1_000_000;
    const limiter = new TokenRateLimiter(2, () => now);
    expect(limiter.take('a')).toEqual({ ok: true });
    now += 10_000;
    expect(limiter.take('a')).toEqual({ ok: true });
    // Another token has its own count.
    expect(limiter.take('b')).toEqual({ ok: true });
    now += 5_000;
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterS: 45 });
    // A minute after the first call, one more is allowed.
    now = 1_000_000 + 60_000;
    expect(limiter.take('a')).toEqual({ ok: true });
  });

  it('is off until switched on, and keeps the switch 0600 across a restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-external-'));
    dirs.push(dir);
    const settings = new ExternalGatewaySettings(path.join(dir, 'gateway'));
    expect(settings.enabled()).toBe(false);
    settings.set(true, 'owner-id');
    const file = path.join(dir, 'gateway', 'external.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      enabled: true,
      updated_by: 'owner-id',
    });
    expect(new ExternalGatewaySettings(path.join(dir, 'gateway')).enabled()).toBe(true);
  });
});
