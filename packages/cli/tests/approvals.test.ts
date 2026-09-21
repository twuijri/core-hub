import { describe, expect, it } from 'vitest';
import { DECISION_OF, parseAnswer, parseDecision } from '../src/chat/approvals.js';

describe('parseDecision', () => {
  it('maps numbers and words to decisions, and refuses always unless allowed', () => {
    expect(parseDecision('1', false)).toBe('once');
    expect(parseDecision(' 2 ', false)).toBe('session');
    expect(parseDecision('3', true)).toBe('always');
    expect(parseDecision('3', false)).toBeUndefined();
    expect(parseDecision('ALWAYS', false)).toBeUndefined();
    expect(parseDecision('4', false)).toBe('deny');
    expect(parseDecision('deny', false)).toBe('deny');
    expect(parseDecision('maybe', true)).toBeUndefined();
    expect(parseDecision('', true)).toBeUndefined();
    expect(DECISION_OF[parseDecision('1', false)!]).toBe('approve_once');
  });
});

describe('parseAnswer', () => {
  const choices = [{ value: 'main' }, { value: 'test' }];
  it('resolves a choice number, keeps free text, and treats empty as no answer', () => {
    expect(parseAnswer('2', choices)).toBe('test');
    expect(parseAnswer('9', choices)).toBe('9');
    expect(parseAnswer(' main ', choices)).toBe('main');
    expect(parseAnswer('1', [])).toBe('1');
    expect(parseAnswer('   ', choices)).toBeNull();
  });
});
