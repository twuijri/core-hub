// When a message was said (tester feedback, 2026-10-05): the clock time today, «Yesterday» and
// the time yesterday, the short date and the time before that, with Latin digits in every
// language. The same rule as the phones (MessageTime on iOS and Android).
import { describe, expect, it } from 'vitest';
import { messageTime } from '../src/chat/MessageActions.js';
import { createTranslator } from '../src/i18n/index.js';

const ARABIC_INDIC = /[٠-٩۰-۹]/;
// Local wall-clock dates, so the test reads the same in any time zone.
const now = new Date(2026, 9, 5, 18, 30);
const at = (date: Date) => ({ created_at: date.toISOString() });
const en = createTranslator('en');
const ar = createTranslator('ar');

describe('messageTime', () => {
  it('shows only the clock time for a message from today', () => {
    const text = messageTime(at(new Date(2026, 9, 5, 0, 5)), 'en', en, now);
    expect(text).toMatch(/12:05/);
    expect(text).not.toMatch(/Oct|Yesterday|2026/);
  });

  it('says «Yesterday» and the time for a message from the day before', () => {
    const text = messageTime(at(new Date(2026, 9, 4, 23, 50)), 'en', en, now);
    expect(text).toMatch(/^Yesterday 11:50/);
    expect(messageTime(at(new Date(2026, 9, 4, 9, 7)), 'ar', ar, now)).toMatch(/^أمس 09:07/);
  });

  it('shows the short date and the time before yesterday, the year only when it differs', () => {
    const thisYear = messageTime(at(new Date(2026, 9, 3, 14, 5)), 'en', en, now);
    expect(thisYear).toMatch(/Oct/);
    expect(thisYear).toMatch(/3/);
    expect(thisYear).toMatch(/02:05|14:05/);
    expect(thisYear).not.toMatch(/2026|Yesterday/);
    const lastYear = messageTime(at(new Date(2025, 11, 31, 8, 0)), 'en', en, now);
    expect(lastYear).toMatch(/Dec/);
    expect(lastYear).toMatch(/2025/);
  });

  it('keeps Arabic words but Latin digits in Arabic', () => {
    for (const date of [
      new Date(2026, 9, 5, 9, 7),
      new Date(2026, 9, 4, 9, 7),
      new Date(2025, 0, 2, 9, 7),
    ]) {
      const text = messageTime(at(date), 'ar', ar, now);
      expect(text).not.toMatch(ARABIC_INDIC);
      expect(text).toMatch(/09:07/);
    }
    expect(messageTime(at(new Date(2025, 0, 2, 9, 7)), 'ar', ar, now)).toMatch(/يناير/);
  });

  it('is empty for a time it cannot read', () => {
    expect(messageTime({ created_at: 'not a date' }, 'en', en, now)).toBe('');
  });
});
