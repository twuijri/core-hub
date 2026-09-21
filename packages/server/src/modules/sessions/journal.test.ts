// Resume: what a client gets back after its socket dropped mid-run.
// The safety property under test is "never claim completeness you cannot
// prove" — when in doubt the slice is `truncated` and the client refetches.
import { describe, expect, it } from 'vitest';
import { ResumeJournal, type JournalEntry } from './journal.js';

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0YB';

function entry(seq: number, event = 'message.delta'): JournalEntry {
  return {
    seq,
    envelope: {
      event,
      namespace: '/rt/sessions',
      profile: 'default',
      ts: '2026-09-21T10:15:04Z',
      payload: { delta: `#${seq}` },
    },
  };
}

describe('resume journal', () => {
  it('replays nothing for a fresh subscription', () => {
    const journal = new ResumeJournal();
    journal.append(SESSION, entry(1));
    expect(journal.since(SESSION, 0)).toEqual({ entries: [], truncated: false });
  });

  it("replays exactly the envelopes after the client's last seq, unchanged", () => {
    const journal = new ResumeJournal();
    for (const seq of [4, 5, 6, 7]) journal.append(SESSION, entry(seq));
    const slice = journal.since(SESSION, 5);
    expect(slice.truncated).toBe(false);
    expect(slice.entries.map((e) => e.seq)).toEqual([6, 7]);
    expect(slice.entries[0]?.envelope).toEqual(entry(6).envelope);
  });

  it('reports nothing missed when the client is already up to date', () => {
    const journal = new ResumeJournal();
    journal.append(SESSION, entry(9));
    expect(journal.since(SESSION, 9)).toEqual({ entries: [], truncated: false });
    expect(journal.since(SESSION, 12)).toEqual({ entries: [], truncated: false });
  });

  it('seq is global per profile, so a gap in the numbers is not a gap in this session', () => {
    const journal = new ResumeJournal();
    // Another session used 6, 7, 8 in between.
    for (const seq of [5, 9, 12]) journal.append(SESSION, entry(seq));
    const slice = journal.since(SESSION, 5);
    expect(slice).toMatchObject({ truncated: false });
    expect(slice.entries.map((e) => e.seq)).toEqual([9, 12]);
  });

  it('says truncated when the ring dropped events the client still needed', () => {
    const journal = new ResumeJournal({ entriesPerSession: 3 });
    for (const seq of [1, 2, 3, 4, 5]) journal.append(SESSION, entry(seq));
    const slice = journal.since(SESSION, 1);
    expect(slice.truncated).toBe(true);
    expect(slice.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('does not say truncated when the ring only dropped what the client already had', () => {
    const journal = new ResumeJournal({ entriesPerSession: 3 });
    for (const seq of [1, 2, 3, 4, 5]) journal.append(SESSION, entry(seq));
    expect(journal.since(SESSION, 3)).toMatchObject({ truncated: false });
    expect(journal.since(SESSION, 2)).toMatchObject({ truncated: false });
  });

  it('says truncated for a session it does not remember at all', () => {
    const journal = new ResumeJournal();
    expect(journal.since(SESSION, 42)).toEqual({ entries: [], truncated: true });
  });

  it('evicts the least recently touched session, and says truncated for it afterwards', () => {
    const journal = new ResumeJournal({ sessions: 1 });
    journal.append(SESSION, entry(1));
    journal.append(OTHER, entry(2));
    expect(journal.size).toBe(1);
    expect(journal.since(SESSION, 1)).toEqual({ entries: [], truncated: true });
    expect(journal.since(OTHER, 1)).toMatchObject({ truncated: false });
  });

  it('keeps a session alive while it is being appended to', () => {
    const journal = new ResumeJournal({ sessions: 2 });
    journal.append(SESSION, entry(1));
    journal.append(OTHER, entry(2));
    journal.append(SESSION, entry(3));
    journal.append('01J8QK3ZR2W7M5N4P6T8V9X0YC', entry(4));
    // OTHER was the least recently touched, so it is the one that went.
    expect(journal.since(OTHER, 2)).toEqual({ entries: [], truncated: true });
    expect(journal.since(SESSION, 1).entries.map((e) => e.seq)).toEqual([3]);
  });

  it('forgets a deleted session', () => {
    const journal = new ResumeJournal();
    journal.append(SESSION, entry(1));
    journal.forget(SESSION);
    expect(journal.size).toBe(0);
  });

  it('treats a nonsense cursor as a fresh subscription', () => {
    const journal = new ResumeJournal();
    journal.append(SESSION, entry(1));
    expect(journal.since(SESSION, Number.NaN)).toEqual({ entries: [], truncated: false });
    expect(journal.since(SESSION, -5)).toEqual({ entries: [], truncated: false });
  });
});
