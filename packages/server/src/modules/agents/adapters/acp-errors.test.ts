/**
 * An agent's JSON-RPC error in full (owner, 2026-09-29: Goose's chat ended in a bare "Internal
 * error"): what its `data` adds, or its stderr's last lines, with credentials masked.
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../lib/redact-text.js';
import { describeAcpError } from './acp.js';

describe('describeAcpError', () => {
  it('keeps the message and adds what data says', () => {
    expect(
      describeAcpError({
        code: -32603,
        message: 'Internal error',
        data: { details: 'No provider configured. Run goose configure first' },
      }),
    ).toBe('Internal error: No provider configured. Run goose configure first');
    expect(describeAcpError({ code: -32000, message: 'Authentication required' })).toBe(
      'Authentication required',
    );
    expect(describeAcpError({ message: 'Bad', data: 'bad model name' })).toBe(
      'Bad: bad model name',
    );
  });

  it('explains a bare Internal error with the last lines of stderr, keys masked', () => {
    const stderr = [
      'starting',
      'ERROR goose::agents: provider error',
      'Error: GOOSE_PROVIDER is not set; OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv',
    ].join('\n');
    const text = describeAcpError({ code: -32603, message: 'Internal error' }, stderr);
    expect(text).toContain('Internal error — ');
    expect(text).toContain('GOOSE_PROVIDER is not set');
    expect(text).not.toContain('sk-proj-abcdefghijklmnopqrstuv');
    expect(text).toContain('[redacted]');
  });

  it('is bounded', () => {
    const long = 'x '.repeat(2000);
    expect(describeAcpError({ message: 'Internal error' }, long).length).toBeLessThanOrEqual(600);
  });
});

describe('redactSecrets', () => {
  it('masks keys and tokens and leaves ordinary words, paths and versions', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactSecrets('"api_key": "AIzaSyA1234567890abcdefghijkl"')).not.toContain('AIza');
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('[redacted]');
    expect(redactSecrets('Authentication required at /data/home/.claude v2.1.0')).toBe(
      'Authentication required at /data/home/.claude v2.1.0',
    );
  });
});
