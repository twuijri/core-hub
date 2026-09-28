/**
 * The sample a template is tried with (§124): typed values are put at their paths in a copy of
 * the run's context, never outside the three roots and never onto a prototype.
 */
import { describe, expect, it } from 'vitest';
import { render, unresolvedIn, type Context } from './expr.js';
import { setPath, valuesIn, withValues } from './sample.js';

const run: Context = {
  trigger: { body: { task: { name: 'مهمة' }, items: ['a'] } },
  input: 'تم',
  steps: { analysis: { output: 'تحليل' } },
};

describe('a sample', () => {
  it('puts typed values over the run, in a copy', () => {
    const ctx = withValues(run, {
      'steps.analysis.output': 'عينة',
      'trigger.body.task.id': '86a',
      'steps.new.output': 'جديد',
      input: 'يدوي',
    });
    expect(
      render('{{steps.analysis.output}} {{trigger.body.task.name}} {{trigger.body.task.id}}', ctx),
    ).toBe('عينة مهمة 86a');
    expect(render('{{steps.new.output}} {{input}}', ctx)).toBe('جديد يدوي');
    // The run it came from is untouched.
    expect(run.steps.analysis!.output).toBe('تحليل');
    expect(
      (run.trigger as { body: { task: Record<string, unknown> } }).body.task.id,
    ).toBeUndefined();
  });

  it('writes only under input, trigger and steps, and never reaches a prototype', () => {
    const ctx: Context = { trigger: undefined, steps: {}, input: undefined };
    expect(setPath(ctx, 'other.x', 'v')).toBe(false);
    expect(setPath(ctx, 'trigger.__proto__.polluted', 'v')).toBe(false);
    expect(setPath(ctx, 'steps.constructor.prototype', 'v')).toBe(false);
    expect(setPath(ctx, 'trigger', 'v')).toBe(false);
    expect(setPath(ctx, 'bad path', 'v')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(setPath(ctx, 'trigger.body.items.0', 'z')).toBe(true);
    expect(render('{{trigger.body.items.0}}', ctx)).toBe('z');
  });

  it('says what each variable reads as, leaving out the ones with nothing', () => {
    const empty: Context = { trigger: undefined, steps: {}, input: undefined };
    expect(unresolvedIn('{{input}} {{steps.a.output}}', empty)).toEqual([
      'input',
      'steps.a.output',
    ]);
    expect(valuesIn(['input', 'trigger.body.task', 'steps.missing.output', 'input'], run)).toEqual({
      input: 'تم',
      'trigger.body.task': '{"name":"مهمة"}',
    });
  });
});
