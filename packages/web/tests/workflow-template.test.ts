/**
 * The variables of a "Send message" step's words, read with the hub's own pattern
 * (`expr.ts` `pathsIn`), and the preview of the words with the values put in (§124).
 */
import { describe, expect, it } from 'vitest';
import {
  fillTemplate,
  filledValues,
  missingIn,
  variablesIn,
} from '../src/schedules/workflows/template.js';

describe('the variables of a message', () => {
  const text =
    'تحليل {{steps.analysis.output}} لـ {{ trigger.body.task.name }} و{{input}} {{steps.analysis.output}} {{not a path}}';

  it('are named once each, in order, as the hub names them', () => {
    expect(variablesIn(text)).toEqual(['steps.analysis.output', 'trigger.body.task.name', 'input']);
    expect(variablesIn('no variables')).toEqual([]);
  });

  it('are missing until each has a value; the preview keeps a hole as written', () => {
    const values = { 'steps.analysis.output': 'تم', input: '' };
    expect(missingIn(text, values)).toEqual(['trigger.body.task.name', 'input']);
    expect(fillTemplate(text, values)).toBe(
      'تحليل تم لـ {{ trigger.body.task.name }} و{{input}} تم {{not a path}}',
    );
    expect(filledValues(text, { ...values, stale: 'x' })).toEqual({
      'steps.analysis.output': 'تم',
    });
  });
});
