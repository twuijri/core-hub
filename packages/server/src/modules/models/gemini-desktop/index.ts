/**
 * Gemini Desktop as a provider the hub itself holds (DECISIONS §155).
 *
 * Every other subscription is signed in to and served by the CLIProxyAPI the hub bundles (ADR
 * 0030). Gemini Desktop cannot be: CLIProxyAPI 8.0.4 has no such provider, and the owner's
 * plugin for it needs a plugin build of CLIProxyAPI the hub does not ship. So the hub speaks the
 * app's native protocol itself — its sign-in (`oauth.ts`), its account's modes (`modes.ts`) and
 * its turns (`wire.ts`, `transport.ts`) — keeps the accounts in its encrypted store
 * (`accounts.ts`), and keeps each hub conversation in one Gemini conversation (`threads.ts`).
 *
 * Text only, and for the hub's direct agent only: the native service has no tool calling, and
 * every other agent (Hermes, Claude Code, Codex …) sends tools with every request, so the gateway
 * refuses those with the reason instead of letting them fail inside the agent.
 */
import { t, type UiLanguage } from '../../../i18n/index.js';
import type { ChatEvent, ChatFailureReason, ChatMessage } from '../adapters/types.js';
import type { ModuleDb } from '../../../lib/db.js';
import type { SecretStore } from '../secrets.js';
import type { ContractProviderAccount } from '../subscriptions.js';
import {
  AccountStore,
  accountIdOf,
  type AccountScope,
  type AccountStorage,
  type StoredAccount,
} from './accounts.js';
import { GEMINI_DESKTOP_AUTO, modeLabel, modeModelId, modeOf, parseUserStatus } from './modes.js';
import {
  GeminiDesktopError,
  REDIRECT_URI,
  acceptCallback,
  exchange,
  refresh,
  startLogin,
  type PendingLogin,
} from './oauth.js';
import { planTurn, recordTurn, turnText, usableKey, type ThreadMessage } from './threads.js';
import {
  GET_USER_STATUS,
  GRPC,
  NativeCallError,
  PROCESS_QUERY,
  defaultOpener,
  nativeCall,
  type SessionOpener,
} from './transport.js';
import { readAnswerFrame, turnFrames, type ConversationIds, type TurnSelection } from './wire.js';

export { GEMINI_DESKTOP_AUTO } from './modes.js';
export { GeminiDesktopError, type PendingLogin } from './oauth.js';
export type { AccountScope, AccountStorage, StoredAccount } from './accounts.js';

/** The vendor name of the preset (`GatewaySignIn.vendor`). */
export const GEMINI_DESKTOP_VENDOR = 'gemini-desktop';
export const GEMINI_DESKTOP_CALLBACK_HINT = REDIRECT_URI;

/** Refreshed this long before Google's expiry. */
const REFRESH_EARLY_MS = 5 * 60_000;

export interface GeminiDesktopOptions {
  db?: ModuleDb;
  secrets?: SecretStore;
  /** Tests: storage instead of the hub's `secrets` table. */
  storage?: AccountStorage;
  fetchImpl?: typeof fetch;
  opener?: SessionOpener;
  now?: () => number;
}

/** A model a Gemini Desktop row lists. */
export interface GeminiDesktopModel {
  id: string;
  label: string;
}

/** One turn of the direct agent. */
export interface GeminiDesktopTurn {
  model: string;
  messages: ChatMessage[];
  /** The hub conversation (`direct-<session>`); without one each turn folds its history. */
  conversation?: string | null;
  signal?: AbortSignal;
}

interface AccountHealth {
  error: string | null;
  checkedAt: number | null;
  success: number;
  failed: number;
}

function failed(reason: ChatFailureReason, detail: string, status: number | null): ChatEvent {
  return { type: 'failed', reason, detail, status };
}

function reasonOf(status: number): ChatFailureReason {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'model_not_found';
  if (status === 499) return 'cancelled';
  if (status === 504 || status === 502) return 'unreachable';
  return 'http_error';
}

export class GeminiDesktop {
  private readonly store: AccountStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly opener: SessionOpener;
  private readonly now: () => number;
  private readonly health = new Map<string, AccountHealth>();
  /** One refresh at a time per account: two turns at once share it. */
  private readonly refreshing = new Map<string, Promise<StoredAccount>>();

  constructor(options: GeminiDesktopOptions) {
    if (options.storage) this.store = options.storage;
    else if (options.db && options.secrets)
      this.store = new AccountStore(options.db, options.secrets);
    else throw new Error('Gemini Desktop needs the hub’s secret store');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.opener = options.opener ?? defaultOpener();
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------------ sign-in

  startLogin(): PendingLogin {
    return startLogin(this.now());
  }

  /**
   * A pasted address: checked against its sign-in (state, expiry, once), exchanged, and the
   * account saved under its verified e-mail — a new account, or the same account renewed. One
   * Google account's sign-in can only ever land on that account.
   */
  async completeLogin(
    row: AccountScope,
    login: PendingLogin,
    pasted: string,
  ): Promise<{ accountId: string }> {
    const code = acceptCallback(login, pasted, this.now());
    const tokens = await exchange(this.fetchImpl, login, code, this.now);
    const email = tokens.email!;
    const id = accountIdOf(email);
    const before = this.store.get(row, id);
    const account: StoredAccount = {
      ...tokens,
      email,
      id,
      modes: before?.modes ?? [],
      modesAt: before?.modesAt ?? null,
      disabled: before?.disabled ?? false,
      createdAt: before?.createdAt ?? this.now(),
      refreshedAt: this.now(),
    };
    this.store.save(row, account);
    this.mark(row.id, id, null);
    // The modes now, so the model list has them; a failure keeps what was known.
    await this.discover(row, account).catch(() => undefined);
    return { accountId: id };
  }

  // ----------------------------------------------------------------- accounts

  accounts(row: AccountScope): StoredAccount[] {
    return this.store.list(row);
  }

  summary(row: AccountScope): { accounts: number; ready: number } {
    const accounts = this.store.list(row);
    return {
      accounts: accounts.length,
      ready: accounts.filter(
        (account) => !account.disabled && !this.health.get(`${row.id}:${account.id}`)?.error,
      ).length,
    };
  }

  view(row: AccountScope, language: UiLanguage): ContractProviderAccount[] {
    return this.store.list(row).map((account) => this.viewOf(row, account, language));
  }

  accountView(row: AccountScope, accountId: string, language: UiLanguage): ContractProviderAccount {
    const account = this.store.get(row, accountId);
    if (!account) throw new GeminiDesktopError(404, 'no such account');
    return this.viewOf(row, account, language);
  }

  private viewOf(
    row: AccountScope,
    account: StoredAccount,
    language: UiLanguage,
  ): ContractProviderAccount {
    const health = this.health.get(`${row.id}:${account.id}`);
    const iso = (at: number | null | undefined) => (at ? new Date(at).toISOString() : null);
    return {
      id: account.id,
      label: account.email ?? t('models.gemini_desktop.account', language),
      email: account.email,
      plan: null,
      status: account.disabled ? 'disabled' : health?.error ? 'error' : 'active',
      status_message: account.disabled ? null : (health?.error ?? null),
      disabled: account.disabled,
      next_retry_at: null,
      last_refresh_at: iso(account.refreshedAt),
      created_at: iso(account.createdAt),
      requests: { success: health?.success ?? 0, failed: health?.failed ?? 0, recent: [] },
      windows: [],
      limit_reached: null,
      quota_observed_at: null,
      checked_at: iso(health?.checkedAt ?? account.modesAt),
      check_error: null,
    };
  }

  setDisabled(row: AccountScope, accountId: string, disabled: boolean): void {
    const account = this.required(row, accountId);
    this.store.save(row, { ...account, disabled });
  }

  remove(row: AccountScope, accountId: string): void {
    if (!this.store.remove(row, accountId)) throw new GeminiDesktopError(404, 'no such account');
    this.health.delete(`${row.id}:${accountId}`);
  }

  removeAll(row: AccountScope): void {
    this.store.removeAll(row);
  }

  /** "Renew" and "Check now": a fresh token and the account's modes asked again. */
  async renew(row: AccountScope, accountId: string): Promise<void> {
    const account = await this.fresh(row, this.required(row, accountId), true);
    await this.discover(row, account);
  }

  private required(row: AccountScope, accountId: string): StoredAccount {
    const account = this.store.get(row, accountId);
    if (!account) throw new GeminiDesktopError(404, 'no such account');
    return account;
  }

  private mark(
    rowId: string,
    accountId: string,
    error: string | null,
    call?: 'success' | 'failed',
  ): void {
    const key = `${rowId}:${accountId}`;
    const health = this.health.get(key) ?? { error: null, checkedAt: null, success: 0, failed: 0 };
    health.error = error;
    health.checkedAt = this.now();
    if (call === 'success') health.success += 1;
    if (call === 'failed') health.failed += 1;
    this.health.set(key, health);
  }

  /**
   * The account with a token that is good now. A refresh is saved at once — the token Google
   * rotated must not be lost because something after it failed.
   */
  private fresh(row: AccountScope, account: StoredAccount, force = false): Promise<StoredAccount> {
    if (!force && account.accessToken && account.expiresAt - REFRESH_EARLY_MS > this.now()) {
      return Promise.resolve(account);
    }
    const key = `${row.id}:${account.id}`;
    const running = this.refreshing.get(key);
    if (running) return running;
    const work = (async () => {
      try {
        const tokens = await refresh(this.fetchImpl, account, this.now);
        // Saved over what is stored now (a mode list may have arrived meanwhile).
        const current = this.store.get(row, account.id) ?? account;
        const next: StoredAccount = {
          ...current,
          ...tokens,
          email: current.email ?? tokens.email,
          refreshedAt: this.now(),
        };
        this.store.save(row, next);
        this.mark(row.id, account.id, null);
        return next;
      } catch (error) {
        this.mark(
          row.id,
          account.id,
          error instanceof Error ? error.message : 'the sign-in could not be renewed',
        );
        throw error;
      } finally {
        this.refreshing.delete(key);
      }
    })();
    this.refreshing.set(key, work);
    return work;
  }

  /** Asks the account's modes and saves them; on failure the previous modes stay. */
  private async discover(row: AccountScope, account: StoredAccount): Promise<StoredAccount> {
    let answer: Buffer | null = null;
    await nativeCall(
      {
        method: GET_USER_STATUS,
        token: account.accessToken,
        frames: [Buffer.alloc(0)],
        onMessage: (message) => {
          answer = message;
        },
      },
      this.opener,
    );
    if (!answer) throw new GeminiDesktopError(502, 'Gemini answered no account status');
    let modes;
    try {
      modes = parseUserStatus(answer);
    } catch {
      throw new GeminiDesktopError(502, 'Gemini answered an account status the hub cannot read');
    }
    const current = this.store.get(row, account.id) ?? account;
    const next = { ...current, modes, modesAt: this.now() };
    this.store.save(row, next);
    return next;
  }

  // ------------------------------------------------------------------- models

  /**
   * The row's models: each enabled account's modes asked again (a failure keeps the account's
   * previous ones), named once each, and `gemini-desktop-auto` (Google picks). Throws when the row
   * has no account.
   */
  async models(row: AccountScope): Promise<GeminiDesktopModel[]> {
    const accounts = this.store.list(row).filter((account) => !account.disabled);
    if (accounts.length === 0)
      throw new GeminiDesktopError(409, 'no Gemini account is signed in under this provider yet');
    const out = new Map<string, GeminiDesktopModel>();
    for (const listed of accounts) {
      let account = listed;
      try {
        account = await this.fresh(row, account);
        account = await this.discover(row, account);
      } catch {
        // The account's last known modes still name what it offers.
      }
      for (const mode of account.modes) {
        const id = modeModelId(mode);
        if (!out.has(id)) out.set(id, { id, label: modeLabel(mode) });
      }
    }
    return [{ id: GEMINI_DESKTOP_AUTO, label: 'Gemini (auto)' }, ...out.values()];
  }

  // --------------------------------------------------------------------- chat

  /** One direct turn. Never throws: every failure is a final `failed` event. */
  async *chat(row: AccountScope, turn: GeminiDesktopTurn): AsyncIterable<ChatEvent> {
    try {
      yield* this.chatTurn(row, turn);
    } catch (error) {
      if (error instanceof NativeCallError) {
        yield failed(
          reasonOf(error.status),
          error.message,
          error.status === 499 ? null : error.status,
        );
      } else if (error instanceof GeminiDesktopError) {
        yield failed(reasonOf(error.status), error.message, error.status);
      } else {
        yield failed(
          'http_error',
          error instanceof Error ? error.message : 'the Gemini turn failed',
          null,
        );
      }
    }
  }

  private async *chatTurn(row: AccountScope, turn: GeminiDesktopTurn): AsyncIterable<ChatEvent> {
    const messages: ThreadMessage[] = turn.messages.map((message) => ({
      role: message.role,
      text: message.text,
    }));
    if (turn.messages.some((message) => (message.images?.length ?? 0) > 0)) {
      yield failed(
        'unsupported',
        'Gemini Desktop takes text only in Core Hub; send the message without the image',
        400,
      );
      return;
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || !last.text.trim()) {
      yield failed('unsupported', 'a Gemini Desktop turn needs a message to send', 400);
      return;
    }
    const accounts = this.store.list(row).filter((account) => !account.disabled);
    if (accounts.length === 0) {
      yield failed(
        'no_key',
        'no Gemini account is signed in under this provider; sign in under Models → Providers',
        null,
      );
      return;
    }
    const key = usableKey(turn.conversation) ? turn.conversation : null;
    let threads = key ? this.store.threads(row) : {};
    const thread = key ? threads[key] : undefined;

    // The account: the conversation's own while it can serve the model, else the first that can.
    const serves = (account: StoredAccount) =>
      turn.model === GEMINI_DESKTOP_AUTO || modeOf(account.modes, turn.model) !== null;
    const own = thread ? accounts.find((account) => account.id === thread.account) : undefined;
    let account = own && serves(own) ? own : accounts.find(serves);
    if (!account) {
      yield failed(
        'model_not_found',
        `${turn.model} is not one of the modes your Gemini account offers now; refresh this provider's models under Models → Providers`,
        404,
      );
      return;
    }
    const sameThread = !!thread && thread.account === account.id;
    let plan = planTurn(sameThread ? thread : undefined, messages);
    if (!sameThread && thread && thread.turns.length > 0 && plan.kind === 'new') {
      plan = { kind: 'new', folded: plan.folded || messages.length > 1, diverged: true };
    }
    const mode = turn.model === GEMINI_DESKTOP_AUTO ? null : modeOf(account.modes, turn.model);
    const selection: TurnSelection = {
      category: mode?.category ?? 0,
      variantId: mode?.variantId ?? null,
    };

    account = await this.fresh(row, account);
    let emitted = '';
    const notice = (): string =>
      `${t('models.gemini_desktop.restarted', 'en')}\n${t('models.gemini_desktop.restarted', 'ar')}\n\n`;

    // A conversation Google no longer continues (deleted in the app, gone with its history) is
    // started again with the history, and the reader is told.
    const attempts: {
      resume: ConversationIds | null;
      text: string;
      startsNew: boolean;
      tell: boolean;
    }[] = [];
    if (plan.kind === 'new') {
      attempts.push({
        resume: null,
        text: turnText(messages, false),
        startsNew: true,
        tell: plan.diverged,
      });
    } else {
      attempts.push({
        resume: plan.resume,
        text: turnText(messages, true),
        startsNew: false,
        tell: false,
      });
      attempts.push({ resume: null, text: turnText(messages, false), startsNew: true, tell: true });
    }
    let refreshedOnce = false;
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;
      const ids: Partial<ConversationIds> = {};
      let text = '';
      const deltas: string[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let failure: unknown = null;
      if (attempt.tell && !emitted) {
        const words = notice();
        emitted += words;
        yield { type: 'delta', text: words };
      }
      const call = nativeCall(
        {
          method: PROCESS_QUERY,
          token: account.accessToken,
          frames: turnFrames(attempt.text, selection, attempt.resume),
          ...(turn.signal ? { signal: turn.signal } : {}),
          onMessage: (message) => {
            let frame;
            try {
              frame = readAnswerFrame(message);
            } catch {
              throw new GeminiDesktopError(502, 'Gemini sent a frame the hub cannot read');
            }
            if (frame.conversation) ids.conversation = frame.conversation;
            if (frame.response) ids.response = frame.response;
            if (frame.choice) ids.choice = frame.choice;
            // Snapshots grow; one that does not start with what was said is a revision, skipped.
            if (
              frame.text !== null &&
              frame.text.startsWith(text) &&
              frame.text.length > text.length
            ) {
              deltas.push(frame.text.slice(text.length));
              text = frame.text;
              wake?.();
            }
          },
        },
        this.opener,
      ).then(
        () => {
          ended = true;
          wake?.();
        },
        (error: unknown) => {
          failure = error;
          ended = true;
          wake?.();
        },
      );
      while (!ended || deltas.length > 0) {
        if (deltas.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (ended || deltas.length > 0) resolve();
          });
          wake = null;
          continue;
        }
        const delta = deltas.shift()!;
        emitted += delta;
        yield { type: 'delta', text: delta };
      }
      await call;
      const saidNothing = text === '';
      if (failure) {
        const code = failure instanceof NativeCallError ? failure.code : null;
        if (code === GRPC.UNAUTHENTICATED && saidNothing && !refreshedOnce) {
          refreshedOnce = true;
          account = await this.fresh(row, account, true);
          index -= 1; // the same attempt, with the new token
          continue;
        }
        const cancelled = code === GRPC.CANCELLED || turn.signal?.aborted;
        if (cancelled && key && ids.conversation && ids.response && ids.choice) {
          // The direct agent keeps a stopped answer; so does the conversation's place.
          threads = recordTurn(
            threads,
            key,
            account.id,
            [...messages, { role: 'assistant', text: emitted }],
            ids as ConversationIds,
            this.now(),
            attempt.startsNew,
          );
          this.store.saveThreads(row, threads);
        }
        const continuationRefused =
          !attempt.startsNew &&
          saidNothing &&
          (code === GRPC.INVALID_ARGUMENT ||
            code === GRPC.NOT_FOUND ||
            code === GRPC.FAILED_PRECONDITION);
        if (continuationRefused && index + 1 < attempts.length) continue;
        if (!cancelled)
          this.mark(
            row.id,
            account.id,
            failure instanceof Error ? failure.message : 'the turn failed',
            'failed',
          );
        throw failure;
      }
      if (saidNothing) {
        this.mark(row.id, account.id, null, 'failed');
        yield failed(
          'http_error',
          'Gemini finished without a text answer; Core Hub takes text answers only from Gemini Desktop',
          502,
        );
        return;
      }
      this.mark(row.id, account.id, null, 'success');
      if (key && ids.conversation && ids.response && ids.choice) {
        threads = recordTurn(
          threads,
          key,
          account.id,
          [...messages, { role: 'assistant', text: emitted }],
          ids as ConversationIds,
          this.now(),
          attempt.startsNew,
        );
        this.store.saveThreads(row, threads);
      }
      yield { type: 'completed' };
      return;
    }
  }
}
