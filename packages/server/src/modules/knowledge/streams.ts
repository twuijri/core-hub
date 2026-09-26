/**
 * Media stream tickets (DECISIONS §88): a `<video>` or `<audio>` element sends no header, so it
 * cannot carry the bearer `sessions.downloadAttachment` wants, and a whole video fetched first
 * into a blob plays only once it has all arrived. A ticket is a random path segment that names
 * one attachment, read-only, for one hour; the element asks for byte ranges with it as it plays.
 *
 * It is not the bearer token: it names one attachment and grants nothing else. It lives in
 * memory (a restart forgets every ticket; the page asks for a new one), and it stops working
 * the moment the person who asked may no longer read the attachment (checked on every read).
 */
import { randomBytes } from 'node:crypto';

export const STREAM_TTL_MS = 60 * 60 * 1000;
/** A hub never needs more; the oldest go first. */
const MAX_TICKETS = 5_000;

export interface StreamTicket {
  attachmentId: string;
  workspace: string;
  profile: string;
  userId: string;
  expiresAt: number;
}

export class StreamTickets {
  private readonly tickets = new Map<string, StreamTicket>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: Omit<StreamTicket, 'expiresAt'>): { ticket: string; expiresAt: number } {
    this.sweep();
    const ticket = randomBytes(32).toString('hex');
    const expiresAt = this.now() + STREAM_TTL_MS;
    this.tickets.set(ticket, { ...input, expiresAt });
    while (this.tickets.size > MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    return { ticket, expiresAt };
  }

  /** The ticket, while it is good; null when unknown or expired. */
  read(ticket: string): StreamTicket | null {
    if (!/^[0-9a-f]{64}$/.test(ticket)) return null;
    const found = this.tickets.get(ticket);
    if (!found) return null;
    if (found.expiresAt <= this.now()) {
      this.tickets.delete(ticket);
      return null;
    }
    return found;
  }

  private sweep(): void {
    const at = this.now();
    for (const [key, value] of this.tickets) if (value.expiresAt <= at) this.tickets.delete(key);
  }
}
