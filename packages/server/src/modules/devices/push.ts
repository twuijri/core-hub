/**
 * Push: which senders this hub has, where their credentials come from, and sending one
 * notice to every device a person registered.
 *
 * **Whether** a person is told is `notify`'s decision (their per-kind switch, their quiet
 * hours); this file only knows **how**. It is handed a message that already passed and
 * answers, per device, what the push service said — `notify` records that.
 *
 * Credentials, in order: the environment (`COREHUB_FCM_*`, `COREHUB_APNS_*`), then what an
 * admin stored in Settings (`push_credentials`, sealed with the hub's data key). Web Push
 * needs neither: its keys are the hub's own (`webpush.ts`).
 *
 * A device token is sealed too (`devices.push_token`): it is the address of somebody's
 * phone, and nothing but the sender ever reads it back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';
import { devices, pushCredentials } from './schema.js';
import {
  PUSH_PROVIDERS,
  apnsSender,
  fcmSender,
  parseServiceAccount,
  webPushSender,
  type ApnsCredentials,
  type PushMessage,
  type PushOutcome,
  type PushProvider,
  type PushSender,
} from './senders.js';
import { loadOrCreateVapidKeys, type VapidKeys } from './webpush.js';

/** The `PushEnv` of `app/config.ts`, restated so this module does not import `app/`. */
export interface PushEnvInput {
  contact: string | undefined;
  fcmServiceAccount: string | undefined;
  apns: {
    keyId: string | undefined;
    teamId: string | undefined;
    bundleId: string | undefined;
    key: string | undefined;
    environment: 'production' | 'sandbox' | undefined;
  };
}

/** The data key ring's two verbs, lent by the composition root (models owns the ring). */
export interface Sealer {
  seal(plaintext: string): { ciphertext: string; nonce: string; keyId: string };
  open(sealed: { ciphertext: string; nonce: string; keyId: string }): string;
}

export interface PushServiceOptions {
  db: ModuleDb;
  dataDir: string;
  env: PushEnvInput | undefined;
  sealer: Sealer;
  /** Refuses a Web Push endpoint the hub must not call (returns why), null when fine. */
  checkEndpoint?: (endpoint: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  fcmBaseUrl?: string;
  apnsOrigin?: string;
  now?: () => number;
}

export type SenderState = 'ready' | 'disabled' | 'not_configured' | 'error';
export type SenderSource = 'generated' | 'environment' | 'settings' | 'none';

/** The contract's `PushSender`. */
export interface SenderView {
  provider: PushProvider;
  state: SenderState;
  source: SenderSource;
  missing: string[];
  details: Record<string, string>;
  devices: number;
  last_error: string | null;
  last_sent_at: string | null;
}

/** The contract's `PushSenderUpdate`. */
export interface SenderUpdate {
  enabled?: boolean;
  service_account?: string;
  key_id?: string;
  team_id?: string;
  bundle_id?: string;
  environment?: 'production' | 'sandbox';
  private_key?: string;
  subject?: string;
}

export class PushConfigError extends Error {
  constructor(
    readonly reason: 'invalid' | 'set_by_environment' | 'not_stored',
    message: string,
  ) {
    super(message);
    this.name = 'PushConfigError';
  }
}

export interface DeliveryResult extends PushOutcome {
  deviceId: string;
  provider: PushProvider;
}

const STORED = '[stored]';
const DEFAULT_CONTACT = 'https://github.com/twuijri/core-hub';

/** A value that is the content itself, or a path to a file holding it. */
function contentOrFile(value: string, looksLikeContent: (text: string) => boolean): string {
  if (looksLikeContent(value)) return value;
  if (!existsSync(value)) throw new Error(`${value} does not exist`);
  return readFileSync(value, 'utf8');
}

interface Resolved {
  view: Omit<SenderView, 'devices' | 'last_sent_at'>;
  sender: PushSender | null;
}

export class PushService {
  private vapidKeys: VapidKeys | null = null;
  private readonly cache = new Map<PushProvider, Resolved>();
  private readonly lastSent = new Map<PushProvider, number>();
  private readonly lastError = new Map<PushProvider, string | null>();

  constructor(private readonly options: PushServiceOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The hub's VAPID keys, made on first use. */
  vapid(): VapidKeys {
    this.vapidKeys ??= loadOrCreateVapidKeys(this.options.dataDir);
    return this.vapidKeys;
  }

  private row(provider: PushProvider) {
    return (
      this.options.db
        .select()
        .from(pushCredentials)
        .where(eq(pushCredentials.provider, provider))
        .get() ?? null
    );
  }

  /** Forget cached senders (credentials changed). */
  reset(provider?: PushProvider): void {
    for (const key of provider ? [provider] : PUSH_PROVIDERS) {
      this.cache.get(key)?.sender?.close?.();
      this.cache.delete(key);
    }
  }

  close(): void {
    this.reset();
  }

  private resolve(provider: PushProvider): Resolved {
    const cached = this.cache.get(provider);
    if (cached) return cached;
    const resolved =
      provider === 'webpush'
        ? this.resolveWebPush()
        : provider === 'fcm'
          ? this.resolveFcm()
          : this.resolveApns();
    this.cache.set(provider, resolved);
    return resolved;
  }

  private resolveWebPush(): Resolved {
    const row = this.row('webpush');
    const subject = this.options.env?.contact ?? row?.publicMeta.subject ?? DEFAULT_CONTACT;
    const enabled = row?.enabled ?? true;
    let keys: VapidKeys;
    try {
      keys = this.vapid();
    } catch (error) {
      return {
        view: {
          provider: 'webpush',
          state: 'error',
          source: 'generated',
          missing: [],
          details: { subject },
          last_error: (error as Error).message,
        },
        sender: null,
      };
    }
    return {
      view: {
        provider: 'webpush',
        state: enabled ? 'ready' : 'disabled',
        source: 'generated',
        missing: [],
        details: { public_key: keys.publicKey, subject },
        last_error: row?.lastError ?? null,
      },
      sender: enabled
        ? webPushSender({
            keys,
            subject,
            ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
            ...(this.options.checkEndpoint ? { checkEndpoint: this.options.checkEndpoint } : {}),
            now: () => this.now(),
          })
        : null,
    };
  }

  private resolveFcm(): Resolved {
    const fromEnv = this.options.env?.fcmServiceAccount;
    const row = fromEnv ? null : this.row('fcm');
    if (!fromEnv && !row) {
      return {
        view: {
          provider: 'fcm',
          state: 'not_configured',
          source: 'none',
          missing: ['service_account'],
          details: {},
          last_error: null,
        },
        sender: null,
      };
    }
    const source: SenderSource = fromEnv ? 'environment' : 'settings';
    const enabled = row?.enabled ?? true;
    try {
      const json = fromEnv
        ? contentOrFile(fromEnv, (text) => text.trimStart().startsWith('{'))
        : this.options.sealer.open(row!);
      const credentials = parseServiceAccount(json);
      return {
        view: {
          provider: 'fcm',
          state: enabled ? 'ready' : 'disabled',
          source,
          missing: [],
          details: {
            project_id: credentials.projectId,
            client_email: credentials.clientEmail,
            service_account: STORED,
          },
          last_error: row?.lastError ?? null,
        },
        sender: enabled
          ? fcmSender(credentials, {
              ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
              ...(this.options.fcmBaseUrl ? { baseUrl: this.options.fcmBaseUrl } : {}),
              now: () => this.now(),
            })
          : null,
      };
    } catch (error) {
      return {
        view: {
          provider: 'fcm',
          state: 'error',
          source,
          missing: [],
          details: {},
          last_error: (error as Error).message,
        },
        sender: null,
      };
    }
  }

  private resolveApns(): Resolved {
    const env = this.options.env?.apns;
    const envSet = !!(env && (env.keyId || env.teamId || env.bundleId || env.key));
    const row = envSet ? null : this.row('apns');
    if (!envSet && !row) {
      return {
        view: {
          provider: 'apns',
          state: 'not_configured',
          source: 'none',
          missing: ['key_id', 'team_id', 'bundle_id', 'private_key'],
          details: {},
          last_error: null,
        },
        sender: null,
      };
    }
    const source: SenderSource = envSet ? 'environment' : 'settings';
    const meta = envSet
      ? {
          key_id: env!.keyId ?? '',
          team_id: env!.teamId ?? '',
          bundle_id: env!.bundleId ?? '',
          environment: env!.environment ?? 'production',
        }
      : {
          key_id: row!.publicMeta.key_id ?? '',
          team_id: row!.publicMeta.team_id ?? '',
          bundle_id: row!.publicMeta.bundle_id ?? '',
          environment: row!.publicMeta.environment ?? 'production',
        };
    const hasKey = envSet ? !!env!.key : !!row!.ciphertext;
    const missing = [
      ...(['key_id', 'team_id', 'bundle_id'] as const).filter((field) => !meta[field]),
      ...(hasKey ? [] : ['private_key']),
    ];
    const details: Record<string, string> = {
      ...Object.fromEntries(Object.entries(meta).filter(([, value]) => value)),
      ...(hasKey ? { private_key: STORED } : {}),
    };
    if (missing.length > 0) {
      return {
        view: {
          provider: 'apns',
          state: 'not_configured',
          source,
          missing,
          details,
          last_error: null,
        },
        sender: null,
      };
    }
    const enabled = row?.enabled ?? true;
    try {
      const privateKey = envSet
        ? contentOrFile(env!.key!, (text) => text.includes('BEGIN'))
        : this.options.sealer.open(row!);
      const credentials: ApnsCredentials = {
        keyId: meta.key_id,
        teamId: meta.team_id,
        bundleId: meta.bundle_id,
        privateKey,
        environment: meta.environment === 'sandbox' ? 'sandbox' : 'production',
      };
      const sender = enabled
        ? apnsSender(credentials, {
            ...(this.options.apnsOrigin ? { origin: this.options.apnsOrigin } : {}),
            now: () => this.now(),
          })
        : null;
      return {
        view: {
          provider: 'apns',
          state: enabled ? 'ready' : 'disabled',
          source,
          missing: [],
          details,
          last_error: row?.lastError ?? null,
        },
        sender,
      };
    } catch (error) {
      return {
        view: {
          provider: 'apns',
          state: 'error',
          source,
          missing: [],
          details,
          last_error: `the APNs key could not be read: ${(error as Error).message}`,
        },
        sender: null,
      };
    }
  }

  private deviceCount(provider: PushProvider): number {
    return this.options.db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.pushProvider, provider), eq(devices.status, 'paired')))
      .all().length;
  }

  view(provider: PushProvider): SenderView {
    const { view } = this.resolve(provider);
    const sent = this.lastSent.get(provider);
    const error = this.lastError.has(provider) ? this.lastError.get(provider)! : view.last_error;
    return {
      ...view,
      devices: this.deviceCount(provider),
      last_error: error,
      last_sent_at: sent ? new Date(sent).toISOString() : null,
    };
  }

  views(): SenderView[] {
    return PUSH_PROVIDERS.map((provider) => this.view(provider));
  }

  /** The senders that can deliver right now. */
  ready(): PushProvider[] {
    return PUSH_PROVIDERS.filter((provider) => this.resolve(provider).sender !== null);
  }

  /** The contract's `PushConfig`. */
  config(): { webpush_public_key: string | null; providers: PushProvider[] } {
    const providers = this.ready();
    return {
      webpush_public_key: providers.includes('webpush') ? this.vapid().publicKey : null,
      providers,
    };
  }

  /** Stores a sender's Settings row. The environment wins, so a sender set there is refused. */
  update(provider: PushProvider, update: SenderUpdate, actorId: string): SenderView {
    const current = this.resolve(provider).view;
    if (current.source === 'environment') {
      throw new PushConfigError(
        'set_by_environment',
        `${provider} is configured by the environment (COREHUB_${provider.toUpperCase()}_*)`,
      );
    }
    const row = this.row(provider);
    const is = (value: string | undefined) => value !== undefined && value !== STORED;
    let secret: string | null = null;
    let meta: Record<string, string> = { ...(row?.publicMeta ?? {}) };
    if (provider === 'fcm') {
      if (is(update.service_account)) {
        let parsed;
        try {
          parsed = parseServiceAccount(update.service_account!);
        } catch (error) {
          throw new PushConfigError('invalid', (error as Error).message);
        }
        secret = update.service_account!;
        meta = { project_id: parsed.projectId, client_email: parsed.clientEmail };
      } else if (!row) {
        throw new PushConfigError('invalid', 'FCM needs the service_account JSON');
      }
    } else if (provider === 'apns') {
      for (const field of ['key_id', 'team_id', 'bundle_id', 'environment'] as const) {
        const value = update[field];
        if (value !== undefined) meta[field] = value.trim();
      }
      if (is(update.private_key)) {
        try {
          // Parsing proves it is a key before it is stored.
          apnsSender({
            keyId: 'x',
            teamId: 'x',
            bundleId: 'x',
            privateKey: update.private_key!,
            environment: 'production',
          });
        } catch {
          throw new PushConfigError('invalid', 'private_key is not a .p8 (PEM) key');
        }
        secret = update.private_key!;
      }
    } else {
      if (update.subject !== undefined) {
        if (!/^(mailto:|https:\/\/)/.test(update.subject.trim())) {
          throw new PushConfigError('invalid', 'subject must start with mailto: or https://');
        }
        meta.subject = update.subject.trim();
      }
    }
    const sealed = secret !== null ? this.options.sealer.seal(secret) : null;
    const now = new Date(this.now());
    if (row) {
      this.options.db
        .update(pushCredentials)
        .set({
          publicMeta: meta,
          ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
          ...(sealed
            ? { ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyId: sealed.keyId }
            : {}),
          lastError: null,
          updatedAt: now,
        })
        .where(eq(pushCredentials.id, row.id))
        .run();
    } else {
      // Web Push and a partly filled APNs have nothing secret yet: an empty sealed value.
      const stored = sealed ?? this.options.sealer.seal('');
      this.options.db
        .insert(pushCredentials)
        .values({
          id: newUlid(),
          ownerId: actorId,
          provider,
          label: provider,
          ciphertext: stored.ciphertext,
          nonce: stored.nonce,
          keyId: stored.keyId,
          publicMeta: meta,
          enabled: update.enabled ?? true,
        })
        .run();
    }
    this.reset(provider);
    this.lastError.delete(provider);
    return this.view(provider);
  }

  /** Forgets a sender's Settings row (FCM and APNs). */
  remove(provider: PushProvider): void {
    const row = this.row(provider);
    if (!row) throw new PushConfigError('not_stored', `${provider} has nothing stored`);
    this.options.db.delete(pushCredentials).where(eq(pushCredentials.id, row.id)).run();
    this.reset(provider);
    this.lastError.delete(provider);
  }

  // ---------------------------------------------------------------- device tokens

  sealToken(token: string): string {
    const sealed = this.options.sealer.seal(token);
    return JSON.stringify({ v: 1, c: sealed.ciphertext, n: sealed.nonce, k: sealed.keyId });
  }

  openToken(stored: string): string {
    const parsed = JSON.parse(stored) as { c: string; n: string; k: string };
    return this.options.sealer.open({ ciphertext: parsed.c, nonce: parsed.n, keyId: parsed.k });
  }

  // ---------------------------------------------------------------------- sending

  /** Sends to one device; a token the service says is gone is forgotten here. */
  async sendToDevice(device: typeof devices.$inferSelect, message: PushMessage) {
    const provider = device.pushProvider;
    if (provider === 'none' || !device.pushToken) {
      return null;
    }
    const sender = this.resolve(provider).sender;
    if (!sender) {
      const view = this.resolve(provider).view;
      return {
        deviceId: device.id,
        provider,
        ok: false,
        providerRef: null,
        error: `${provider} is ${view.state.replace('_', ' ')}`,
        gone: false,
      } satisfies DeliveryResult;
    }
    let token: string;
    try {
      token = this.openToken(device.pushToken);
    } catch {
      return {
        deviceId: device.id,
        provider,
        ok: false,
        providerRef: null,
        error: 'the stored push token could not be read',
        gone: true,
      } satisfies DeliveryResult;
    }
    const outcome = await sender.send(token, message);
    if (outcome.ok) {
      this.lastSent.set(provider, this.now());
      this.lastError.set(provider, null);
    } else {
      this.lastError.set(provider, outcome.error);
    }
    if (outcome.gone) this.forgetToken(device.id);
    return { deviceId: device.id, provider, ...outcome } satisfies DeliveryResult;
  }

  private forgetToken(deviceId: string): void {
    this.options.db
      .update(devices)
      .set({ pushProvider: 'none', pushToken: null, pushRegisteredAt: null })
      .where(eq(devices.id, deviceId))
      .run();
  }

  /** Every linked device of the person with a push registration, in parallel. */
  async sendToUser(userId: string, message: PushMessage): Promise<DeliveryResult[]> {
    const rows = this.options.db
      .select()
      .from(devices)
      .where(and(eq(devices.ownerId, userId), eq(devices.status, 'paired')))
      .all()
      .filter((row) => row.pushProvider !== 'none' && row.pushToken);
    const results = await Promise.all(rows.map((row) => this.sendToDevice(row, message)));
    return results.filter((result): result is DeliveryResult => result !== null);
  }
}
