/**
 * Resume: what a client gets back when its socket drops mid-run.
 *
 * Streaming deltas are never persisted (docs/domain/README.md §What is
 * deliberately not stored) — but a phone that loses signal for ten seconds
 * must not lose ten seconds of the answer. So every event emitted into a
 * session's room is kept in a bounded in-memory journal, keyed by the same
 * `seq` the envelope carries. A client re-subscribes with
 * `{ session_id, after_seq }` and the server replays exactly what it missed,
 * byte-for-byte the same envelopes, in the same order.
 *
 * The journal is a cache, not a ledger:
 *
 * - it holds the last `entriesPerSession` events of the last `sessions`
 *   sessions, whichever were touched most recently;
 * - it is lost on restart;
 * - whenever it cannot *prove* the replay is complete it says
 *   `truncated: true`, and the client falls back to the contract's
 *   resynchronisation (`GET /sessions/{id}` + `GET …/messages`), which is
 *   what `packages/contracts/events/README.md` §Reconnection already
 *   prescribes.
 *
 * Saying "truncated" when unsure is the whole safety property: a client is
 * never told it is up to date when it might not be.
 */

export interface JournalEntry {
  seq: number;
  /** The complete Socket.IO argument, ready to re-emit unchanged. */
  envelope: { event: string; namespace: string; profile: string; ts: string; payload: unknown };
}

export interface ReplaySlice {
  entries: JournalEntry[];
  /** True when events between `after_seq` and the first replayed one may be missing. */
  truncated: boolean;
}

export interface JournalOptions {
  /** Events kept per session (default 2000 ≈ a long streamed answer). */
  entriesPerSession?: number;
  /** Sessions kept at once, least-recently-touched evicted first (default 200). */
  sessions?: number;
}

interface SessionLog {
  entries: JournalEntry[];
  /** Smallest `seq` still held; entries below it were dropped by the ring. */
  firstRetainedSeq: number;
  lastSeq: number;
}

export class ResumeJournal {
  private readonly entriesPerSession: number;
  private readonly maxSessions: number;
  /** Map iteration order is insertion order, so re-inserting marks "recent". */
  private readonly logs = new Map<string, SessionLog>();

  constructor(options: JournalOptions = {}) {
    this.entriesPerSession = Math.max(1, options.entriesPerSession ?? 2000);
    this.maxSessions = Math.max(1, options.sessions ?? 200);
  }

  append(sessionId: string, entry: JournalEntry): void {
    let log = this.logs.get(sessionId);
    if (log) {
      this.logs.delete(sessionId);
    } else {
      log = { entries: [], firstRetainedSeq: entry.seq, lastSeq: entry.seq };
    }
    log.entries.push(entry);
    log.lastSeq = entry.seq;
    if (log.entries.length > this.entriesPerSession) {
      log.entries.splice(0, log.entries.length - this.entriesPerSession);
      log.firstRetainedSeq = log.entries[0]?.seq ?? entry.seq;
    }
    this.logs.set(sessionId, log);
    while (this.logs.size > this.maxSessions) {
      const oldest = this.logs.keys().next();
      if (oldest.done) break;
      this.logs.delete(oldest.value);
    }
  }

  /**
   * Everything emitted for `sessionId` after `afterSeq`.
   *
   * `afterSeq <= 0` is a fresh subscription: nothing to replay, nothing
   * missed. Otherwise the client is claiming "I have seen up to `afterSeq`":
   * the slice is complete only when the journal still holds the event right
   * after it.
   */
  since(sessionId: string, afterSeq: number): ReplaySlice {
    if (!Number.isFinite(afterSeq) || afterSeq <= 0) return { entries: [], truncated: false };
    const log = this.logs.get(sessionId);
    // Nothing remembered: either nothing happened, or it was evicted. Cannot tell.
    if (!log || log.entries.length === 0) return { entries: [], truncated: true };
    // The client is at or ahead of us — it missed nothing.
    if (afterSeq >= log.lastSeq) return { entries: [], truncated: false };
    const entries = log.entries.filter((entry) => entry.seq > afterSeq);
    // A gap exists when the oldest retained event is newer than the next one expected.
    const truncated = log.firstRetainedSeq > afterSeq + 1;
    return { entries, truncated };
  }

  /** Drop a session's log (the session was deleted). */
  forget(sessionId: string): void {
    this.logs.delete(sessionId);
  }

  clear(): void {
    this.logs.clear();
  }

  get size(): number {
    return this.logs.size;
  }
}
