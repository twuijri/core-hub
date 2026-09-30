/**
 * Subscriptions signed in to through the hub's model gateway (DECISIONS §143, ADR 0030).
 *
 * The owner's decision (2026-09-30): every provider connected by signing in to an account —
 * Claude, ChatGPT, Google Antigravity, xAI, Kimi, Meta, Devin — is signed in to by the CLIProxyAPI
 * the hub bundles, and its models reach every agent through the gateway. Providers connected with
 * a key stay exactly as they were.
 *
 * This file is the hub's side of that: it starts CLIProxyAPI's own sign-ins (a short code where
 * CLIProxyAPI has one, a link and a pasted-back address where it has not), marks each account it
 * adds as belonging to one provider row (`prefix` h<row>, so the gateway's `h<row>/<model>` reaches
 * exactly that row's accounts; a `note` the hub reads back), and reads what the provider's dialog
 * shows — each account's status, last error, next retry, request counts, and the usage windows the
 * vendor reported (passive) or said when asked ("check now").
 *
 * No token passes through the hub: the sign-in's exchange, the account files and every call made
 * with a token are CLIProxyAPI's. What the hub keeps is in memory: the last list of accounts (for
 * the provider cards, which are drawn without asking), the recent failed calls, and the last
 * "check now" readings.
 */
import { HubError, notFound } from '../../lib/errors.js';
import { redactSecrets } from '../../lib/redact-text.js';
import { t, type UiLanguage } from '../../i18n/index.js';
import type { GatewaySignIn } from './catalogue.js';
import { upstreamPrefix } from './gateway/cliproxy-config.js';
import type { CodexDeviceLogin } from './gateway/cliproxy-login.js';
import {
  ManagementError,
  type ManagementClient,
  type ManagementCredential,
  type ManagementErrorEvent,
} from './gateway/cliproxy-management.js';

/** What the models module needs of the gateway to hold sign-ins. */
export interface SubscriptionBackend {
  /** Why sign-ins cannot be held on this hub (the gateway is off, no CLIProxyAPI), or null. */
  unavailable(): string | null;
  /** A management client on a running CLIProxyAPI, held until `done()`. */
  open(): Promise<{ client: ManagementClient; done(): void }>;
  /** ChatGPT's device sign-in as a child process (`-codex-device-login`), or null. */
  codexDeviceLogin(): CodexDeviceLogin | null;
  /** The models CLIProxyAPI serves under one prefix (`h<row>/…`), without the prefix. */
  models(prefix: string): Promise<SubscriptionModel[]>;
}

export interface SubscriptionModel {
  id: string;
  label: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/** The contract's `UsageWindow`. */
export interface ContractUsageWindow {
  id: string;
  label: string | null;
  window_minutes: number | null;
  used_percent: number | null;
  resets_at: string | null;
  source: 'observed' | 'checked';
}

/** The contract's `ProviderAccount`. */
export interface ContractProviderAccount {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  status: 'active' | 'cooling' | 'error' | 'disabled' | 'refreshing' | 'unknown';
  status_message: string | null;
  disabled: boolean;
  next_retry_at: string | null;
  last_refresh_at: string | null;
  created_at: string | null;
  requests: {
    success: number;
    failed: number;
    recent: { at: string; success: number; failed: number }[];
  };
  windows: ContractUsageWindow[];
  limit_reached: boolean | null;
  quota_observed_at: string | null;
  checked_at: string | null;
  check_error: string | null;
}

/** The contract's `ProviderAccountError`. */
export interface ContractProviderAccountError {
  at: string;
  account_id: string | null;
  model: string | null;
  status: number | null;
  message: string;
}

/** A sign-in in progress, held while the person completes it. */
export interface GatewayLogin {
  vendor: GatewaySignIn['vendor'];
  flow: GatewaySignIn['flow'];
  /** CLIProxyAPI's login state, for the management API's flows. */
  state: string | null;
  /** The running `-codex-device-login`, for ChatGPT. */
  codex: CodexDeviceLogin | null;
  /** The client the login was started on: status and callback go to the same process. */
  client: ManagementClient | null;
  release: () => void;
  /** Accounts of that vendor before the sign-in, by name and last change. */
  before: Map<string, string | null>;
  userCode: string | null;
  url: string;
  expiresIn: number;
  acceptsCode: boolean;
  callbackHint: string | null;
  /** Set once the account is found and marked. */
  account: string | null;
  finished: boolean;
}

export type GatewayLoginPoll =
  | { status: 'pending' }
  | { status: 'approved'; account: string }
  | { status: 'failed'; error: string };

/** How an account says which provider row it belongs to (in its `note`). */
export function accountMarker(providerId: string): string {
  return `corehub:${providerId.toLowerCase()}`;
}

/** The error the dialog's operations answer when the gateway cannot hold sign-ins. */
export function gatewayUnavailable(reason: string): HubError {
  return new HubError('state_invalid', {
    messageKey: 'models.signin.gateway_unavailable',
    details: { reason: 'gateway_unavailable', detail: reason },
  });
}

function translatorError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  if (error instanceof ManagementError && error.status === 404) {
    return notFound({ resource: 'provider_account' });
  }
  return new HubError('service_unavailable', {
    message: error instanceof Error ? redactSecrets(error.message) : 'the gateway did not answer',
    details: { reason: 'gateway_translator' },
  });
}

const MAX_ERRORS = 200;
const SNAPSHOT_TTL_MS = 5_000;

export interface SubscriptionsOptions {
  backend: () => SubscriptionBackend | null;
  now?: () => number;
  /** How long to wait for a ChatGPT device sign-in's account to appear in the store. */
  settleMs?: number;
}

export class Subscriptions {
  private snapshot: { at: number; credentials: ManagementCredential[] } | null = null;
  private readonly errors: ManagementErrorEvent[] = [];
  private readonly checks = new Map<
    string,
    { at: string; windows: ContractUsageWindow[]; limitReached: boolean | null; error: string | null }
  >();
  private readonly now: () => number;

  constructor(private readonly options: SubscriptionsOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Why this hub cannot hold sign-ins, or null. */
  unavailable(): string | null {
    const backend = this.options.backend();
    if (!backend) return 'the model gateway is off on this hub';
    return backend.unavailable();
  }

  private backend(): SubscriptionBackend {
    const backend = this.options.backend();
    const reason = backend ? backend.unavailable() : 'the model gateway is off on this hub';
    if (!backend || reason) throw gatewayUnavailable(reason ?? 'unavailable');
    return backend;
  }

  private async withClient<T>(run: (client: ManagementClient) => Promise<T>): Promise<T> {
    const lease = await this.backend()
      .open()
      .catch((error: unknown) => {
        throw translatorError(error);
      });
    try {
      return await run(lease.client);
    } catch (error) {
      throw translatorError(error);
    } finally {
      lease.done();
    }
  }

  // ------------------------------------------------------------------ sign-in

  /** Starts a vendor's sign-in and holds it until it ends. */
  async start(signIn: GatewaySignIn): Promise<GatewayLogin> {
    const backend = this.backend();
    let lease: { client: ManagementClient; done(): void };
    try {
      lease = await backend.open();
    } catch (error) {
      throw translatorError(error);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease.done();
    };
    try {
      const credentials = await lease.client.credentials();
      this.remember(credentials);
      const before = new Map(
        credentials
          .filter((entry) => entry.provider === signIn.vendor)
          .map((entry) => [entry.name, entry.updatedAt] as const),
      );
      if (signIn.flow === 'codex-device') {
        const codex = backend.codexDeviceLogin();
        if (!codex) throw gatewayUnavailable('this hub has no CLIProxyAPI to sign in with');
        const prompt = await codex.start().catch((error: unknown) => {
          throw new HubError('service_unavailable', {
            message: error instanceof Error ? redactSecrets(error.message) : String(error),
            details: { reason: 'sign_in_no_prompt' },
          });
        });
        return {
          vendor: signIn.vendor,
          flow: signIn.flow,
          state: null,
          codex,
          client: lease.client,
          release,
          before,
          userCode: prompt.userCode,
          url: prompt.url,
          expiresIn: 15 * 60,
          acceptsCode: false,
          callbackHint: null,
          account: null,
          finished: false,
        };
      }
      const started = await lease.client.startLogin(signIn.vendor);
      const device = started.flow === 'device' || signIn.flow === 'device';
      return {
        vendor: signIn.vendor,
        flow: signIn.flow,
        state: started.state,
        codex: null,
        client: lease.client,
        release,
        before,
        userCode: started.userCode,
        url: started.url,
        // CLIProxyAPI gives a browser sign-in five minutes; a device code says its own.
        expiresIn: started.expiresIn ?? (device ? 15 * 60 : 5 * 60),
        acceptsCode: !device,
        callbackHint: device ? null : (signIn.callbackHint ?? null),
        account: null,
        finished: false,
      };
    } catch (error) {
      release();
      throw translatorError(error);
    }
  }

  /** The address (or code) a browser sign-in landed on, pasted back. */
  async complete(login: GatewayLogin, pasted: string): Promise<void> {
    if (!login.acceptsCode || !login.state || !login.client) {
      throw new HubError('state_invalid', {
        messageKey: 'models.signin.code_not_accepted',
        details: { reason: 'code_not_accepted' },
      });
    }
    const text = pasted.trim();
    if (!text) {
      throw new HubError('validation_failed', {
        details: { fields: [{ path: 'code', message: 'paste the address the browser landed on' }] },
      });
    }
    try {
      await login.client.submitCallback(login.vendor, login.state, text);
    } catch (error) {
      if (error instanceof ManagementError && error.status !== null && error.status < 500) {
        throw new HubError('state_invalid', {
          message: redactSecrets(error.message),
          details: { reason: 'callback_refused' },
        });
      }
      throw translatorError(error);
    }
  }

  /**
   * How a sign-in stands. On success the new (or renewed) account is found in the store and marked
   * as this row's: its prefix routes `h<row>/…` to it, its note says whose it is, and it cools down
   * on its own when its vendor says its limit is reached, so the row's other accounts answer.
   */
  async poll(login: GatewayLogin, providerId: string): Promise<GatewayLoginPoll> {
    if (login.finished && login.account) return { status: 'approved', account: login.account };
    try {
      let done = false;
      if (login.codex) {
        const outcome = login.codex.outcome();
        if (outcome.status === 'failed') return this.fail(login, outcome.error);
        done = outcome.status === 'approved';
      } else if (login.client && login.state) {
        const status = await login.client.loginStatus(login.state);
        if (status.status === 'error') return this.fail(login, status.error);
        done = status.status === 'ok';
      }
      if (!done) return { status: 'pending' };
      const account = await this.claim(login, providerId);
      if (!account) {
        // A ChatGPT sign-in's file may take a moment to be read by the running process.
        return { status: 'pending' };
      }
      login.account = account;
      login.finished = true;
      login.release();
      return { status: 'approved', account };
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw translatorError(error);
    }
  }

  private fail(login: GatewayLogin, error: string): GatewayLoginPoll {
    login.finished = true;
    login.release();
    return { status: 'failed', error: redactSecrets(error) };
  }

  /** Stops a sign-in that ran out or was replaced. */
  abandon(login: GatewayLogin): void {
    if (login.finished) return;
    login.finished = true;
    login.codex?.stop();
    if (login.client && login.state) void login.client.cancelLogin(login.state);
    login.release();
  }

  /** Finds the account a finished sign-in added (or renewed) and marks it as the row's. */
  private async claim(login: GatewayLogin, providerId: string): Promise<string | null> {
    const client = login.client;
    if (!client) return null;
    const credentials = await client.credentials();
    this.remember(credentials);
    const candidates = credentials.filter(
      (entry) =>
        entry.provider === login.vendor &&
        (!login.before.has(entry.name) || login.before.get(entry.name) !== entry.updatedAt),
    );
    const account = candidates.sort((a, b) =>
      String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
    )[0];
    if (!account) return null;
    await client.setFields(account.name, {
      prefix: upstreamPrefix(providerId),
      note: accountMarker(providerId),
      disable_cooling: false,
    });
    // The list the cards read, with the mark on it.
    this.remember(await client.credentials());
    return account.name;
  }

  // ------------------------------------------------------------------ accounts

  private remember(credentials: ManagementCredential[]): void {
    this.snapshot = { at: this.now(), credentials };
  }

  /** The accounts as last seen, of one row (for a provider card; asks nothing). */
  cached(providerId: string): ManagementCredential[] {
    const marker = accountMarker(providerId);
    return (this.snapshot?.credentials ?? []).filter((entry) => entry.note === marker);
  }

  /** Whether the list was ever read (a card says nothing until then). */
  known(): boolean {
    return this.snapshot !== null;
  }

  /**
   * Reads the accounts and the queued failed calls again (at most every few seconds, unless
   * `force`). Returns false when CLIProxyAPI could not be asked.
   */
  async refresh(force = false): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!force && this.snapshot && this.now() - this.snapshot.at < SNAPSHOT_TTL_MS) {
      return { ok: true };
    }
    const reason = this.unavailable();
    if (reason) return { ok: false, reason };
    try {
      await this.withClient(async (client) => {
        this.remember(await client.credentials());
        const failed = await client.drainErrors().catch(() => []);
        this.errors.push(...failed);
        if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The account of a row by name, or 404. */
  private accountOf(providerId: string, name: string): ManagementCredential {
    const account = this.cached(providerId).find((entry) => entry.name === name);
    if (!account) throw notFound({ resource: 'provider_account', id: name });
    return account;
  }

  async setDisabled(providerId: string, name: string, disabled: boolean): Promise<void> {
    await this.refresh(true);
    this.accountOf(providerId, name);
    await this.withClient(async (client) => {
      await client.setDisabled(name, disabled);
      this.remember(await client.credentials());
    });
  }

  async remove(providerId: string, name: string): Promise<void> {
    await this.refresh(true);
    this.accountOf(providerId, name);
    this.checks.delete(name);
    await this.withClient(async (client) => {
      await client.remove(name);
      this.remember(await client.credentials());
    });
  }

  /** Every account of a row signed out (the provider is being removed). Best effort. */
  async removeAll(providerId: string): Promise<void> {
    if (this.unavailable()) return;
    await this.refresh(true);
    const names = this.cached(providerId).map((entry) => entry.name);
    if (names.length === 0) return;
    await this.withClient(async (client) => {
      for (const name of names) await client.remove(name).catch(() => undefined);
      this.remember(await client.credentials());
    }).catch(() => undefined);
  }

  /** A new token now, and the account's wait cleared. */
  async renew(providerId: string, name: string): Promise<void> {
    await this.refresh(true);
    const account = this.accountOf(providerId, name);
    await this.withClient(async (client) => {
      await client.refresh(name);
      if (account.authIndex) await client.resetCooldown(account.authIndex).catch(() => undefined);
      this.remember(await client.credentials());
    });
  }

  /** "Check now": the vendor's own usage address, asked with the account's token. */
  async check(providerId: string, name: string, signIn: GatewaySignIn): Promise<void> {
    await this.refresh(true);
    const account = this.accountOf(providerId, name);
    const at = new Date(this.now()).toISOString();
    const reading = (error: string | null, windows: ContractUsageWindow[] = [], limit: boolean | null = null) =>
      this.checks.set(name, { at, windows, limitReached: limit, error });
    if (!signIn.check) return void reading('this vendor has no usage address to ask');
    if (!account.authIndex) return void reading('the account has no index to ask with');
    const header: Record<string, string> = { ...(signIn.check.headers ?? {}) };
    const accountId = account.idToken?.chatgpt_account_id;
    if (signIn.vendor === 'codex' && typeof accountId === 'string') {
      header['chatgpt-account-id'] = accountId;
    }
    const answer = await this.withClient((client) =>
      client.apiCall({
        authIndex: account.authIndex!,
        method: signIn.check!.method,
        url: signIn.check!.url,
        header,
        ...(signIn.check!.body === undefined ? {} : { data: signIn.check!.body }),
      }),
    );
    if (answer.statusCode < 200 || answer.statusCode >= 300) {
      return void reading(
        `the vendor answered ${answer.statusCode}${answer.body ? `: ${redactSecrets(answer.body).slice(0, 200)}` : ''}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(answer.body);
    } catch {
      return void reading('the vendor answered with something that is not JSON');
    }
    const read = readUsage(signIn.vendor, body, this.now());
    if (read.windows.length === 0 && read.limitReached === null) {
      return void reading('the answer carried no usage this hub can read');
    }
    reading(null, read.windows, read.limitReached);
  }

  /** One account in the contract's words. */
  view(account: ManagementCredential, language: UiLanguage): ContractProviderAccount {
    const passive = observedWindows(account, this.now());
    const checked = this.checks.get(account.name);
    const windows = mergeWindows(passive.windows, checked?.windows ?? []).map((window) => ({
      ...window,
      label: windowLabel(window.id, window.window_minutes, language),
    }));
    return {
      id: account.name,
      label: account.email ?? account.label ?? account.name,
      email: account.email,
      plan: planOf(account),
      status: statusOf(account, this.now()),
      status_message: account.statusMessage ? redactSecrets(account.statusMessage) : null,
      disabled: account.disabled,
      next_retry_at: iso(account.nextRetryAfter),
      last_refresh_at: iso(account.lastRefresh),
      created_at: iso(account.createdAt),
      requests: {
        success: account.success,
        failed: account.failed,
        recent: bucketsOf(account.recent, this.now()),
      },
      windows,
      limit_reached: checked?.limitReached ?? passive.limitReached,
      quota_observed_at: iso(account.quota.observedAt),
      checked_at: checked?.at ?? null,
      check_error: checked?.error ?? null,
    };
  }

  /** A row's accounts as the contract says them, from the last list read. */
  accountsView(providerId: string, language: UiLanguage): ContractProviderAccount[] {
    return this.cached(providerId).map((account) => this.view(account, language));
  }

  /** One account, after an action. */
  accountView(providerId: string, name: string, language: UiLanguage): ContractProviderAccount {
    return this.view(this.accountOf(providerId, name), language);
  }

  /** The row's recent failed calls, newest first. */
  errorsOf(providerId: string, limit = 20): ContractProviderAccountError[] {
    const accounts = this.cached(providerId);
    const byIndex = new Map(
      accounts.filter((entry) => entry.authIndex).map((entry) => [entry.authIndex!, entry.name]),
    );
    const prefix = `${upstreamPrefix(providerId)}/`;
    return this.errors
      .filter(
        (event) =>
          (event.authIndex && byIndex.has(event.authIndex)) ||
          (event.model ?? '').toLowerCase().startsWith(prefix),
      )
      .slice(-limit)
      .reverse()
      .map((event) => ({
        at: iso(event.at) ?? new Date(this.now()).toISOString(),
        account_id: (event.authIndex && byIndex.get(event.authIndex)) || null,
        model: event.model ? event.model.replace(prefix, '') : null,
        status: event.statusCode,
        message: redactSecrets(messageOf(event.body)).slice(0, 500) || '—',
      }));
  }

  /** Accounts and the ready ones, for `Provider.subscription` (from the last list read). */
  summary(providerId: string): { accounts: number; ready: number } {
    const accounts = this.cached(providerId);
    return {
      accounts: accounts.length,
      ready: accounts.filter((entry) => statusOf(entry, this.now()) === 'active').length,
    };
  }
}

// ------------------------------------------------------------------- readings

const iso = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at) || at <= 0) return null;
  return new Date(at).toISOString();
};

const BUCKET_MS = 10 * 60_000;

/**
 * CLIProxyAPI's 10-minute buckets, oldest first, the last being the current one. Their labels are
 * `HH:MM-HH:MM` in its process's own time zone, so each bucket's start is counted back from now
 * instead.
 */
function bucketsOf(
  recent: ManagementCredential['recent'],
  now: number,
): { at: string; success: number; failed: number }[] {
  const current = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  return recent.map((bucket, index) => ({
    at: new Date(current - (recent.length - 1 - index) * BUCKET_MS).toISOString(),
    success: bucket.success,
    failed: bucket.failed,
  }));
}

function statusOf(account: ManagementCredential, now: number): ContractProviderAccount['status'] {
  if (account.disabled || account.status === 'disabled') return 'disabled';
  if (account.status === 'error') return 'error';
  if (account.status === 'refreshing') return 'refreshing';
  const retry = account.nextRetryAfter ? Date.parse(account.nextRetryAfter) : Number.NaN;
  if (account.unavailable || (!Number.isNaN(retry) && retry > now)) return 'cooling';
  if (account.status === 'active' || account.status === 'pending') return 'active';
  return 'unknown';
}

function planOf(account: ManagementCredential): string | null {
  const claims = account.idToken ?? {};
  const plan =
    claims.chatgpt_plan_type ?? claims.plan_type ?? account.quota.signals['x-codex-plan-type'];
  if (typeof plan === 'string' && plan) return plan.toLowerCase();
  if (account.accountType && account.accountType !== 'email' && account.accountType !== 'oauth') {
    return account.accountType;
  }
  return null;
}

function messageOf(body: string): string {
  const text = body.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // Plain text.
  }
  return text;
}

const number = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim().replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** A reset time as the vendors say it: unix seconds (or ms), or a date. */
function resetAt(value: unknown, now: number, afterSeconds?: unknown): string | null {
  const numeric = number(value);
  if (numeric !== null && numeric > 0) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = iso(value);
    if (parsed) return parsed;
  }
  const after = number(afterSeconds);
  if (after !== null && after >= 0) return new Date(now + after * 1000).toISOString();
  return null;
}

const CLAUDE_WINDOWS: Record<string, { id: string; minutes: number }> = {
  '5h': { id: 'five_hour', minutes: 300 },
  '7d': { id: 'seven_day', minutes: 10_080 },
  '7d_opus': { id: 'seven_day_opus', minutes: 10_080 },
  '7d_sonnet': { id: 'seven_day_sonnet', minutes: 10_080 },
  '7d_oauth_apps': { id: 'seven_day_oauth_apps', minutes: 10_080 },
};

type Windows = { windows: ContractUsageWindow[]; limitReached: boolean | null };

/**
 * The usage windows the vendor's last answer carried, which CLIProxyAPI keeps per account:
 * Claude's `anthropic-ratelimit-unified-<window>-utilization` / `-reset`, ChatGPT's
 * `x-codex-<primary|secondary>-used-percent` / `-window-minutes` / `-reset-at`.
 */
export function observedWindows(account: ManagementCredential, now: number): Windows {
  const signals = account.quota.signals;
  const observedAt = account.quota.observedAt ? Date.parse(account.quota.observedAt) : now;
  const windows: ContractUsageWindow[] = [];
  let limitReached: boolean | null = null;
  for (const [name, value] of Object.entries(signals)) {
    const claude = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(name);
    if (claude) {
      const key = claude[1]!;
      const known = CLAUDE_WINDOWS[key];
      const used = number(value);
      windows.push({
        id: known?.id ?? key.replace(/[^a-z0-9]+/g, '_'),
        label: null,
        window_minutes: known?.minutes ?? null,
        // Claude says a fraction (0.12); an older form said a percentage.
        used_percent: used === null ? null : used <= 1 ? round(used * 100) : round(used),
        resets_at: resetAt(signals[`anthropic-ratelimit-unified-${key}-reset`], now),
        source: 'observed',
      });
      continue;
    }
    const codex = /^x-codex-(primary|secondary)-used-percent$/.exec(name);
    if (codex) {
      const side = codex[1]!;
      windows.push({
        id: side,
        label: null,
        window_minutes: number(signals[`x-codex-${side}-window-minutes`]),
        used_percent: number(value) === null ? null : round(number(value)!),
        resets_at: resetAt(
          signals[`x-codex-${side}-reset-at`],
          Number.isNaN(observedAt) ? now : observedAt,
          signals[`x-codex-${side}-reset-after-seconds`],
        ),
        source: 'observed',
      });
    }
  }
  const reached = signals['x-codex-limit-reached'];
  if (reached !== undefined) limitReached = reached === 'true';
  const status = signals['anthropic-ratelimit-unified-status'];
  if (status !== undefined) limitReached = status === 'rejected';
  return { windows: windows.sort((a, b) => a.id.localeCompare(b.id)), limitReached };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** What "check now" read from a vendor's usage answer. */
export function readUsage(vendor: string, body: unknown, now: number): Windows {
  const object = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const windows: ContractUsageWindow[] = [];
  let limitReached: boolean | null = null;
  const push = (
    id: string,
    minutes: number | null,
    used: number | null,
    resets: string | null,
  ) =>
    windows.push({
      id,
      label: null,
      window_minutes: minutes,
      used_percent: used === null ? null : round(Math.max(0, used)),
      resets_at: resets,
      source: 'checked',
    });
  const record = (value: unknown) =>
    (value && typeof value === 'object' ? value : null) as Record<string, unknown> | null;

  if (vendor === 'codex') {
    const limit = record(object.rate_limit ?? object.rateLimit);
    if (limit) {
      if (typeof limit.limit_reached === 'boolean') limitReached = limit.limit_reached;
      for (const [side, key] of [
        ['primary', 'primary_window'],
        ['secondary', 'secondary_window'],
      ] as const) {
        const window = record(limit[key] ?? limit[key.replace('_w', 'W')]);
        if (!window) continue;
        const seconds = number(window.limit_window_seconds);
        push(
          side,
          seconds === null ? null : Math.round(seconds / 60),
          number(window.used_percent),
          resetAt(window.reset_at, now, window.reset_after_seconds),
        );
      }
    }
  } else if (vendor === 'claude') {
    for (const [key, value] of Object.entries(object)) {
      const window = record(value);
      if (!window || !('utilization' in window)) continue;
      const known = Object.values(CLAUDE_WINDOWS).find((entry) => entry.id === key);
      push(key, known?.minutes ?? null, number(window.utilization), resetAt(window.resets_at, now));
    }
  } else if (vendor === 'kimi' || vendor === 'kimi-ai') {
    const usage = record(object.usage);
    const fraction = (item: Record<string, unknown> | null) => {
      if (!item) return null;
      const limit = number(item.limit);
      const used = number(item.used);
      const remaining = number(item.remaining);
      if (!limit) return null;
      if (used !== null) return (used / limit) * 100;
      if (remaining !== null) return ((limit - remaining) / limit) * 100;
      return null;
    };
    if (usage) push('total', null, fraction(usage), resetAt(usage.resetTime ?? usage.reset_time, now));
    const limits = Array.isArray(object.limits) ? object.limits : [];
    limits.forEach((raw, index) => {
      const item = record(raw);
      if (!item) return;
      const detail = record(item.detail) ?? item;
      const window = record(item.window) ?? {};
      const duration = number(window.duration);
      const unit = String(window.timeUnit ?? '').toUpperCase();
      const minutes =
        duration === null
          ? null
          : unit.includes('HOUR')
            ? duration * 60
            : unit.includes('DAY')
              ? duration * 1440
              : unit.includes('WEEK')
                ? duration * 10_080
                : unit.includes('SECOND')
                  ? Math.round(duration / 60)
                  : duration;
      push(
        `limit_${index + 1}`,
        minutes,
        fraction(detail),
        resetAt(detail.resetTime ?? detail.reset_time ?? detail.resetAt, now),
      );
    });
  } else if (vendor === 'xai') {
    const config = record(object.config) ?? object;
    const cents = (value: unknown) => number(record(value)?.val ?? value);
    let used = number(config.creditUsagePercent ?? config.credit_usage_percent);
    if (used === null) {
      const limit = cents(config.monthlyLimit ?? config.monthly_limit);
      const spent = cents(config.used);
      if (limit && spent !== null) used = (spent / limit) * 100;
    }
    const period = record(config.currentPeriod ?? config.current_period);
    const type = String(period?.type ?? '').toLowerCase();
    push(
      type.includes('week') ? 'weekly' : 'monthly',
      type.includes('week') ? 10_080 : null,
      used,
      resetAt(period?.end ?? config.billingPeriodEnd ?? config.billing_period_end, now),
    );
    if (used === null) windows.pop();
  } else if (vendor === 'antigravity') {
    const groups = Array.isArray(object.groups) ? object.groups : [];
    for (const rawGroup of groups) {
      const buckets = Array.isArray(record(rawGroup)?.buckets) ? (record(rawGroup)!.buckets as unknown[]) : [];
      for (const rawBucket of buckets) {
        const bucket = record(rawBucket);
        if (!bucket) continue;
        const remaining = number(bucket.remainingFraction ?? bucket.remaining_fraction);
        push(
          String(bucket.bucketId ?? bucket.bucket_id ?? bucket.displayName ?? 'bucket'),
          null,
          remaining === null ? null : (1 - remaining) * 100,
          resetAt(bucket.resetTime ?? bucket.reset_time, now),
        );
      }
    }
  }
  return { windows, limitReached };
}

/** A "check now" reading replaces the passive one of the same window. */
function mergeWindows(
  observed: ContractUsageWindow[],
  checked: ContractUsageWindow[],
): ContractUsageWindow[] {
  const byId = new Map(observed.map((window) => [window.id, window]));
  for (const window of checked) byId.set(window.id, window);
  return [...byId.values()];
}

/** A window's name in the request's language. */
function windowLabel(id: string, minutes: number | null, language: UiLanguage): string | null {
  const key = `models.subscription.window.${id}`;
  const named = t(key, language);
  if (named !== key) return named;
  if (minutes === 300) return t('models.subscription.window.five_hour', language);
  if (minutes === 10_080) return t('models.subscription.window.seven_day', language);
  return null;
}
