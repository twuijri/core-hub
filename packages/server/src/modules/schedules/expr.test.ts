/**
 * The two small things a workflow needs that must not become programming.
 */
import { describe, expect, it } from 'vitest';
import {
  ConditionError,
  evaluate,
  isEmpty,
  parseCondition,
  pathsIn,
  read,
  render,
  type Context,
} from './expr.js';

const ctx: Context = {
  trigger: {
    body: {
      kind: 'invoice',
      amount: 120,
      user: { name: 'سارة' },
      items: [{ sku: 'a-1' }, { sku: 'b-2' }],
      note: '',
      tags: [],
    },
  },
  steps: { classify: { output: 'urgent' } },
};

describe('reading a value', () => {
  it('walks objects and indexes arrays', () => {
    expect(read('trigger.body.user.name', ctx)).toBe('سارة');
    expect(read('trigger.body.items.1.sku', ctx)).toBe('b-2');
    expect(read('steps.classify.output', ctx)).toBe('urgent');
  });

  it('answers undefined for a field the payload did not carry', () => {
    // A hole reads as empty rather than throwing at the eleventh step.
    expect(read('trigger.body.missing', ctx)).toBeUndefined();
    expect(read('trigger.body.user.name.deeper', ctx)).toBeUndefined();
  });

  it('refuses to reach anything that is not data', () => {
    // The payload is written by whoever calls the door; the prototype chain is not a
    // place a caller gets to read from.
    expect(read('trigger.constructor', ctx)).toBeUndefined();
    expect(read('trigger.body.__proto__', ctx)).toBeUndefined();
    expect(read('trigger.body.toString', ctx)).toBeUndefined();
  });

  it('refuses a path that is not a path', () => {
    expect(read('trigger.body["kind"]', ctx)).toBeUndefined();
    expect(read('trigger.body.kind()', ctx)).toBeUndefined();
    expect(read('a'.repeat(4) + '.b'.repeat(20), ctx)).toBeUndefined();
  });
});

describe('rendering a template', () => {
  it('substitutes paths and leaves the rest alone', () => {
    expect(render('العميل {{trigger.body.user.name}} بمبلغ {{trigger.body.amount}}', ctx)).toBe(
      'العميل سارة بمبلغ 120',
    );
  });

  it('puts an object in as JSON, because that is what a model can read back', () => {
    expect(render('{{trigger.body.user}}', ctx)).toBe('{"name":"سارة"}');
  });

  it('makes a missing path empty, not the word undefined', () => {
    expect(render('[{{trigger.body.nope}}]', ctx)).toBe('[]');
  });

  it('lists the paths it would need, so a workflow can be checked before it is saved', () => {
    expect(pathsIn('{{a.b}} and {{ c.d }}')).toEqual(['a.b', 'c.d']);
  });

  it('caps what one substitution can produce', () => {
    const big = { trigger: { blob: 'x'.repeat(100_000) }, steps: {} };
    expect(render('{{trigger.blob}}', big).length).toBe(64 * 1024);
  });
});

describe('parsing a condition', () => {
  it('reads a comparison', () => {
    expect(parseCondition('trigger.body.amount > 100')).toEqual({
      path: 'trigger.body.amount',
      operator: '>',
      value: '100',
    });
  });

  it('reads the longer operator first, so >= is not >', () => {
    expect(parseCondition('trigger.body.amount >= 100').operator).toBe('>=');
  });

  it('unquotes a string on either quote', () => {
    expect(parseCondition('trigger.body.kind == "invoice"').value).toBe('invoice');
    expect(parseCondition("trigger.body.kind == 'invoice'").value).toBe('invoice');
  });

  it('reads the two that take no value', () => {
    expect(parseCondition('trigger.body.note empty')).toEqual({
      path: 'trigger.body.note',
      operator: 'empty',
    });
    expect(parseCondition('trigger.body.user exists').operator).toBe('exists');
  });

  it('refuses what it cannot run, when the workflow is saved and not at 3 a.m.', () => {
    expect(() => parseCondition('')).toThrow(ConditionError);
    expect(() => parseCondition('amount')).toThrow(/operator_missing/);
    expect(() => parseCondition('a.b >')).toThrow(/operator_missing/);
    expect(() => parseCondition('a b == 1')).toThrow(/path_invalid/);
    expect(() => parseCondition('a.b matches "([“"')).toThrow(/regex_invalid/);
  });

  it('is deliberately one comparison: no and, no or, no parentheses', () => {
    // Two conditions are two nodes. A shape you can see beats a line you have to read.
    expect(() => parseCondition('a.b > 1 and c.d < 2')).toThrow(ConditionError);
  });
});

describe('answering the question', () => {
  const ask = (text: string) => evaluate(parseCondition(text), ctx);

  it('compares numbers as numbers', () => {
    expect(ask('trigger.body.amount > 100')).toBe(true);
    expect(ask('trigger.body.amount > 120')).toBe(false);
    expect(ask('trigger.body.amount >= 120')).toBe(true);
  });

  it('does not make "10" > "9" quietly false', () => {
    const numbersAsText: Context = { trigger: { n: '10' }, steps: {} };
    expect(evaluate(parseCondition('trigger.n > 9'), numbersAsText)).toBe(true);
  });

  it('compares text as text', () => {
    expect(ask('trigger.body.kind == "invoice"')).toBe(true);
    expect(ask('trigger.body.kind != "receipt"')).toBe(true);
  });

  it('knows the difference between absent, blank and empty', () => {
    expect(ask('trigger.body.note empty')).toBe(true);
    expect(ask('trigger.body.tags empty')).toBe(true);
    expect(ask('trigger.body.missing empty')).toBe(true);
    expect(ask('trigger.body.missing exists')).toBe(false);
    // Present but blank still exists: the caller sent the field.
    expect(ask('trigger.body.note exists')).toBe(true);
  });

  it('searches inside a value, including one that is a list', () => {
    expect(ask('trigger.body.items contains "b-2"')).toBe(true);
    expect(ask('trigger.body.items contains "z-9"')).toBe(false);
  });

  it('matches a pattern the workflow saved, never one the payload sent', () => {
    expect(ask('trigger.body.kind matches "^inv"')).toBe(true);
  });

  it('treats an empty list as empty and a zero as not', () => {
    expect(isEmpty([])).toBe(true);
    expect(isEmpty({})).toBe(true);
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
  });
});
