/**
 * CLIProxyAPI's management API, as the hub uses it for the subscriptions signed in to through its
 * model gateway (DECISIONS §143, ADR 0030).
 *
 * The API is on for one reason: the hub runs CLIProxyAPI's own sign-ins and reads the accounts
 * they add. It listens on loopback with the process, takes a secret only the hub knows (made at
 * random each time the hub starts, `cliproxy.ts`), and its control panel is off. Every call the
 * hub makes is here, with the shape CLIProxyAPI 8.0.4 answers in (its `docs/management-api-v8.md`
 * and handlers, read and described in our words); `model-gateway-subscriptions.real.test.ts`
 * drives each of them against the real binary so a new pin that changes one fails there.
 *
 * Nothing here logs a body: account files carry tokens, and although the calls below never ask for
 * one, a vendor's error text may quote one back.
 */

/** What a login answered when it started. */
export interface ManagementLoginStart {
  url: string;
  state: string;
  /** `device` for a code-and-link sign-in (xAI, Kimi, Meta); absent for a browser redirect. */
  flow: 'device' | null;
  userCode: string | null;
  expiresIn: number | null;
}

/** How a login stands: still waiting, done, or refused with CLIProxyAPI's words. */
export type ManagementLoginStatus =
  { status: 'wait' } | { status: 'ok' } | { status: 'error'; error: string };

/** One account in CLIProxyAPI's store, as `GET /credentials` lists it. */
export interface ManagementCredential {
  name: string;
  authIndex: string | null;
  provider: string;
  label: string | null;
  email: string | null;
  accountType: string | null;
  account: string | null;
  status: string;
  statusMessage: string | null;
  disabled: boolean;
  unavailable: boolean;
  nextRetryAfter: string | null;
  lastRefresh: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  note: string | null;
  success: number;
  failed: number;
  recent: { time: string; success: number; failed: number }[];
  /** The vendor's last answer's headers, kept by CLIProxyAPI (Claude, ChatGPT, Devin). */
  quota: { observedAt: string | null; signals: Record<string, string> };
  /** The same, per model, when the vendor answers per model. */
  modelQuotas: Record<string, { observedAt: string | null; signals: Record<string, string> }>;
  /** ChatGPT's id-token claims (its plan among them). */
  idToken: Record<string, unknown> | null;
  /** The Google Cloud project a Google account (Antigravity) works in, when CLIProxyAPI has it. */
  projectId: string | null;
}

/** An answer CLIProxyAPI gave a call made with an account's token (`/requests/api-call`). */
export interface ManagementApiCallResult {
  statusCode: number;
  body: string;
}

/** One item of CLIProxyAPI's usage queue that records a failed call. */
export interface ManagementErrorEvent {
  at: string;
  provider: string | null;
  model: string | null;
  authIndex: string | null;
  statusCode: number | null;
  body: string;
}

export class ManagementError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ManagementError';
  }
}

export interface ManagementClientOptions {
  port: number;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const BASE = '/v8/management';

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function signalsOf(value: unknown): { observedAt: string | null; signals: Record<string, string> } {
  const object = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const raw = (
    object.signals && typeof object.signals === 'object' ? object.signals : {}
  ) as Record<string, unknown>;
  const signals: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') signals[key.toLowerCase()] = entry;
  }
  return { observedAt: str(object.observed_at), signals };
}

/** One entry of `GET /credentials`, read defensively: a newer pin may add or drop fields. */
export function credentialOf(value: unknown): ManagementCredential | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const name = str(entry.name) ?? str(entry.id);
  if (!name) return null;
  const recent = Array.isArray(entry.recent_requests)
    ? entry.recent_requests.flatMap((bucket) => {
        if (!bucket || typeof bucket !== 'object') return [];
        const item = bucket as Record<string, unknown>;
        const time = str(item.time);
        return time ? [{ time, success: num(item.success), failed: num(item.failed) }] : [];
      })
    : [];
  const modelQuotas: ManagementCredential['modelQuotas'] = {};
  if (entry.model_quotas && typeof entry.model_quotas === 'object') {
    for (const [model, quota] of Object.entries(entry.model_quotas as Record<string, unknown>)) {
      modelQuotas[model] = signalsOf(quota);
    }
  }
  return {
    name,
    authIndex: str(entry.auth_index),
    provider: (str(entry.provider) ?? str(entry.type) ?? '').toLowerCase(),
    label: str(entry.label),
    email: str(entry.email),
    accountType: str(entry.account_type),
    account: str(entry.account),
    status: str(entry.status) ?? 'unknown',
    statusMessage: str(entry.status_message),
    disabled: entry.disabled === true,
    unavailable: entry.unavailable === true,
    nextRetryAfter: str(entry.next_retry_after),
    lastRefresh: str(entry.last_refresh),
    createdAt: str(entry.created_at),
    updatedAt: str(entry.updated_at) ?? str(entry.modtime),
    note: str(entry.note),
    success: num(entry.success),
    failed: num(entry.failed),
    recent,
    quota: signalsOf(entry.quota),
    modelQuotas,
    idToken:
      entry.id_token && typeof entry.id_token === 'object'
        ? (entry.id_token as Record<string, unknown>)
        : null,
    projectId: str(entry.project_id),
  };
}

/**
 * One item of the usage queue, when it is a failed call. The queue carries a record of every
 * call (`failed`, and `fail: {status_code, body}` when it failed) and, in some versions, error
 * events with `status_code` and `body` at the top.
 */
export function errorEventOf(value: unknown): ManagementErrorEvent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const fail = (item.fail && typeof item.fail === 'object' ? item.fail : {}) as Record<
    string,
    unknown
  >;
  const status =
    typeof item.status_code === 'number'
      ? item.status_code
      : typeof fail.status_code === 'number'
        ? fail.status_code
        : null;
  const failed =
    item.failed === true || (item.failed === undefined && status !== null && status >= 400);
  if (!failed) return null;
  const body =
    (typeof item.body === 'string' ? item.body : null) ??
    (typeof fail.body === 'string' ? fail.body : null) ??
    str(item.error) ??
    '';
  return {
    at: str(item.timestamp) ?? new Date().toISOString(),
    provider: str(item.provider),
    model: str(item.model),
    authIndex: str(item.auth_index),
    statusCode: status,
    body,
  };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class ManagementClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ManagementClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call<T>(
    method: string,
    route: string,
    body?: unknown,
    timeoutMs = this.options.timeoutMs ?? 15_000,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${this.options.port}${BASE}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.secret}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ManagementError(
        `the gateway's translator did not answer: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      const said =
        parsed && typeof parsed === 'object'
          ? (str((parsed as Record<string, unknown>).error) ??
            str((parsed as Record<string, unknown>).message))
          : null;
      throw new ManagementError(
        said ?? `the gateway's translator answered ${response.status}`,
        response.status,
      );
    }
    return parsed as T;
  }

  /** Starts a vendor's sign-in (`GET /oauth/auth-url?provider=`). */
  async startLogin(vendor: string): Promise<ManagementLoginStart> {
    const body = await this.call<Record<string, unknown>>(
      'GET',
      `/oauth/auth-url?provider=${encodeURIComponent(vendor)}`,
      undefined,
      45_000,
    );
    const url = str(body?.url);
    const state = str(body?.state);
    if (!url || !state) {
      throw new ManagementError('the sign-in gave back no link', null);
    }
    return {
      url,
      state,
      flow: body.flow === 'device' ? 'device' : null,
      userCode: str(body.user_code),
      expiresIn:
        typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : null,
    };
  }

  /** How a sign-in stands (`GET /oauth/status?state=`). */
  async loginStatus(state: string): Promise<ManagementLoginStatus> {
    const body = await this.call<Record<string, unknown>>(
      'GET',
      `/oauth/status?state=${encodeURIComponent(state)}`,
    );
    if (body?.status === 'ok') return { status: 'ok' };
    if (body?.status === 'error') {
      return { status: 'error', error: str(body.error) ?? 'the sign-in did not finish' };
    }
    return { status: 'wait' };
  }

  /**
   * The address a browser sign-in landed on, pasted back (`POST /oauth/callback`). The address's
   * own `state` is what CLIProxyAPI checks — so an address from another, older sign-in is refused
   * rather than taken for this one; only an address without one, or a bare code, is sent with this
   * sign-in's state. The vendor is left for CLIProxyAPI to infer from the state.
   */
  async submitCallback(state: string, pasted: string): Promise<void> {
    const text = pasted.trim();
    let body: Record<string, string>;
    if (/^https?:\/\//i.test(text)) {
      const own = URL.canParse(text) && new URL(text).searchParams.has('state');
      body = own ? { redirect_url: text } : { redirect_url: text, state };
    } else {
      body = { state, code: text };
    }
    await this.call('POST', '/oauth/callback', body);
  }

  /** Forgets a pending sign-in (`DELETE /oauth/session?state=`). Best effort. */
  async cancelLogin(state: string): Promise<void> {
    await this.call('DELETE', `/oauth/session?state=${encodeURIComponent(state)}`).catch(
      () => undefined,
    );
  }

  /** Every account in the store (`GET /credentials`). */
  async credentials(): Promise<ManagementCredential[]> {
    const body = await this.call<Record<string, unknown>>('GET', '/credentials');
    const files = Array.isArray(body?.files) ? body.files : [];
    return files.map(credentialOf).filter((entry): entry is ManagementCredential => !!entry);
  }

  /** Sets fields of an account's file (`PATCH /credentials/fields`): prefix, note, cooling. */
  async setFields(name: string, fields: Record<string, unknown>): Promise<void> {
    await this.call('PATCH', '/credentials/fields', { name, ...fields });
  }

  /** Turns an account off or on (`PATCH /credentials/status`). */
  async setDisabled(name: string, disabled: boolean): Promise<void> {
    await this.call('PATCH', '/credentials/status', { name, disabled });
  }

  /** Signs an account out: its file is deleted (`DELETE /credentials?name=`). */
  async remove(name: string): Promise<void> {
    await this.call('DELETE', `/credentials?name=${encodeURIComponent(name)}`);
  }

  /** Renews an account's token now (`POST /credentials/refresh`). */
  async refresh(name: string): Promise<void> {
    await this.call('POST', '/credentials/refresh', { name }, 45_000);
  }

  /** Lets a cooling account be tried again (`POST /routing/cooldown/reset`). */
  async resetCooldown(authIndex: string): Promise<void> {
    await this.call('POST', '/routing/cooldown/reset', { auth_index: authIndex });
  }

  /**
   * A call to a vendor's address made with an account's token, which CLIProxyAPI puts in place of
   * `$TOKEN$` and never hands out (`POST /requests/api-call`).
   */
  async apiCall(input: {
    authIndex: string;
    method: string;
    url: string;
    header?: Record<string, string>;
    data?: string;
  }): Promise<ManagementApiCallResult> {
    const body = await this.call<Record<string, unknown>>(
      'POST',
      '/requests/api-call',
      {
        auth_index: input.authIndex,
        method: input.method,
        url: input.url,
        header: { authorization: 'Bearer $TOKEN$', ...(input.header ?? {}) },
        ...(input.data === undefined ? {} : { data: input.data }),
      },
      30_000,
    );
    return {
      statusCode: typeof body?.status_code === 'number' ? body.status_code : 0,
      body: typeof body?.body === 'string' ? body.body : '',
    };
  }

  /** Takes the queued usage items, the failed calls among them (`GET /observability/usage/queue`). */
  async drainErrors(count = 500): Promise<ManagementErrorEvent[]> {
    const body = await this.call<unknown>('GET', `/observability/usage/queue?count=${count}`);
    const items = Array.isArray(body) ? body : [];
    return items.map(errorEventOf).filter((item): item is ManagementErrorEvent => !!item);
  }
}
