/**
 * The two agent tools that need Hermes to *do* something rather than a file to be written:
 * testing an MCP server and pairing WhatsApp by QR. Both go through Hermes's own API
 * (`hermes serve`, ADR 0015), in the profile the person has selected — never through Hermes's
 * private functions, and never by the hub pretending to be an MCP client or a WhatsApp bridge.
 *
 * What Hermes answers was read from its MIT source (`hermes_cli/web_routers/mcp.py`,
 * `…/messaging.py`, tag v2026.9.14) and then measured against the image:
 *
 * - `POST /api/mcp/servers/{name}/test?profile=` connects, lists the tools and disconnects,
 *   waiting the server's `connect_timeout` (30 s unless configured). A failure is still `200`
 *   with `ok: false` and Hermes's sentence — which is **empty** when the server simply never
 *   answered, so the hub names that case itself.
 * - `POST /api/messaging/whatsapp/onboarding/start` starts Hermes's WhatsApp bridge in
 *   pair-only mode; `GET …/{pairing_id}` reports `installing` → `starting` → `waiting` (with
 *   `qr_payload`) → `connected` | `error`, and `410` once the ten minutes are up.
 *   Hermes's own `…/apply` then restarts the gateway with `hermes gateway restart`, which in a
 *   container stops the gateway this hub supervises and starts a second one inside the
 *   dashboard process. So the hub does not call it: it enables the channel with
 *   `PUT /api/messaging/platforms/whatsapp`, the write Hermes makes without a restart, and the
 *   agent picks the channel up at its next restart — the rule every channel change here has.
 */
import { HubError } from '../../lib/errors.js';
import { t, type Language } from '../../i18n/index.js';
import type { JobHandle } from '../audit/index.js';
import { HermesDashboardRefusal, HermesDashboardUnavailable } from './hermes-dashboard.js';

/** One call to Hermes's API. The dashboard's `request`, or a test's fake. */
export type HermesApiCall = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { timeoutMs?: number },
) => Promise<T>;

/** Hermes's default `connect_timeout` for an MCP server (`hermes_cli/mcp_config.py`). */
export const MCP_CONNECT_TIMEOUT_S = 30;
/** How much longer than Hermes's own timeout the hub waits for Hermes's answer. */
export const MCP_TEST_MARGIN_MS = 15_000;

const query = (profile: string) => `profile=${encodeURIComponent(profile)}`;

/**
 * Hermes's errors, as the hub's: a refusal keeps Hermes's sentence, a server that is not there
 * says why. Everything else is left alone.
 */
export function hermesFault(error: unknown): never {
  if (error instanceof HermesDashboardRefusal) {
    throw new HubError('conflict', {
      message: error.message,
      details: { reason: 'hermes_refused', status: error.status, message: error.message },
    });
  }
  if (error instanceof HermesDashboardUnavailable) {
    throw new HubError('service_unavailable', {
      message: error.message,
      details: { reason: 'hermes_api_unavailable', message: error.message },
    });
  }
  throw error;
}

/** The server's own `connect_timeout`, when it set a usable one. */
export function connectTimeoutOf(config: Record<string, unknown>): number {
  const raw = config.connect_timeout;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 1 ? value : MCP_CONNECT_TIMEOUT_S;
}

export interface McpTestResult {
  ok: boolean;
  tools: Array<{ name: string; description: string | null }>;
  error: string | null;
  duration_ms: number;
}

interface HermesMcpAnswer {
  ok?: boolean;
  error?: string | null;
  tools?: Array<{ name?: unknown; description?: unknown }>;
}

/**
 * Ask Hermes to connect once. A connection that failed is an answer (`ok: false`), not an
 * error; only "Hermes refused to try" and "there is no Hermes to ask" are thrown.
 */
export async function testMcpServer(
  api: HermesApiCall,
  input: {
    profile: string;
    name: string;
    config: Record<string, unknown>;
    language: Language;
    now?: () => number;
  },
): Promise<McpTestResult> {
  const now = input.now ?? Date.now;
  const connectS = connectTimeoutOf(input.config);
  const waitMs = connectS * 1000 + MCP_TEST_MARGIN_MS;
  const began = now();
  let answer: HermesMcpAnswer;
  try {
    answer = await api<HermesMcpAnswer>(
      'POST',
      `/api/mcp/servers/${encodeURIComponent(input.name)}/test?${query(input.profile)}`,
      undefined,
      { timeoutMs: waitMs },
    );
  } catch (error) {
    if (error instanceof HermesDashboardUnavailable && error.timedOut) {
      return {
        ok: false,
        tools: [],
        error: t('agents.mcp_test.hermes_silent', input.language).replace(
          '{seconds}',
          String(Math.round(waitMs / 1000)),
        ),
        duration_ms: now() - began,
      };
    }
    return hermesFault(error);
  }
  const ok = answer?.ok === true;
  const said = typeof answer?.error === 'string' ? answer.error.trim() : '';
  return {
    ok,
    tools: ok
      ? (answer.tools ?? [])
          .filter((tool) => typeof tool?.name === 'string')
          .map((tool) => ({
            name: tool.name as string,
            description:
              typeof tool.description === 'string' && tool.description !== ''
                ? tool.description
                : null,
          }))
      : [],
    error: ok
      ? null
      : said ||
        t('agents.mcp_test.no_answer', input.language).replace('{seconds}', String(connectS)),
    duration_ms: now() - began,
  };
}

// ------------------------------------------------------------------ pairing

/** The platforms Hermes pairs by QR from this host. */
export const QR_PLATFORMS = ['whatsapp'] as const;

/** Hermes's `_WhatsAppOnboardingSession` payload (`hermes_cli/web_server_messaging.py`). */
interface HermesPairing {
  pairing_id?: string;
  status?: string;
  qr_payload?: string | null;
  expires_at?: string | null;
  account_id?: string | null;
  account_name?: string | null;
  account_phone?: string | null;
  error?: string | null;
}

export interface PairingOptions {
  profile: string;
  language: Language;
  /** Between two questions to Hermes. Default 1 s. */
  pollMs?: number;
  /** Past Hermes's own expiry, how long the hub keeps asking before it gives up. */
  graceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const LIVE = new Set(['installing', 'starting', 'waiting']);
const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Pair WhatsApp in `profile`: the body of a `channel_login` job.
 *
 * Every change Hermes reports is published as the job's progress — a line for the person, and
 * `{status, qr, expires_at}` in `result` for the screen that draws the code. Paired, the
 * channel is enabled in the profile through Hermes and the job's outcome names the account.
 */
export async function pairWhatsApp(
  api: HermesApiCall,
  handle: JobHandle,
  options: PairingOptions,
): Promise<Record<string, unknown>> {
  const { profile, language } = options;
  const pollMs = options.pollMs ?? 1000;
  const graceMs = options.graceMs ?? 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const base = '/api/messaging/whatsapp/onboarding';

  let state: HermesPairing;
  try {
    state = await api<HermesPairing>('POST', `${base}/start`, { mode: 'bot', profile });
  } catch (error) {
    return hermesFault(error);
  }
  const id = state.pairing_id;
  if (!id) {
    throw new HubError('agent_error', { message: t('jobs.channel_login.no_id', language) });
  }
  const forget = () =>
    api('DELETE', `${base}/${encodeURIComponent(id)}`).catch(() => {
      // Hermes prunes a session it was not told to forget; a failed cleanup is not the news.
    });

  let shown = '';
  for (;;) {
    const status = state.status ?? 'starting';
    if (handle.cancelRequested()) {
      await forget();
      return { status: 'cancelled' };
    }
    if (status === 'connected') break;
    if (status === 'error') {
      await forget();
      throw new HubError('agent_error', {
        message: state.error?.trim() || t('jobs.channel_login.failed', language),
      });
    }
    if (!LIVE.has(status)) {
      // `cancelled` (superseded by a newer pairing of the same account), `expired`, or a
      // status this hub has not heard of: all end the pairing, in Hermes's words when it
      // gave some.
      await forget();
      throw new HubError('state_invalid', {
        message: state.error?.trim() || t('jobs.channel_login.ended', language),
      });
    }
    const qr = typeof state.qr_payload === 'string' && state.qr_payload ? state.qr_payload : null;
    const seen = `${status}\n${qr ?? ''}`;
    if (seen !== shown) {
      shown = seen;
      handle.progress(
        null,
        t(qr ? 'jobs.channel_login.scan' : 'jobs.channel_login.preparing', language),
        { status, qr, expires_at: state.expires_at ?? null },
      );
    }
    const expires = state.expires_at ? Date.parse(state.expires_at) : NaN;
    if (Number.isFinite(expires) && now() > expires + graceMs) {
      await forget();
      throw new HubError('state_invalid', { message: t('jobs.channel_login.expired', language) });
    }

    await sleep(pollMs);
    if (handle.cancelRequested()) continue;
    try {
      state = await api<HermesPairing>('GET', `${base}/${encodeURIComponent(id)}`);
    } catch (error) {
      // 410 is Hermes saying the code expired; 404 that it no longer knows the pairing.
      if (
        error instanceof HermesDashboardRefusal &&
        (error.status === 410 || error.status === 404)
      ) {
        throw new HubError('state_invalid', { message: error.message });
      }
      if (error instanceof HermesDashboardRefusal) {
        throw new HubError('agent_error', { message: error.message });
      }
      throw new HubError('service_unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Paired. Enable the channel the way Hermes's own Channels page does, minus the restart.
  handle.progress(null, t('jobs.channel_login.saving', language), {
    status: 'connected',
    qr: null,
    expires_at: null,
  });
  try {
    await api('PUT', `/api/messaging/platforms/whatsapp?${query(profile)}`, {
      enabled: true,
      env: { WHATSAPP_ENABLED: 'true', WHATSAPP_MODE: 'bot', WHATSAPP_DM_POLICY: 'pairing' },
      profile,
    });
  } catch (error) {
    await forget();
    const said = error instanceof Error ? error.message : String(error);
    throw new HubError('agent_error', {
      message: `${t('jobs.channel_login.not_saved', language)} ${said}`,
    });
  }
  await forget();
  handle.progress(100, t('jobs.channel_login.done', language));
  return {
    status: 'connected',
    account_name: state.account_name ?? null,
    account_phone: state.account_phone ?? null,
  };
}
