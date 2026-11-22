/**
 * The plugin's side of the contract (ADR 0033 §1, §2): the generated client from
 * `@corehub/contracts`, bound to the stored link, with the app token renewed the way every other
 * client renews it (CLI `client.ts`, desktop `device-link.ts`): `auth.refresh` with the bearer
 * and no body when fewer than seven days are left, and once more after a `401 token_expired`.
 * A hub that refuses the token any other way stops the link until the person links again.
 */
import { hostname, release, type as osType } from 'node:os';
import {
  HubApiError,
  createHubClient,
  type ClientMethod,
  type HubClient,
  type RawRequestInit,
  type components,
} from '@corehub/contracts';
import { DEVICE_PLATFORM, HARNESS_NAME } from './names.js';
import type { PairingInput } from './pairing.js';
import type { PluginStore, StoredLink } from './store.js';

export type Device = components['schemas']['Device'];
export type PairingResult = components['schemas']['PairingResult'];

export const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most one renewal a day even when the hub keeps answering a short expiry. */
const RENEW_AT_MOST_EVERY_MS = 24 * 60 * 60 * 1000;

/** The platform word the contract knows (`DevicePlatform`). */
export function devicePlatform(
  node: NodeJS.Platform = process.platform,
): 'macos' | 'windows' | 'linux' {
  if (node === 'darwin') return 'macos';
  if (node === 'win32') return 'windows';
  return 'linux';
}

export interface ClaimOptions {
  pairing: PairingInput;
  deviceKey: string;
  pluginVersion: string;
  harnessVersion: string | null;
  fetch?: typeof fetch;
  language?: string;
}

/** Claims a pairing (`auth.claimPairing`) and returns what the store keeps. */
export async function claimPairing(options: ClaimOptions): Promise<StoredLink> {
  const client = createHubClient({
    baseUrl: options.pairing.hub,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.language ? { language: options.language } : {}),
  });
  const name = `${hostname()} · ${HARNESS_NAME}`.slice(0, 80);
  const claim = (platform: string) =>
    client.raw('post', '/auth/pairings/{pairing_id}/claim', {
      params: { pairing_id: options.pairing.pairingId },
      body: {
        code: options.pairing.code,
        device: {
          device_key: options.deviceKey,
          name,
          platform,
          kind: 'computer',
          brand: null,
          model: `${HARNESS_NAME}${options.harnessVersion ? ` ${options.harnessVersion}` : ''}`,
          app_version: options.pluginVersion,
          os_version: `${osType()} ${release()}`.slice(0, 64),
          // What the computer offers comes with the first report on the device link.
          capabilities: [],
        },
      },
      signal: AbortSignal.timeout(20_000),
    });
  let response;
  try {
    // `dsh`: a computer linked through this plugin (DECISIONS §157).
    response = await claim(DEVICE_PLATFORM);
  } catch (error) {
    // A hub older than the `dsh` platform refuses it; it knows the computer by its OS.
    if (!(error instanceof HubApiError) || error.status !== 400) throw error;
    response = await claim(devicePlatform());
  }
  const data = response.data as PairingResult;
  const user = data.user;
  const profiles = user.profiles ?? [];
  return {
    version: 1,
    hub: options.pairing.hub,
    token: data.app_token,
    token_expires_at: data.expires_at ?? null,
    device_id: data.device.id,
    user: { id: user.id, username: user.username, display_name: user.display_name },
    profiles,
    default_profile: user.default_profile ?? profiles[0] ?? 'default',
    linked_at: new Date().toISOString(),
  };
}

/** Why the hub stopped answering this link: the person has to link again. */
export class LinkRefused extends Error {
  constructor(readonly code: string) {
    super(`The hub refused this computer's token (${code}).`);
    this.name = 'LinkRefused';
  }
}

export interface HubConnectionOptions {
  store: PluginStore;
  fetch?: typeof fetch;
  language?: () => string;
  /** Called when the hub refuses the token for good. */
  onRefused?: (code: string) => void;
  now?: () => number;
}

/** A client bound to the stored link; renews the token and keeps the new expiry. */
export class HubConnection {
  private link: StoredLink;
  private refreshing: Promise<boolean> | null = null;
  private renewedAt = 0;
  readonly client: HubClient;

  constructor(
    link: StoredLink,
    private readonly options: HubConnectionOptions,
  ) {
    this.link = link;
    const raw = createHubClient({
      baseUrl: link.hub,
      token: () => this.link.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const call = async (method: ClientMethod, path: string, init?: RawRequestInit) => {
      await this.renewIfDue();
      const headers = { ...(init?.headers ?? {}) };
      const language = this.options.language?.();
      if (language) headers['Accept-Language'] = language;
      try {
        return await raw.raw(method, path, { ...init, headers });
      } catch (error) {
        if (error instanceof HubApiError && error.status === 401) {
          if (error.code === 'token_expired' && (await this.refresh()))
            return raw.raw(method, path, { ...init, headers });
          this.options.onRefused?.(error.code);
          throw new LinkRefused(error.code);
        }
        throw error;
      }
    };
    this.client = { raw: call, request: call as unknown as HubClient['request'] };
  }

  get hub(): string {
    return this.link.hub;
  }

  get token(): string {
    return this.link.token;
  }

  get stored(): StoredLink {
    return this.link;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Renews when fewer than seven days are left (and at most once a day). */
  async renewIfDue(): Promise<void> {
    const expires = this.link.token_expires_at ? Date.parse(this.link.token_expires_at) : NaN;
    if (!Number.isFinite(expires)) return;
    if (expires - this.now() >= RENEW_BEFORE_MS) return;
    if (this.now() - this.renewedAt < RENEW_AT_MOST_EVERY_MS) return;
    await this.refresh();
  }

  /** `auth.refresh` with the app token and no body; keeps the new expiry. */
  refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      this.renewedAt = this.now();
      try {
        const bare = createHubClient({
          baseUrl: this.link.hub,
          token: this.link.token,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        const { data } = await bare.request('post', '/auth/refresh');
        const expiresIn = (data as { expires_in?: unknown }).expires_in;
        if (typeof expiresIn === 'number' && expiresIn > 0) {
          this.link = {
            ...this.link,
            token_expires_at: new Date(this.now() + expiresIn * 1000).toISOString(),
          };
          this.options.store.saveLink(this.link);
        }
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** `auth.logout` with the app token: the hub forgets this computer's token. */
  async revoke(): Promise<void> {
    await this.client.raw('post', '/auth/logout').catch(() => undefined);
  }
}

export type GatewayState =
  | { ok: true; models: GatewayModel[] }
  | { ok: false; reason: 'off' | 'missing' | 'unreachable' | 'refused'; detail: string };

export interface GatewayModel {
  id: string;
  name: string | null;
  context_window: number | null;
}

/** The message of an OpenAI or Anthropic wire error (`{error: {message}}`). */
export function wireMessage(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
    return (error as { message: string }).message;
  return typeof error === 'string' ? error : null;
}

/**
 * Asks the external entrance which models this person may use (`gateway.openaiListModels`,
 * OpenAI's list shape, hub ids `"<provider slug>/<model>"`). While an admin has not switched the
 * entrance on, the hub answers 403 in OpenAI's error envelope; a hub older than the entrance, 404.
 */
export async function gatewayModels(connection: HubConnection): Promise<GatewayState> {
  try {
    // `gateway.openaiListModels` (DECISIONS §156); the path equals `${GATEWAY.openai}/models`.
    const { data } = await connection.client.request('get', '/gateway/openai/v1/models', {
      signal: AbortSignal.timeout(15_000),
    });
    const rows = (data as { data?: unknown })?.data;
    if (!Array.isArray(rows)) return { ok: true, models: [] };
    const models = rows
      .filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string',
      )
      .map((row) => ({
        id: String(row.id),
        name: typeof row.name === 'string' ? row.name : null,
        context_window:
          typeof row.context_window === 'number'
            ? row.context_window
            : typeof row.context_length === 'number'
              ? row.context_length
              : null,
      }));
    return { ok: true, models };
  } catch (error) {
    if (error instanceof LinkRefused) return { ok: false, reason: 'refused', detail: error.code };
    if (error instanceof HubApiError) {
      const detail = wireMessage(error.body) ?? error.message;
      // 403: the entrance is off on this hub, or closed to this token (DECISIONS §156).
      if (error.status === 403) return { ok: false, reason: 'off', detail };
      // 404: a hub from before the external entrance.
      if (error.status === 404) return { ok: false, reason: 'missing', detail };
      return { ok: false, reason: 'unreachable', detail };
    }
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
