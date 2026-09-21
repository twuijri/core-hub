import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/lib/logger.js';
import { capturingLogger } from './helpers.js';

describe('logger', () => {
  it('writes structured JSON and redacts secrets at every common depth', () => {
    const { logger, lines } = capturingLogger();
    logger.info(
      {
        password: 'p1',
        user: { apiKey: 'k1', token: 't1' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', host: 'hub' } },
        nested: { provider: { secret: 's1' } },
        HUB_ADMIN_PASSWORD: 'admin',
        DATABASE_URL: 'postgres://user:pw@db/hub',
      },
      'boot',
    );
    const line = lines[0]!;
    expect(line.msg).toBe('boot');
    expect(line.service).toBe('majlis');
    expect(line.password).toBe(REDACTED);
    expect((line.user as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((line.user as Record<string, unknown>).token).toBe(REDACTED);
    const headers = (line.req as { headers: Record<string, unknown> }).headers;
    expect(headers.authorization).toBe(REDACTED);
    expect(headers.cookie).toBe(REDACTED);
    expect(headers.host).toBe('hub');
    expect((line.nested as { provider: Record<string, unknown> }).provider.secret).toBe(REDACTED);
    expect(line.HUB_ADMIN_PASSWORD).toBe(REDACTED);
    expect(line.DATABASE_URL).toBe(REDACTED);
    expect(JSON.stringify(line)).not.toMatch(/p1|k1|t1|abc|sid=1|s1|admin|pw@db/);
  });
});
