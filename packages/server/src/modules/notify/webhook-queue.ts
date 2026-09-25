/**
 * The hub's events, on their way to the webhooks that asked for them (decision §53).
 *
 * **Queued in the database, sent in the background.** An event the hub emits is matched
 * against the webhooks when it happens, and one `webhook_deliveries` row is written per
 * webhook — `queued`, due now. Nothing waits for the network: the person whose chat
 * finished does not wait for somebody's n8n to answer. A timer then sends what is due.
 * Because the queue is the table, a restart loses nothing: what was due is still due.
 *
 * **Retries back off.** A failed attempt is tried again after 30 s, 1 min, 2 min … (doubling,
 * at most an hour apart) until the webhook's `max_retries` are spent; then the delivery is
 * `dead` and stays in the list for a person to redeliver.
 *
 * **Who receives what.** A webhook receives an event when it subscribed to it, when the
 * event's profile is in its `profiles` (empty: every one), and when the person who created
 * it may still enter that profile — a webhook is never a way to read a profile its creator
 * cannot open. Content (what people and agents wrote) is left out unless the webhook says
 * `include_content`; the contract lists those fields per event.
 *
 * **A lease, not a lock.** Before an attempt the row's `next_attempt_at` is pushed past the
 * attempt's deadline, so the timer does not pick it again while it is in flight, and a
 * process that dies mid-attempt leaves a row that becomes due again by itself.
 */
import { createHmac } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { derived } from '@corehub/contracts';
import { newUlid } from '../../db/ids.js';
import type { ModuleDb } from '../../lib/db.js';
import type { TappedEvent } from '../../lib/realtime.js';
import { canEnter, findUser, findWorkspace } from '../auth/index.js';
import { webhookCatalogue, withoutContent } from './webhook-catalogue.js';
import { sendWebhook, type SendOutcome } from './webhook-send.js';
import { webhookDeliveries, webhooks } from './schema.js';

type DeliveryRow = typeof webhookDeliveries.$inferSelect;
type WebhookRow = typeof webhooks.$inferSelect;

export interface QueueOptions {
  /** The first retry's delay; each later one doubles it. */
  retryBaseMs: number;
  /** No two attempts further apart than this. */
  retryCapMs: number;
  /** One attempt's deadline. */
  timeoutMs: number;
  resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  retryBaseMs: 30_000,
  retryCapMs: 60 * 60_000,
  timeoutMs: 10_000,
};

/** How long after retry `n` (1-based) the next attempt is due. */
export function retryDelayMs(n: number, options: Pick<QueueOptions, 'retryBaseMs' | 'retryCapMs'>) {
  return Math.min(options.retryBaseMs * 2 ** Math.max(0, n - 1), options.retryCapMs);
}

/** How many due deliveries one tick sends at once. */
const BATCH = 10;
/** A timer longer than this overflows (Node clamps it to 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface AttemptResult extends SendOutcome {
  delivered: boolean;
}

export class WebhookQueue {
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private stopped = false;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: ModuleDb,
    private readonly options: () => QueueOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------ in

  /** An event left the hub: queue one delivery for every webhook that should receive it. */
  dispatch(tapped: TappedEvent): number {
    if (this.stopped) return 0;
    const entry = webhookCatalogue().get(tapped.event);
    // Only the namespace the contract names: the same name on another namespace is another
    // event, and a webhook must not receive one event twice.
    if (!entry || entry.namespace !== tapped.namespace) return 0;
    const slug = tapped.profile ?? profileInPayload(tapped.payload);
    if (!slug) return 0;
    const workspace = findWorkspace(this.db, slug);
    if (!workspace) return 0;
    const candidates = this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.enabled, true), isNull(webhooks.archivedAt)))
      .all()
      .filter((hook) => hook.events.includes(tapped.event));
    let queued = 0;
    const now = this.now();
    for (const hook of candidates) {
      if (hook.profiles.length > 0 && !hook.profiles.includes(workspace.slug)) continue;
      const owner = findUser(this.db, hook.ownerId);
      if (!owner || owner.status !== 'active' || !canEnter(this.db, owner, workspace.id)) continue;
      const id = newUlid();
      const payload = {
        id,
        event: tapped.event,
        profile: workspace.slug,
        occurred_at: tapped.ts,
        content_included: hook.includeContent,
        data: hook.includeContent
          ? withoutContent(tapped.payload, [])
          : withoutContent(tapped.payload, entry.content),
      };
      this.db
        .insert(webhookDeliveries)
        .values({
          id,
          ownerId: hook.ownerId,
          // The webhook's own profile, so the delivery is listed with the webhook.
          workspace: hook.workspace,
          webhookId: hook.id,
          eventName: tapped.event,
          payload,
          status: 'queued',
          attempts: 0,
          nextAttemptAt: now,
        })
        .run();
      queued += 1;
    }
    if (queued > 0) this.schedule();
    return queued;
  }

  /** The same body again, under a new delivery id, due now. */
  redeliver(source: DeliveryRow): DeliveryRow {
    const id = newUlid();
    this.db
      .insert(webhookDeliveries)
      .values({
        id,
        ownerId: source.ownerId,
        workspace: source.workspace,
        webhookId: source.webhookId,
        eventName: source.eventName,
        payload: source.payload,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: this.now(),
      })
      .run();
    this.schedule();
    return this.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get()!;
  }

  // ------------------------------------------------------------------ out

  /**
   * One attempt at one delivery. `test` is the delivery a person asked for with "Send test":
   * one try, sent even to a webhook that is switched off, and a failure is final rather
   * than scheduled again.
   */
  async attempt(id: string, mode: 'queue' | 'test' = 'queue'): Promise<AttemptResult | null> {
    const retry = mode === 'queue';
    if (this.inFlight.has(id)) return null;
    this.inFlight.add(id);
    try {
      const row = this.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id))
        .get();
      if (!row || (row.status !== 'queued' && row.status !== 'failed')) return null;
      const options = this.options();
      const hook = this.db.select().from(webhooks).where(eq(webhooks.id, row.webhookId)).get();
      if (!hook || hook.archivedAt || (retry && !hook.enabled)) {
        const error = 'the webhook is switched off';
        this.finish(row, hook ?? null, { status: null, error }, false);
        return { delivered: false, status: null, error };
      }
      // The lease: past the deadline, so the timer leaves it alone while it is sent.
      this.db
        .update(webhookDeliveries)
        .set({
          nextAttemptAt: new Date(this.now().getTime() + options.timeoutMs + 5_000),
          updatedAt: this.now(),
        })
        .where(eq(webhookDeliveries.id, id))
        .run();
      const body = JSON.stringify(row.payload);
      const outcome = await sendWebhook(hook.url, headersFor(hook, row, body), body, {
        allowPrivate: hook.allowPrivateNetwork,
        timeoutMs: options.timeoutMs,
        resolveHost: options.resolveHost,
        fetchImpl: options.fetchImpl,
      });
      this.finish(row, hook, outcome, retry);
      return { ...outcome, delivered: outcome.error === null };
    } finally {
      this.inFlight.delete(id);
      this.schedule();
    }
  }

  private finish(
    row: DeliveryRow,
    hook: WebhookRow | null,
    outcome: SendOutcome,
    retry: boolean,
  ): void {
    const now = this.now();
    const attempts = row.attempts + 1;
    if (outcome.error === null) {
      this.db
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          attempts,
          responseStatus: outcome.status,
          lastError: null,
          deliveredAt: now,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, row.id))
        .run();
      if (hook) {
        this.db
          .update(webhooks)
          .set({
            deliveredCount: sql`${webhooks.deliveredCount} + 1`,
            lastError: null,
            lastStatus: outcome.status,
            lastDeliveredAt: now,
            updatedAt: now,
          })
          .where(eq(webhooks.id, hook.id))
          .run();
      }
      return;
    }
    // `attempts - 1` retries have been used; one more is allowed while that is under the cap.
    const again = retry && hook !== null && hook.enabled && attempts - 1 < hook.maxRetries;
    const status = again ? 'failed' : retry && hook !== null && hook.enabled ? 'dead' : 'failed';
    this.db
      .update(webhookDeliveries)
      .set({
        status,
        attempts,
        responseStatus: outcome.status,
        lastError: outcome.error,
        nextAttemptAt: again
          ? new Date(now.getTime() + retryDelayMs(attempts, this.options()))
          : null,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, row.id))
      .run();
    if (hook) {
      this.db
        .update(webhooks)
        .set({
          // A delivery counts as failed once, when it is over — not once per attempt.
          ...(again ? {} : { failureCount: sql`${webhooks.failureCount} + 1` }),
          lastError: outcome.error,
          lastStatus: outcome.status,
          updatedAt: now,
        })
        .where(eq(webhooks.id, hook.id))
        .run();
    }
  }

  // ------------------------------------------------------------------ timer

  /** Set the one timer for the earliest delivery due. */
  schedule(): void {
    if (this.stopped) return;
    const next = this.db
      .select({ at: webhookDeliveries.nextAttemptAt })
      .from(webhookDeliveries)
      .where(
        and(
          inArray(webhookDeliveries.status, ['queued', 'failed']),
          isNotNull(webhookDeliveries.nextAttemptAt),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(1)
      .get();
    if (!next?.at) return;
    const at = next.at.getTime();
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        this.tick();
      },
      Math.min(Math.max(0, at - this.now().getTime()), MAX_TIMER_MS),
    );
    this.timer.unref?.();
  }

  /** Send what is due now. */
  tick(): void {
    if (this.stopped) return;
    const due = this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          inArray(webhookDeliveries.status, ['queued', 'failed']),
          lte(webhookDeliveries.nextAttemptAt, this.now()),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(BATCH)
      .all();
    for (const { id } of due) void this.attempt(id).catch(() => undefined);
    if (due.length === 0) this.schedule();
  }

  /** Nothing is sent after this; queued rows wait for the next start. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Deliveries being sent right now (tests wait for zero). */
  get sending(): number {
    return this.inFlight.size;
  }
}

/** A user-level event names its profile inside the payload (`notice.created`). */
function profileInPayload(payload: unknown): string | null {
  const notice = (payload as { notice?: { profile?: unknown } } | null)?.notice;
  return typeof notice?.profile === 'string' ? notice.profile : null;
}

function headersFor(hook: WebhookRow, row: DeliveryRow, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...hook.headers,
    'content-type': 'application/json',
    'user-agent': `${derived.serviceName}-webhooks`,
    [derived.webhookEventHeader]: row.eventName,
    [derived.webhookDeliveryHeader]: row.id,
  };
  if (hook.signingSecret) {
    // The receiver verifies this rather than trusting the body: that is the whole reason
    // a signing secret exists.
    headers[derived.webhookSignatureHeader] =
      `sha256=${createHmac('sha256', hook.signingSecret).update(body).digest('hex')}`;
  }
  return headers;
}
