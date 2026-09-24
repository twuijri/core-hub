// The Memory page's refusal when a list would outgrow Hermes's budget says the numbers, in
// the person's language, instead of the hub's generic "invalid request".
import { HubApiError } from '@corehub/contracts';
import { describe, expect, it } from 'vitest';
import { describeToolError } from '../src/agents/toolErrors.js';
import { createTranslator } from '../src/i18n/index.js';

const tooLong = new HubApiError(400, 'bad_request', 'The request is invalid.', {
  code: 'bad_request',
  details: { reason: 'memory_too_long', limit: 1375, length: 1502 },
});

describe('a memory list over its budget', () => {
  it('says how long it is and what the limit is, in English and Arabic', () => {
    const en = describeToolError(tooLong, createTranslator('en'));
    expect(en).toContain('1502');
    expect(en).toContain('1375');
    expect(en).not.toBe('The request is invalid.');
    const ar = describeToolError(tooLong, createTranslator('ar'));
    expect(ar).toContain('1502');
    expect(ar).toContain('1375');
    expect(ar).toContain('الحد');
  });
});
