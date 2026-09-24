/**
 * Module `notify`: the notices a person sees, what they want to be told about, and the
 * webhooks that forward events out of the hub.
 *
 * All twelve operations answer.
 *
 * **Nothing here invents a notice.** The inbox is what other modules wrote to it; a hub
 * where nothing has happened has an empty inbox, and that is the correct answer rather
 * than a welcome message. `record()` is what those modules call.
 *
 * **A webhook is an address the hub will call on its own**, so the URL is checked before
 * anything is sent: `http`/`https` only, and no address that resolves somewhere private
 * unless the webhook says so deliberately (`address.ts`). Without that rule, "add a
 * webhook" would mean "ask the hub to knock on any door inside its network".
 *
 * **A signing secret never comes back.** It is written once and read as `[stored]`, the
 * same shape the updates module uses for its source token.
 */
import { createHmac } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { derived, loadOpenApiDocument } from '@corehub/contracts';
import { newUlid } from '../../db/ids.js';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite, type ModuleDb } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';
import { clampLimit } from '../../lib/pagination.js';
import { defineRoute } from '../../lib/route.js';
import { jobRunnerFor } from '../audit/index.js';
import {
  DEFAULT_WORKSPACE_SLUG,
  emitToUser,
  requireRole,
  requireUser,
  requireWorkspace,
  resolveWorkspaceFor,
} from '../auth/index.js';
import { deliver, unreadCount, type NoticeEvent, type Recipient } from './notices.js';
import { checkAddress } from './address.js';
import {
  notificationPreferences,
  notifications,
  webhookDeliveries,
  webhooks,
  type NotificationData,
} from './schema.js';

export { checkAddress, isPrivateAddress } from './address.js';
export { quietNow, sentenceFor, type NoticeEvent, type Recipient } from './notices.js';

/**
 * What another module holds to put something in somebody's inbox. One method, named after
 * what happened rather than what is shown, because the wording belongs to `notices.ts`
 * and a caller that could choose it would eventually choose it differently.
 */
export interface HubNotifier {
  announce(
    recipient: Recipient,
    event: NoticeEvent,
    resource: { kind: string; id: string } | null,
  ): void;
}

/** A notifier bound to this hub's database and sockets. Composed in `bootstrap`. */
export function createNotifier(db: ModuleDb, io: () => SocketServer | null): HubNotifier {
  return {
    announce(recipient, event, resource) {
      deliver({ db, io: io(), record }, recipient, event, resource);
    },
  };
}

/** Injected so a test can exercise delivery without reaching the network. */
export interface NotifyOverrides {
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
}
let overrides: NotifyOverrides = {};
export function overrideNotify(next: NotifyOverrides): void {
  overrides = next;
}

interface Scope {
  workspace: string;
  profile: string;
  userId: string;
}

/**
 * Notices, preferences and webhooks are **global** operations: they belong to a person and
 * to the hub, not to one workspace. The rows are still workspace-scoped, so a scope is
 * resolved from the header when one is sent and from the caller's default when none is.
 */
function scopeOf(request: FastifyRequest): Scope {
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  if (request.workspace) {
    return {
      workspace: request.workspace.id,
      profile: request.workspace.slug,
      userId: principal.user.id,
    };
  }
  const workspace = resolveWorkspaceFor(
    requireSqlite(request.server.hub.database),
    principal.user,
    (request.headers['x-hub-profile'] as string | undefined) ??
      (request.query as { profile?: string } | undefined)?.profile ??
      DEFAULT_WORKSPACE_SLUG,
  );
  return { workspace: workspace.id, profile: workspace.slug, userId: principal.user.id };
}

const dbOf = (request: FastifyRequest): ModuleDb => requireSqlite(request.server.hub.database);

/**
 * The table knows thirteen kinds of notification; the contract's `NoticeKind` names seven.
 * Anything without a name of its own is `system` — a notice a client cannot categorise is
 * still a notice worth showing, and inventing a category for it would be worse.
 */
const NOTICE_KIND: Record<string, string> = {
  run_completed: 'run_completed',
  run_failed: 'run_completed',
  approval_requested: 'approval_requested',
  question_asked: 'approval_requested',
  mention: 'room_mention',
  task_assigned: 'task_moved',
  task_moved: 'task_moved',
  schedule_failed: 'schedule_failed',
  update_available: 'update_available',
};

function toNotice(
  row: typeof notifications.$inferSelect,
  profile: string,
): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.ownerId,
    profile,
    kind: NOTICE_KIND[row.kind] ?? 'system',
    title: row.title,
    body: row.body,
    resource: row.entityKind && row.entityId ? { kind: row.entityKind, id: row.entityId } : null,
    read_at: row.readAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

function toWebhook(row: typeof webhooks.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    profiles: row.profiles,
    enabled: row.enabled,
    // Written once, read as the fact that there is one.
    secret: row.signingSecret ? '[stored]' : null,
    include_content: row.includeContent,
    allow_private_network: row.allowPrivateNetwork,
    max_retries: row.maxRetries,
    stats: {
      delivered: row.deliveredCount,
      failed: row.failureCount,
      last_delivery_at: row.lastDeliveredAt?.toISOString() ?? null,
      last_error: row.lastError,
    },
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toDelivery(row: typeof webhookDeliveries.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    webhook_id: row.webhookId,
    event: row.eventName,
    status: row.status,
    attempts: row.attempts,
    response_status: row.responseStatus,
    error: row.lastError,
    created_at: row.createdAt.toISOString(),
    delivered_at: row.deliveredAt?.toISOString() ?? null,
  };
}

/** The `*` row holds quiet hours; every other row is one kind's two switches. */
const ALL = '*';

/** Nobody's night is 00:00–00:00, so a hub that was never asked answers a sane window. */
const DEFAULT_QUIET = { enabled: false, from: '22:00', to: '07:00', timezone: 'UTC' };

type PreferenceRow = typeof notificationPreferences.$inferSelect;

function readQuiet(row: PreferenceRow): {
  enabled: boolean;
  from: string;
  to: string;
  timezone: string;
} {
  return {
    // `muted_until` predates the window and still means "silenced": a row muted by the
    // older path reads as enabled rather than as a window nobody set.
    enabled: row.mutedUntil !== null,
    from: row.quietFrom ?? DEFAULT_QUIET.from,
    to: row.quietTo ?? DEFAULT_QUIET.to,
    timezone: row.quietTimezone ?? DEFAULT_QUIET.timezone,
  };
}

function preferenceRow(db: ModuleDb, scope: Scope, kind: string): PreferenceRow | undefined {
  return db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspace, scope.workspace),
        eq(notificationPreferences.ownerId, scope.userId),
        eq(notificationPreferences.kind, kind),
      ),
    )
    .get();
}

function writeQuiet(
  db: ModuleDb,
  scope: Scope,
  window: { enabled: boolean; from: string; to: string; timezone: string },
): void {
  const values = {
    quietFrom: window.from,
    quietTo: window.to,
    quietTimezone: window.timezone,
    mutedUntil: window.enabled ? new Date(0) : null,
  };
  const existing = preferenceRow(db, scope, ALL);
  if (existing) {
    db.update(notificationPreferences)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(notificationPreferences.id, existing.id))
      .run();
    return;
  }
  db.insert(notificationPreferences)
    .values({
      id: newUlid(),
      ownerId: scope.userId,
      workspace: scope.workspace,
      kind: ALL,
      ...values,
    })
    .run();
}

/** Every kind somebody changed. A kind with no row was never changed, so it is not listed. */
function readEvents(
  db: ModuleDb,
  scope: Scope,
): Record<string, { in_app: boolean; push: boolean }> {
  const events: Record<string, { in_app: boolean; push: boolean }> = {};
  const rows = db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspace, scope.workspace),
        eq(notificationPreferences.ownerId, scope.userId),
      ),
    )
    .all();
  for (const row of rows) {
    if (row.kind === ALL) continue;
    events[row.kind] = { in_app: row.inApp, push: row.push };
  }
  return events;
}

export interface NoticeInput {
  workspace: string;
  userId: string;
  kind: string;
  title: string;
  body?: string | null;
  severity?: 'info' | 'warning' | 'error' | 'action_required';
  entityKind?: string | null;
  entityId?: string | null;
  data?: NotificationData;
}

/**
 * What other modules call to put something in a person's inbox. Exported rather than
 * routed: a notice is never created by a client.
 */
export function record(db: ModuleDb, input: NoticeInput): string {
  const id = newUlid();
  db.insert(notifications)
    .values({
      id,
      ownerId: input.userId,
      workspace: input.workspace,
      kind: input.kind as typeof notifications.$inferInsert.kind,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body ?? null,
      entityKind: input.entityKind ?? null,
      entityId: input.entityId ?? null,
      data: input.data ?? {},
    })
    .run();
  return id;
}

/**
 * Tell the person's own clients that their inbox changed, on `/rt/devices` — the
 * namespace the contract gives user-level events. `notice` is null for mark-all: the
 * count is the news, and a hundred envelopes saying the same thing is not.
 */
function announce(
  request: FastifyRequest,
  scope: Scope,
  notice: Record<string, unknown> | null,
  now: Date,
): void {
  emitToUser(
    request.server.hub.io,
    scope.userId,
    REALTIME_NAMESPACES.devices,
    'notice.updated',
    { notice, unread_count: unreadCount(dbOf(request), scope) },
    now.getTime(),
  );
}

/** The events a webhook may subscribe to, served from the contract rather than a list here. */
function webhookEvents(): Array<{ name: string; description: { ar: string; en: string } }> {
  const document = loadOpenApiDocument();
  const names = new Set<string>();
  for (const path of Object.values((document?.paths ?? {}) as Record<string, unknown>)) {
    for (const operation of Object.values(path as Record<string, unknown>)) {
      const events = (operation as { 'x-rt-events'?: string[] })?.['x-rt-events'];
      for (const event of events ?? []) names.add(event);
    }
  }
  return [...names].sort().map((name) => ({
    name,
    // The contract names the events; describing each one in two languages is a
    // translation table nobody maintains, so the name is the description.
    description: { ar: name, en: name },
  }));
}

export const notifyModule = defineModule({
  name: 'notify',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    // ------------------------------------------------------------- notices

    defineRoute(app, deps, {
      operationId: 'notify.listNotices',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const limit = clampLimit(query.limit as number | undefined);
        const rows = dbOf(request)
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.workspace, scope.workspace),
              eq(notifications.ownerId, scope.userId),
              isNull(notifications.dismissedAt),
              query.unread ? isNull(notifications.readAt) : undefined,
            ),
          )
          .orderBy(desc(notifications.id))
          .limit(limit)
          .all();
        // The count is the whole person's, as the contract says — not this page's and not
        // this workspace's, because the badge in the corner counts everything unread.
        const unreadCount = dbOf(request)
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.ownerId, scope.userId),
              isNull(notifications.readAt),
              isNull(notifications.dismissedAt),
            ),
          )
          .all().length;
        return {
          items: rows.map((row) => toNotice(row, scope.profile)),
          next_cursor: null,
          unread_count: unreadCount,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'notify.markAllRead',
      handler: (request) => {
        const scope = scopeOf(request);
        const now = new Date();
        const rows = dbOf(request)
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.workspace, scope.workspace),
              eq(notifications.ownerId, scope.userId),
              isNull(notifications.readAt),
            ),
          )
          .all();
        for (const row of rows) {
          dbOf(request)
            .update(notifications)
            .set({ readAt: now, updatedAt: now })
            .where(eq(notifications.id, row.id))
            .run();
        }
        // One event for the lot: what another client needs is the new count, not a
        // hundred envelopes saying the same thing.
        if (rows.length > 0) announce(request, scope, null, now);
        return { updated: rows.length };
      },
    });

    defineRoute(app, deps, {
      operationId: 'notify.updateNotice',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const id = params.notice_id as string;
        const db = dbOf(request);
        const row = db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.id, id),
              eq(notifications.workspace, scope.workspace),
              // A notice belongs to one person; another may not read or clear it.
              eq(notifications.ownerId, scope.userId),
            ),
          )
          .get();
        if (!row) throw notFound({ resource: 'notice', id });
        const patch = body as { read?: boolean };
        const now = new Date();
        const readAt = patch.read === false ? null : now;
        db.update(notifications)
          .set({ readAt, updatedAt: now })
          .where(eq(notifications.id, id))
          .run();
        const notice = toNotice({ ...row, readAt }, scope.profile);
        announce(request, scope, notice, now);
        return notice;
      },
    });

    // --------------------------------------------------------- preferences

    defineRoute(app, deps, {
      operationId: 'notify.getPreferences',
      handler: (request) => {
        const scope = scopeOf(request);
        const rows = dbOf(request)
          .select()
          .from(notificationPreferences)
          .where(
            and(
              eq(notificationPreferences.workspace, scope.workspace),
              eq(notificationPreferences.ownerId, scope.userId),
            ),
          )
          .all();
        const events: Record<string, { in_app: boolean; push: boolean }> = {};
        let quiet = DEFAULT_QUIET;
        for (const row of rows) {
          if (row.kind === ALL) {
            quiet = readQuiet(row);
            continue;
          }
          events[row.kind] = { in_app: row.inApp, push: row.push };
        }
        // A kind with no row means both channels on: the contract says a missing key is
        // "on", so the hub stores only what somebody changed.
        return { events, quiet_hours: quiet };
      },
    });

    defineRoute(app, deps, {
      operationId: 'notify.setPreferences',
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const db = dbOf(request);
        const input = body as {
          events?: Record<string, { in_app?: boolean; push?: boolean }>;
          quiet_hours?: { enabled?: boolean; from?: string; to?: string; timezone?: string };
        };
        for (const [kind, value] of Object.entries(input.events ?? {})) {
          const existing = db
            .select()
            .from(notificationPreferences)
            .where(
              and(
                eq(notificationPreferences.workspace, scope.workspace),
                eq(notificationPreferences.ownerId, scope.userId),
                eq(notificationPreferences.kind, kind),
              ),
            )
            .get();
          const values = { inApp: value.in_app ?? true, push: value.push ?? true };
          if (existing) {
            db.update(notificationPreferences)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(notificationPreferences.id, existing.id))
              .run();
          } else {
            db.insert(notificationPreferences)
              .values({
                id: newUlid(),
                ownerId: scope.userId,
                workspace: scope.workspace,
                kind,
                ...values,
              })
              .run();
          }
        }
        // Quiet hours live on the `*` row. They are written even when disabled, because a
        // window you switched off is still the window you will switch back on.
        const window = {
          enabled: input.quiet_hours?.enabled ?? false,
          from: input.quiet_hours?.from ?? DEFAULT_QUIET.from,
          to: input.quiet_hours?.to ?? DEFAULT_QUIET.to,
          timezone: input.quiet_hours?.timezone ?? DEFAULT_QUIET.timezone,
        };
        if (input.quiet_hours) writeQuiet(db, scope, window);
        return { events: readEvents(db, scope), quiet_hours: window };
      },
    });

    // ------------------------------------------------------------ webhooks

    defineRoute(app, deps, {
      operationId: 'notify.listWebhookEvents',
      handler: () => ({ items: webhookEvents() }),
    });

    defineRoute(app, deps, {
      operationId: 'notify.listWebhooks',
      handler: (request) => {
        const scope = scopeOf(request);
        const rows = dbOf(request)
          .select()
          .from(webhooks)
          .where(and(eq(webhooks.workspace, scope.workspace), isNull(webhooks.archivedAt)))
          .orderBy(desc(webhooks.id))
          .all();
        return { items: rows.map(toWebhook), next_cursor: null };
      },
    });

    const validateUrl = async (url: string, allowPrivate: boolean) => {
      const verdict = await checkAddress(url, allowPrivate, overrides.resolveHost ?? undefined);
      if (!verdict.ok) {
        throw new HubError('bad_request', {
          details: { reason: `url_${verdict.reason}`, detail: verdict.detail },
        });
      }
    };

    defineRoute(app, deps, {
      operationId: 'notify.createWebhook',
      status: 201,
      handler: async (request, { body }) => {
        const scope = scopeOf(request);
        const input = body as Record<string, unknown>;
        const url = String(input.url ?? '');
        const allowPrivate = (input.allow_private_network as boolean | undefined) ?? false;
        // Checked before it is stored: a webhook the hub would refuse to call is not a
        // webhook worth keeping.
        await validateUrl(url, allowPrivate);
        const id = newUlid();
        dbOf(request)
          .insert(webhooks)
          .values({
            id,
            ownerId: scope.userId,
            workspace: scope.workspace,
            name: String(input.name ?? 'webhook'),
            url,
            events: (input.events as string[] | undefined) ?? [],
            profiles: (input.profiles as string[] | undefined) ?? [],
            enabled: (input.enabled as boolean | undefined) ?? true,
            signingSecret: (input.secret as string | null | undefined) ?? null,
            includeContent: (input.include_content as boolean | undefined) ?? false,
            allowPrivateNetwork: allowPrivate,
            maxRetries: (input.max_retries as number | undefined) ?? 3,
          })
          .run();
        const row = dbOf(request).select().from(webhooks).where(eq(webhooks.id, id)).get()!;
        return toWebhook(row);
      },
    });

    const webhookOf = (request: FastifyRequest, id: string) => {
      const scope = scopeOf(request);
      const row = dbOf(request)
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.workspace, scope.workspace), eq(webhooks.id, id)))
        .get();
      if (!row) throw notFound({ resource: 'webhook', id });
      return row;
    };

    defineRoute(app, deps, {
      operationId: 'notify.updateWebhook',
      handler: async (request, { params, body }) => {
        const id = params.webhook_id as string;
        const current = webhookOf(request, id);
        const patch = body as Record<string, unknown>;
        const allowPrivate =
          (patch.allow_private_network as boolean | undefined) ?? current.allowPrivateNetwork;
        if (patch.url !== undefined) await validateUrl(String(patch.url), allowPrivate);
        const values: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date() };
        if (patch.name !== undefined) values.name = String(patch.name);
        if (patch.url !== undefined) values.url = String(patch.url);
        if (patch.events !== undefined) values.events = patch.events as string[];
        if (patch.profiles !== undefined) values.profiles = patch.profiles as string[];
        if (patch.enabled !== undefined) values.enabled = patch.enabled as boolean;
        if (patch.include_content !== undefined)
          values.includeContent = patch.include_content as boolean;
        if (patch.allow_private_network !== undefined) values.allowPrivateNetwork = allowPrivate;
        if (patch.max_retries !== undefined) values.maxRetries = Number(patch.max_retries);
        // `[stored]` means keep it; null forgets it; anything else replaces it.
        if (patch.secret !== undefined && patch.secret !== '[stored]') {
          values.signingSecret = (patch.secret as string | null) ?? null;
        }
        dbOf(request).update(webhooks).set(values).where(eq(webhooks.id, id)).run();
        return toWebhook(dbOf(request).select().from(webhooks).where(eq(webhooks.id, id)).get()!);
      },
    });

    defineRoute(app, deps, {
      operationId: 'notify.deleteWebhook',
      status: 204,
      handler: (request, { params }) => {
        const id = params.webhook_id as string;
        webhookOf(request, id);
        dbOf(request).delete(webhooks).where(eq(webhooks.id, id)).run();
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'notify.listWebhookDeliveries',
      handler: (request, { params, query }) => {
        const id = params.webhook_id as string;
        webhookOf(request, id);
        const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
        const rows = dbOf(request)
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, id))
          .orderBy(desc(webhookDeliveries.id))
          .limit(limit)
          .all();
        // The payload stays in the table: it may carry message text, and what a person
        // needs here is whether it arrived and what the endpoint said.
        return { items: rows.map(toDelivery) };
      },
    });

    defineRoute(app, deps, {
      operationId: 'notify.testWebhook',
      status: 202,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const id = params.webhook_id as string;
        const row = webhookOf(request, id);
        const db = dbOf(request);
        const fetchImpl = overrides.fetchImpl ?? fetch;
        const job = jobRunnerFor(request.server).start(
          {
            workspace: scope.workspace,
            ownerId: scope.userId,
            kind: 'notify.webhook_test',
            entityKind: 'webhook',
            entityId: id,
          },
          async (handle) => {
            handle.progress(20, 'checking the address');
            const verdict = await checkAddress(
              row.url,
              row.allowPrivateNetwork,
              overrides.resolveHost ?? undefined,
            );
            if (!verdict.ok) {
              throw new HubError('bad_request', {
                details: { reason: `url_${verdict.reason}`, detail: verdict.detail },
              });
            }
            const payload = {
              event: 'webhook.test',
              profile: scope.profile,
              sent_at: new Date().toISOString(),
            };
            const bodyText = JSON.stringify(payload);
            const headers: Record<string, string> = {
              'content-type': 'application/json',
              ...row.headers,
            };
            if (row.signingSecret) {
              // The receiver verifies this rather than trusting the body: that is the
              // whole reason a signing secret exists.
              headers[derived.webhookSignatureHeader] = `sha256=${createHmac(
                'sha256',
                row.signingSecret,
              )
                .update(bodyText)
                .digest('hex')}`;
            }
            handle.progress(60, 'sending');
            const deliveryId = newUlid();
            let status = 0;
            let error: string | null = null;
            try {
              const response = await fetchImpl(row.url, {
                method: 'POST',
                headers,
                body: bodyText,
              });
              status = response.status;
              if (!response.ok) error = `the endpoint answered ${response.status}`;
            } catch (caught) {
              error =
                caught instanceof Error ? caught.message : 'the endpoint could not be reached';
            }
            db.insert(webhookDeliveries)
              .values({
                id: deliveryId,
                ownerId: scope.userId,
                workspace: scope.workspace,
                webhookId: id,
                eventName: 'webhook.test',
                payload,
                status: error ? 'failed' : 'delivered',
                attempts: 1,
                responseStatus: status || null,
                lastError: error,
                deliveredAt: error ? null : new Date(),
              })
              .run();
            const now = new Date();
            db.update(webhooks)
              .set(
                error
                  ? {
                      failureCount: row.failureCount + 1,
                      lastError: error,
                      lastStatus: status || null,
                      updatedAt: now,
                    }
                  : {
                      deliveredCount: row.deliveredCount + 1,
                      lastError: null,
                      lastStatus: status,
                      lastDeliveredAt: now,
                      updatedAt: now,
                    },
              )
              .where(eq(webhooks.id, id))
              .run();
            return { delivered: !error, status, error };
          },
        );
        // The contract's `JobAccepted`: the id to follow, not the job itself. A client reads
        // `job_id`, and a body without it left the page with nothing to wait for.
        return { job_id: job.id };
      },
    });
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime); notices arrive on `/rt/jobs`
    // and the inbox is read over HTTP.
  },
});

export const registerRoutes = notifyModule.registerRoutes.bind(notifyModule);
export const registerEvents = notifyModule.registerEvents.bind(notifyModule);
