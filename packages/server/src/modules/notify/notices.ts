/**
 * Putting something in a person's inbox.
 *
 * `record()` next door writes a row. This file is the decision around it: whether the
 * person asked to be told at all, what the sentence says in their language, and telling
 * their open clients about it. Other modules call `deliver()` and nothing else — they
 * name the event that happened, never the wording.
 *
 * **The wording lives here, in both languages, at the moment the notice is written.** A
 * notice is a record of a past moment, so it keeps the words it was written with even if
 * the person changes language afterwards; that is why the column is a string and not a
 * key. The recipient's own locale decides, never the locale of whoever caused it.
 *
 * **Quiet hours silence push, not the inbox.** A notice written at 3 a.m. is still in the
 * inbox at 8 — hiding it would lose it. Push is not built yet (`devices` is still 501),
 * so `quietNow()` is used by nothing today and is tested on its own, rather than being
 * wired to a channel that does not exist.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import type { ModuleDb } from '../../lib/db.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { emitToUser, findUser } from '../auth/index.js';
import { notifications, notificationPreferences } from './schema.js';

export type Locale = 'ar' | 'en';

/** The events a module can announce. One per sentence below — nothing else is accepted. */
export type NoticeEvent =
  | { kind: 'run_completed'; agent: string; session: string }
  | { kind: 'run_failed'; agent: string; session: string; reason: string | null }
  | { kind: 'approval_requested'; agent: string; session: string; what: string };

interface Sentence {
  title: string;
  body: string | null;
}

/**
 * Both languages, side by side, so a missing one is visible here rather than at 3 a.m.
 * The Arabic is the primary text of this hub, not a translation of the English.
 */
export function sentenceFor(event: NoticeEvent, locale: Locale): Sentence {
  const ar = locale === 'ar';
  switch (event.kind) {
    case 'run_completed':
      return {
        title: ar ? `أنهى ${event.agent} الرد` : `${event.agent} finished`,
        // A session that has not named itself yet has no subtitle worth a blank line.
        body: event.session || null,
      };
    case 'run_failed':
      return {
        title: ar ? `تعثّر ${event.agent}` : `${event.agent} failed`,
        body: event.reason ?? event.session ?? null,
      };
    case 'approval_requested':
      return {
        title: ar ? `${event.agent} ينتظر إذنك` : `${event.agent} is waiting for you`,
        body: event.what,
      };
  }
}

/** `approval_requested` is the one kind that is not merely news: it blocks a run. */
const SEVERITY: Record<NoticeEvent['kind'], 'info' | 'warning' | 'action_required'> = {
  run_completed: 'info',
  run_failed: 'warning',
  approval_requested: 'action_required',
};

/**
 * The table's thirteen kinds narrow to the contract's seven, and a person's preference is
 * expressed in the contract's words — so the switch they flipped for "an agent finished"
 * must also silence a run that failed. Mapping in this direction, once, is what makes the
 * switch mean what its label says.
 */
const CONTRACT_KIND: Record<NoticeEvent['kind'], string> = {
  run_completed: 'run_completed',
  run_failed: 'run_completed',
  approval_requested: 'approval_requested',
};

export interface Recipient {
  userId: string;
  workspace: string;
  profile: string;
  /**
   * Omitted on purpose by every caller. A notice is read later, by the person it is
   * about — not by whoever's request happened to start the run, and not by a schedule
   * that started it with nobody's language at all. So the locale is looked up from the
   * recipient's own account, and this field exists only for a test that pins one.
   */
  locale?: Locale;
}

/** The recipient's own language, `ar` when the account says nothing else. */
export function localeOf(db: ModuleDb, userId: string): Locale {
  return findUser(db, userId)?.locale === 'en' ? 'en' : 'ar';
}

/** False when this person turned this kind off. A kind with no row was never turned off. */
export function wantsInApp(db: ModuleDb, recipient: Recipient, contractKind: string): boolean {
  const row = db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspace, recipient.workspace),
        eq(notificationPreferences.ownerId, recipient.userId),
        eq(notificationPreferences.kind, contractKind),
      ),
    )
    .get();
  return row ? row.inApp : true;
}

/** Takes only what it needs, so a caller with a request scope need not invent a locale. */
export function unreadCount(
  db: ModuleDb,
  recipient: { workspace: string; userId: string },
): number {
  return db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspace, recipient.workspace),
        eq(notifications.ownerId, recipient.userId),
        isNull(notifications.readAt),
      ),
    )
    .all().length;
}

/**
 * Is `at` inside the person's quiet hours? Written as minutes since midnight in the
 * person's own timezone, so a window that crosses midnight (22:00 → 07:00) is the
 * complement of the ordinary case rather than a special one.
 */
export function quietNow(
  window: { enabled: boolean; from: string; to: string; timezone: string },
  at: Date,
): boolean {
  if (!window.enabled) return false;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: window.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  const minutes = (value: string): number => {
    const [h = '0', m = '0'] = value.split(':');
    return Number(h) * 60 + Number(m);
  };
  const now = minutes(local);
  const from = minutes(window.from);
  const to = minutes(window.to);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export interface DeliverDeps {
  db: ModuleDb;
  io: SocketServer | null;
  /** Injected so a test does not depend on the clock. */
  now?: () => Date;
  /** `record` from the module's index; passed in to keep this file free of its imports. */
  record: (
    db: ModuleDb,
    input: {
      workspace: string;
      userId: string;
      kind: string;
      title: string;
      body?: string | null;
      severity?: 'info' | 'warning' | 'error' | 'action_required';
      entityKind?: string | null;
      entityId?: string | null;
      data?: Record<string, unknown>;
    },
  ) => string;
}

/**
 * Write the notice and tell the person's open clients. Returns the id, or `null` when the
 * person asked not to be told — a silence the caller does not have to think about.
 */
export function deliver(
  deps: DeliverDeps,
  recipient: Recipient,
  event: NoticeEvent,
  resource: { kind: string; id: string } | null,
): string | null {
  const contractKind = CONTRACT_KIND[event.kind];
  if (!wantsInApp(deps.db, recipient, contractKind)) return null;
  const sentence = sentenceFor(event, recipient.locale ?? localeOf(deps.db, recipient.userId));
  const id = deps.record(deps.db, {
    workspace: recipient.workspace,
    userId: recipient.userId,
    kind: event.kind,
    title: sentence.title,
    body: sentence.body,
    severity: SEVERITY[event.kind],
    entityKind: resource?.kind ?? null,
    entityId: resource?.id ?? null,
    data: resource ? { route: resource.kind, id: resource.id } : {},
  });
  const row = deps.db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row) return id;
  emitToUser(
    deps.io,
    recipient.userId,
    REALTIME_NAMESPACES.devices,
    'notice.created',
    {
      notice: {
        id: row.id,
        user_id: row.ownerId,
        profile: recipient.profile,
        kind: contractKind,
        title: row.title,
        body: row.body,
        resource: resource,
        read_at: null,
        created_at: row.createdAt.toISOString(),
      },
      unread_count: unreadCount(deps.db, recipient),
    },
    (deps.now?.() ?? new Date()).getTime(),
  );
  return id;
}
