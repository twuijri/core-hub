import { describe, expect, it } from 'vitest';
import { commandEcho, decodeOutcome, encodeOutcome } from '../src/outcome.js';

describe('command outcomes', () => {
  it('carries the sub-command and the language in a line Markdown shows as nothing', () => {
    const text = encodeOutcome({ command: 'corehub', sub: 'link', language: 'ar' }, '**تم**');
    expect(text.split('\n')[0]).toBe('[//]: # (corehub link ar)');
    expect(decodeOutcome(text)).toEqual({
      meta: { command: 'corehub', sub: 'link', language: 'ar' },
      body: '**تم**',
    });
  });

  it('reads a text without the marker as it is', () => {
    expect(decodeOutcome('plain answer')).toEqual({ meta: null, body: 'plain answer' });
    expect(decodeOutcome(undefined)).toEqual({ meta: null, body: '' });
  });

  it('keeps odd sub-commands to one safe word', () => {
    const text = encodeOutcome({ command: 'corehub', sub: '1 link) x', language: 'en' }, 'b');
    expect(decodeOutcome(text).meta?.sub).toBe('x1linkx');
  });

  it('never echoes a pairing code', () => {
    expect(commandEcho('corehub', 'link', null)).toBe('/corehub link ••••');
    expect(commandEcho('corehub', 'status', null)).toBe('/corehub status');
    expect(commandEcho('corehub', null, null)).toBe('/corehub');
    expect(commandEcho('hermes', 'ask', ' hello ')).toBe('/hermes hello');
  });
});
