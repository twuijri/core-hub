/**
 * The decision around `record()`: the wording, the silence, and the window.
 */
import { describe, expect, it } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import type { ModuleDb } from '../../lib/db.js';
import { record } from './index.js';
import { deliver, quietNow, sentenceFor, unreadCount, wantsInApp } from './notices.js';
import { notificationPreferences } from './schema.js';
import { newUlid } from '../../db/ids.js';

const recipient = {
  userId: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  workspace: 'default',
  profile: 'default',
  locale: 'ar' as const,
};

function db(): ModuleDb {
  return memoryDb() as unknown as ModuleDb;
}

function turnOff(database: ModuleDb, kind: string): void {
  database
    .insert(notificationPreferences)
    .values({
      id: newUlid(),
      ownerId: recipient.userId,
      workspace: recipient.workspace,
      kind,
      inApp: false,
      push: false,
    })
    .run();
}

describe('notices: the wording', () => {
  it('names the agent in the recipient’s own language, not the hub’s', () => {
    const event = { kind: 'run_completed', agent: 'Hermes', session: 'خطة الإطلاق' } as const;
    expect(sentenceFor(event, 'ar').title).toContain('Hermes');
    expect(sentenceFor(event, 'ar').title).toMatch(/[؀-ۿ]/);
    expect(sentenceFor(event, 'en').title).toBe('Hermes finished');
    // The body carries what it is about, so the inbox row is readable without opening it.
    expect(sentenceFor(event, 'en').body).toBe('خطة الإطلاق');
  });

  it('says why a run failed when there is a reason, and what it was about when there is not', () => {
    const withReason = {
      kind: 'run_failed',
      agent: 'Hermes',
      session: 'س',
      reason: 'no provider key',
    } as const;
    expect(sentenceFor(withReason, 'en').body).toBe('no provider key');
    expect(sentenceFor({ ...withReason, reason: null }, 'en').body).toBe('س');
  });
});

describe('notices: who is told', () => {
  it('writes the notice and counts it unread', () => {
    const database = db();
    const id = deliver(
      { db: database, io: null, record },
      recipient,
      {
        kind: 'run_completed',
        agent: 'Hermes',
        session: 'خطة',
      },
      { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0YA' },
    );
    expect(id).not.toBeNull();
    expect(unreadCount(database, recipient)).toBe(1);
  });

  it('stays silent when the person turned that kind off, and writes nothing at all', () => {
    const database = db();
    turnOff(database, 'run_completed');
    const id = deliver(
      { db: database, io: null, record },
      recipient,
      {
        kind: 'run_completed',
        agent: 'Hermes',
        session: 'خطة',
      },
      null,
    );
    expect(id).toBeNull();
    // Silence means not recorded, not recorded-and-hidden: the inbox is a list of what
    // the person agreed to be told.
    expect(unreadCount(database, recipient)).toBe(0);
  });

  it('silences a failed run with the switch labelled for a finished one', () => {
    // The table has thirteen kinds and the contract seven; the switch the person flipped
    // says "an agent finished", so it must cover the run that did not.
    const database = db();
    turnOff(database, 'run_completed');
    const id = deliver(
      { db: database, io: null, record },
      recipient,
      {
        kind: 'run_failed',
        agent: 'Hermes',
        session: 'خطة',
        reason: null,
      },
      null,
    );
    expect(id).toBeNull();
  });

  it('does not silence approvals when finished runs were silenced', () => {
    const database = db();
    turnOff(database, 'run_completed');
    expect(wantsInApp(database, recipient, 'approval_requested')).toBe(true);
    const id = deliver(
      { db: database, io: null, record },
      recipient,
      {
        kind: 'approval_requested',
        agent: 'Hermes',
        session: '',
        what: 'رفع ملف',
      },
      null,
    );
    expect(id).not.toBeNull();
  });

  it('a kind nobody ever touched is on', () => {
    expect(wantsInApp(db(), recipient, 'run_completed')).toBe(true);
  });
});

describe('notices: quiet hours', () => {
  const window = { enabled: true, from: '22:00', to: '07:00', timezone: 'Asia/Riyadh' };

  it('covers a window that crosses midnight, on both sides of it', () => {
    // 23:30 and 02:00 Riyadh (UTC+3) are 20:30 and 23:00 UTC the day before.
    expect(quietNow(window, new Date('2026-09-22T20:30:00Z'))).toBe(true);
    expect(quietNow(window, new Date('2026-09-21T23:00:00Z'))).toBe(true);
  });

  it('is over at the hour it says, in the person’s zone and not the server’s', () => {
    // 07:00 Riyadh is 04:00 UTC — quiet ends; the same instant is 04:00 in London, noisy
    // there too, which is the point of storing a zone.
    expect(quietNow(window, new Date('2026-09-22T04:00:00Z'))).toBe(false);
    expect(quietNow(window, new Date('2026-09-22T10:00:00Z'))).toBe(false);
  });

  it('is never on when switched off, and an empty window is not a whole day', () => {
    expect(quietNow({ ...window, enabled: false }, new Date('2026-09-22T20:30:00Z'))).toBe(false);
    expect(
      quietNow({ ...window, from: '08:00', to: '08:00' }, new Date('2026-09-22T05:00:00Z')),
    ).toBe(false);
  });

  it('covers an ordinary daytime window without wrapping', () => {
    const day = { enabled: true, from: '09:00', to: '17:00', timezone: 'UTC' };
    expect(quietNow(day, new Date('2026-09-22T12:00:00Z'))).toBe(true);
    expect(quietNow(day, new Date('2026-09-22T18:00:00Z'))).toBe(false);
    expect(quietNow(day, new Date('2026-09-22T08:59:00Z'))).toBe(false);
  });
});
