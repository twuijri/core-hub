/**
 * The Core Hub push relay, the hub's half (ADR 0024, DECISIONS §82).
 *
 * The official iOS and Android apps belong to the owner's Apple team and Firebase project, so
 * a hub can reach them only with his APNs and FCM keys. Those keys stay in one place — the
 * relay, a Cloudflare Worker he runs (`packages/push-relay`) — and a hub without credentials of
 * its own pushes through it: it registers itself on first need (an id and a secret, the secret
 * sealed here like every other), binds each phone's token to itself, and signs every call
 * (HMAC over the body with a timestamp and a nonce).
 *
 * Local credentials always win: a sender configured in the environment or in Settings never
 * touches the relay. `COREHUB_PUSH_RELAY=off` or the admin's switch turn it off entirely.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';
import { pushRelay, type PUSH_RELAY_STATES } from './schema.js';
import type { PushMessage, PushOutcome, PushSender } from './senders.js';
import type { Sealer } from './push.js';

/**
 * The relay every hub uses unless `COREHUB_PUSH_RELAY_URL` says otherwise. Empty until the
 * owner deploys the relay: then set it here to the relay's `https://` address (its custom
 * domain or its `workers.dev` address; packages/push-relay/README.md), and every hub built
 * from then on pushes to phones with nothing to set.
 */
export const DEFAULT_RELAY_URL = '';

export type RelayPlatform = 'apns' | 'fcm';
export type StoredRelayState = (typeof PUSH_RELAY_STATES)[number];
/** The contract's `PushRelayStatus.state`. */
export type RelayState = StoredRelayState | 'off' | 'no_url';

/** The contract's `PushRelayStatus`. */
export interface RelayStatusView {
  state: RelayState;
  enabled: boolean;
  forced_off: boolean;
  private_push: boolean;
  url: string | null;
  hub_id: string | null;
  last_error: string | null;
  checked_at: string | null;
}

/** The `push.relay` part of `app/config.ts`'s `PushEnv`, restated. */
export interface RelayEnvInput {
  url: string | undefined;
  off: boolean;
}

/** The contract's `PushRelayProof`, forwarded to the relay unread. */
export interface RelayProof {
  key: string;
  signed_at: number;
  signature: string;
}

export interface RelayDelivery {
  status: 'sent' | 'failed' | 'gone' | 'not_bound';
  ref: string | null;
  error: string | null;
}

export type BindResult = 'bound' | 'rebound' | 'bound_elsewhere' | 'failed';

export class RelayCallError extends Error {
  constructor(
    readonly state: StoredRelayState,
    message: string,
  ) {
    super(message);
    this.name = 'RelayCallError';
  }
}

export interface PushRelayOptions {
  db: ModuleDb;
  sealer: Sealer;
  env: RelayEnvInput | undefined;
  fetchImpl?: typeof fetch;
  now: () => number;
}

/** The same key the relay binds under: it never sees a token it is not sending to. */
export function relayTokenHash(platform: RelayPlatform, token: string): string {
  return createHash('sha256').update(`${platform}:${token}`).digest('hex');
}

/** The relay's signing input (packages/push-relay/src/relay.ts `signingInput`). */
export function relaySigningInput(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return ['corehub-relay-v1', method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
}

const CALL_TIMEOUT_MS = 10_000;
/** A hub re-states its tokens at least this often, so the relay knows it is alive. */
export const SYNC_EVERY_MS = 24 * 60 * 60_000;

type Row = typeof pushRelay.$inferSelect;

export class PushRelay {
  constructor(private readonly options: PushRelayOptions) {}

  private now(): number {
    return this.options.now();
  }

  /** The relay's address: the environment's, else the one built in; null when neither. */
  url(): string | null {
    const url = this.options.env?.url || DEFAULT_RELAY_URL;
    return url ? url.replace(/\/+$/, '') : null;
  }

  forcedOff(): boolean {
    return this.options.env?.off ?? false;
  }

  private row(): Row | null {
    return this.options.db.select().from(pushRelay).get() ?? null;
  }

  private ensureRow(): Row {
    const existing = this.row();
    if (existing) return existing;
    return this.options.db.insert(pushRelay).values({ id: newUlid() }).returning().get();
  }

  private patch(values: Partial<typeof pushRelay.$inferInsert>): void {
    const row = this.ensureRow();
    this.options.db.update(pushRelay).set(values).where(eq(pushRelay.id, row.id)).run();
  }

  /** May the hub use the relay at all right now? */
  usable(): boolean {
    return !this.forcedOff() && (this.row()?.enabled ?? true) && this.url() !== null;
  }

  privatePush(): boolean {
    return this.row()?.privatePush ?? false;
  }

  /** Registered with the relay at today's address. */
  private registration(row: Row | null): { hubId: string; secret: string } | null {
    if (!row?.hubId || !row.ciphertext || !row.nonce || !row.keyId) return null;
    if (row.url !== this.url()) return null;
    return {
      hubId: row.hubId,
      secret: this.options.sealer.open({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        keyId: row.keyId,
      }),
    };
  }

  isRegistered(): boolean {
    return this.registration(this.row()) !== null;
  }

  status(): RelayStatusView {
    const row = this.row();
    const url = this.url();
    const enabled = row?.enabled ?? true;
    const registered = !!row?.hubId && row.url === url;
    const state: RelayState =
      this.forcedOff() || !enabled
        ? 'off'
        : !url
          ? 'no_url'
          : !registered
            ? row?.state === 'rate_limited' || row?.state === 'unreachable'
              ? row.state
              : 'not_registered'
            : (row?.state ?? 'ready');
    return {
      state,
      enabled,
      forced_off: this.forcedOff(),
      private_push: row?.privatePush ?? false,
      url,
      hub_id: registered ? row!.hubId : null,
      last_error: row?.lastError ?? null,
      checked_at: row?.checkedAt ? row.checkedAt.toISOString() : null,
    };
  }

  update(input: { enabled?: boolean; private_push?: boolean }): RelayStatusView {
    this.patch({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.private_push !== undefined ? { privatePush: input.private_push } : {}),
    });
    return this.status();
  }

  /** Records what the relay said: written when it changes, or once a minute otherwise. */
  private record(state: StoredRelayState, error: string | null): void {
    const row = this.row();
    const at = this.now();
    if (
      row &&
      row.state === state &&
      row.lastError === error &&
      row.checkedAt &&
      at - row.checkedAt.getTime() < 60_000
    ) {
      return;
    }
    this.patch({ state, lastError: error, checkedAt: new Date(at) });
  }

  private async fetchRelay(path: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      return await fetchImpl(`${this.url()}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      const message = `the relay did not answer: ${(error as Error).message}`;
      this.record('unreachable', message);
      throw new RelayCallError('unreachable', message);
    }
  }

  /** Registers this hub (no approval: the zero-setup promise) and seals its secret. */
  private async register(): Promise<{ hubId: string; secret: string }> {
    const response = await this.fetchRelay('/v1/hubs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await response.json().catch(() => ({}))) as {
      hub_id?: string;
      secret?: string;
      message?: string;
    };
    if (response.status !== 201 || !body.hub_id || !body.secret) {
      const state: StoredRelayState = response.status === 429 ? 'rate_limited' : 'unreachable';
      const message = `the relay refused to register this hub (${response.status}${
        body.message ? `: ${body.message}` : ''
      })`;
      this.record(state, message);
      throw new RelayCallError(state, message);
    }
    const sealed = this.options.sealer.seal(body.secret);
    this.patch({
      url: this.url(),
      hubId: body.hub_id,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyId: sealed.keyId,
      syncedAt: null,
    });
    return { hubId: body.hub_id, secret: body.secret };
  }

  /**
   * One signed call. A relay that no longer knows this hub (its database was reset) gets a
   * fresh registration and the call once more.
   */
  async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    payload?: unknown,
    retried = false,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.usable()) throw new RelayCallError('unreachable', 'the relay is off');
    const credentials = this.registration(this.row()) ?? (await this.register());
    const text = payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const signature = createHmac('sha256', credentials.secret)
      .update(relaySigningInput(method, path, timestamp, nonce, text))
      .digest('hex');
    const response = await this.fetchRelay(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-corehub-hub': credentials.hubId,
        'x-corehub-timestamp': timestamp,
        'x-corehub-nonce': nonce,
        'x-corehub-signature': signature,
      },
      ...(method === 'GET' ? {} : { body: text }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const said = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
    if (response.status === 401 && body.error === 'unknown_hub' && !retried) {
      this.patch({ hubId: null, ciphertext: null, nonce: null, keyId: null });
      return this.call(method, path, payload, true);
    }
    if (response.status === 403 && body.error === 'blocked') {
      this.record('blocked', `the relay blocked this hub: ${said}`);
      throw new RelayCallError('blocked', said);
    }
    if (response.status === 429) {
      this.record('rate_limited', `the relay's limit: ${said}`);
      throw new RelayCallError('rate_limited', said);
    }
    if (response.status >= 500 || response.status === 401) {
      this.record('unreachable', `the relay answered ${response.status}: ${said}`);
      throw new RelayCallError('unreachable', said);
    }
    this.record('ready', null);
    return { status: response.status, body };
  }

  /** Binds a phone's token to this hub. Never throws: what happened is the answer. */
  async bind(platform: RelayPlatform, token: string, proof?: RelayProof): Promise<BindResult> {
    try {
      const answer = await this.call('POST', '/v1/tokens', {
        platform,
        token,
        ...(proof ? { proof } : {}),
      });
      if (answer.status === 200) return answer.body.status === 'rebound' ? 'rebound' : 'bound';
      if (answer.status === 409) return 'bound_elsewhere';
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  async push(message: Record<string, unknown>): Promise<RelayDelivery> {
    const answer = await this.call('POST', '/v1/push', { messages: [message] });
    const result = (answer.body.results as RelayDelivery[] | undefined)?.[0];
    if (answer.status !== 200 || !result) {
      return {
        status: 'failed',
        ref: null,
        error: `the relay refused the message (${answer.status})`,
      };
    }
    return result;
  }

  /**
   * States every token this hub still wants bound; the relay forgets the others (a sign-out,
   * a revoked sign-in, an unlinked device: every clean-up path lands here) and names the listed
   * ones it does not hold, which are bound again.
   */
  async sync(tokens: Array<{ platform: RelayPlatform; token: string }>): Promise<void> {
    if (tokens.length === 0 && !this.isRegistered()) return;
    const byHash = new Map(tokens.map((t) => [relayTokenHash(t.platform, t.token), t]));
    const answer = await this.call('POST', '/v1/tokens/sync', {
      tokens: [...byHash].map(([hash, t]) => ({ platform: t.platform, hash })),
    });
    this.patch({ syncedAt: new Date(this.now()) });
    const missing = (answer.body.missing as Array<{ hash: string }> | undefined) ?? [];
    for (const entry of missing) {
      const wanted = byHash.get(entry.hash);
      if (wanted) await this.bind(wanted.platform, wanted.token);
    }
  }

  syncDue(): boolean {
    const synced = this.row()?.syncedAt;
    return !synced || this.now() - synced.getTime() > SYNC_EVERY_MS;
  }
}

const GENERIC_TITLE = {
  ar: 'إشعار جديد في كور هب',
  en: 'New notice in Core Hub',
} as const;

/**
 * What goes to the relay for one notice. Private push keeps the words at home: a generic
 * title and the notice id, which the app opens from its hub.
 */
export function relayMessage(
  platform: RelayPlatform,
  token: string,
  message: PushMessage,
  privatePush: boolean,
): Record<string, unknown> {
  if (privatePush) {
    return {
      platform,
      token,
      title: GENERIC_TITLE[message.locale === 'en' ? 'en' : 'ar'],
      body: null,
      data: { type: 'notice', notice_id: message.noticeId, kind: message.kind },
      urgent: message.urgent,
      collapse_id: message.noticeId ? message.noticeId.slice(-64) : null,
      thread_id: null,
    };
  }
  return {
    platform,
    token,
    title: message.title.slice(0, 500) || GENERIC_TITLE.en,
    body: message.body ? message.body.slice(0, 2000) : null,
    data: {
      type: 'notice',
      notice_id: message.noticeId,
      kind: message.kind,
      profile: message.profile,
      resource: message.resource,
    },
    urgent: message.urgent,
    collapse_id: message.noticeId ? message.noticeId.slice(-64) : null,
    thread_id: message.profile ? message.profile.slice(0, 64) : null,
  };
}

/** FCM or APNs through the relay, with the same `send` as a local sender. */
export function relaySender(relay: PushRelay, platform: RelayPlatform): PushSender {
  const fail = (error: string, gone = false): PushOutcome => ({
    ok: false,
    providerRef: null,
    error,
    gone,
  });
  return {
    provider: platform,
    async send(token, message) {
      let delivery: RelayDelivery;
      try {
        const wire = relayMessage(platform, token, message, relay.privatePush());
        delivery = await relay.push(wire);
        if (delivery.status === 'not_bound') {
          // Registered before the relay knew it (or the relay lost it): bind, then once more.
          const bound = await relay.bind(platform, token);
          if (bound === 'bound_elsewhere') {
            return fail('relay: this phone is bound to another hub');
          }
          delivery = await relay.push(wire);
        }
      } catch (error) {
        return fail(`relay: ${(error as Error).message}`);
      }
      if (delivery.status === 'sent') {
        return { ok: true, providerRef: delivery.ref, error: null, gone: false };
      }
      return fail(`relay: ${delivery.error ?? delivery.status}`, delivery.status === 'gone');
    },
  };
}
