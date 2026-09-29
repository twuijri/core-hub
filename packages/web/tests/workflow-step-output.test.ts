import { describe, expect, it } from 'vitest';
import { readableOutput } from '../src/schedules/workflows/StepPanel';

describe('readableOutput', () => {
  it('lays a JSON answer out on lines, read left to right', () => {
    const shown = readableOutput(
      '{"status":"sent","message_id":"921","delivered_to":["telegram:-1003938641118"]}',
    );
    expect(shown.json).toBe(true);
    expect(shown.text).toContain('\n  "status": "sent"');
  });

  it('keeps anything else as written', () => {
    expect(readableOutput('تقرير: {غير JSON')).toEqual({ text: 'تقرير: {غير JSON', json: false });
    expect(readableOutput(null)).toEqual({ text: '', json: false });
  });
});
