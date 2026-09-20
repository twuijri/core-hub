import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HubError } from '../../src/lib/errors.js';
import { parse, parseRequest } from '../../src/lib/validate.js';
import { pickLanguage, t } from '../../src/i18n/index.js';

describe('validation helper', () => {
  const body = z.object({ name: z.string().min(1), count: z.number().int() });

  it('returns typed data when valid', () => {
    expect(parse(body, { name: 'a', count: 2 })).toEqual({ name: 'a', count: 2 });
  });

  it('throws the validation_failed envelope with every issue', () => {
    try {
      parseRequest(
        { body, params: z.object({ id: z.uuid() }) },
        { body: { name: '', count: 1.5 }, params: { id: 'x' } },
      );
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HubError);
      const hubError = error as HubError;
      expect(hubError.status).toBe(400);
      const envelope = hubError.toEnvelope('en');
      expect(envelope.code).toBe('validation_failed');
      const issues = (envelope.details as { issues: { source: string; path: string }[] }).issues;
      expect(issues.map((i) => `${i.source}.${i.path}`).sort()).toEqual([
        'body.count',
        'body.name',
        'params.id',
      ]);
    }
  });
});

describe('i18n', () => {
  it('translates error codes in both languages and falls back to the key', () => {
    expect(t('errors.not_implemented', 'ar')).toBe('هذه العملية معلنة في العقد ولم تُنفَّذ بعد.');
    expect(t('errors.not_implemented', 'en')).toMatch(/not implemented/);
    expect(t('errors.missing_key', 'ar')).toBe('errors.missing_key');
  });

  it('picks the best language from Accept-Language', () => {
    expect(pickLanguage(undefined)).toBe('en');
    expect(pickLanguage('ar-SA,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(pickLanguage('en-US,ar;q=0.5')).toBe('en');
    expect(pickLanguage('fr')).toBe('en');
  });
});
