/**
 * Signing in to a provider account by device code (contract decision §55).
 *
 * Hermes can sign in to four providers from its own server — Nous Portal, a ChatGPT/Codex
 * subscription, xAI Grok and MiniMax — by the flow every device-code sign-in shares: it asks
 * the provider for a code and a link, the person opens the link and enters the code, and
 * Hermes polls until the provider says yes, then keeps the credential in the Hermes profile the
 * sign-in was started for (MIT source `hermes_cli/web_routers/oauth.py`, read and described in
 * our words here; nothing of it is copied).
 *
 * The hub does not do the exchange itself. It starts Hermes's sign-in, shows Hermes's code and
 * link, and answers each poll with Hermes's state; no token passes through it. What this file
 * holds is that conversation with Hermes's server, and the translation of its words into the
 * contract's `ProviderSignIn`, both pure enough to test against a scripted server.
 */
import { HubError } from '../../lib/errors.js';

/** What starting a sign-in gave back: the code to show and where to enter it. */
export interface SignInStarted {
  /** Hermes's own id for the sign-in; never shown, used to poll. */
  session: string;
  userCode: string | null;
  verificationUrl: string;
  /** Seconds the code is valid for. */
  expiresIn: number;
}

/** How a sign-in stands, in Hermes's words. */
export interface SignInPoll {
  /** `pending`, `approved`, `denied`, `error`, `cancelled` — or `gone` when Hermes forgot it. */
  status: string;
  reason: string | null;
  error: string | null;
}

/** The agent runtime that performs sign-ins, as the models module sees it. */
export interface SignInRuntime {
  start(provider: string, profile: string | null): Promise<SignInStarted>;
  poll(provider: string, session: string, profile: string | null): Promise<SignInPoll>;
  /** The model ids the runtime lists for a signed-in provider; `null` when it lists none. */
  models(provider: string, profile: string | null): Promise<string[] | null>;
  /** Forget the provider's credential in that profile. Best effort. */
  signOut(provider: string, profile: string | null): Promise<void>;
}

/** The one call the runtime is made of: Hermes's server, JSON in and out. */
export type DashboardRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** A refusal from Hermes's server, as `HermesDashboardRefusal` carries it. */
interface RefusalLike {
  name: string;
  status?: number;
  message: string;
  timedOut?: boolean;
}

const profileQuery = (profile: string | null, extra: Record<string, string> = {}): string => {
  const params = new URLSearchParams(extra);
  if (profile) params.set('profile', profile);
  const text = params.toString();
  return text ? `?${text}` : '';
};

/**
 * Hermes's errors, as the contract's: its server not running (or not answering) is
 * `service_unavailable`; a refusal is Hermes's own sentence under `state_invalid`, because
 * what Hermes refuses is the state of the sign-in, never the request the person made.
 */
export function signInError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  const refusal = error as RefusalLike;
  if (refusal?.name === 'HermesDashboardUnavailable') {
    return new HubError('service_unavailable', {
      message: refusal.message,
      details: { reason: 'hermes_unreachable' },
    });
  }
  if (refusal?.name === 'HermesDashboardRefusal') {
    return new HubError('state_invalid', {
      message: refusal.message,
      details: { reason: 'hermes_refused', status: refusal.status ?? null },
    });
  }
  return new HubError('service_unavailable', {
    message: error instanceof Error ? error.message : 'Hermes could not be asked',
    details: { reason: 'hermes_unreachable' },
  });
}

/** The sign-in runtime over Hermes's server (ADR 0015). */
export function hermesSignInRuntime(request: DashboardRequest): SignInRuntime {
  return {
    async start(provider, profile) {
      let body: Record<string, unknown>;
      try {
        body = await request<Record<string, unknown>>(
          'POST',
          `/api/providers/oauth/${encodeURIComponent(provider)}/start${profileQuery(profile)}`,
        );
      } catch (error) {
        throw signInError(error);
      }
      const session = typeof body.session_id === 'string' ? body.session_id : '';
      const verificationUrl =
        typeof body.verification_url === 'string' ? body.verification_url : '';
      if (!session || !verificationUrl) {
        throw new HubError('service_unavailable', {
          message: 'Hermes started no sign-in: it sent back no code and no link',
          details: { reason: 'hermes_unreachable' },
        });
      }
      return {
        session,
        userCode: typeof body.user_code === 'string' && body.user_code ? body.user_code : null,
        verificationUrl,
        expiresIn:
          typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900,
      };
    },

    async poll(provider, session, profile) {
      try {
        const body = await request<Record<string, unknown>>(
          'GET',
          `/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(session)}${profileQuery(profile)}`,
        );
        return {
          status: typeof body.status === 'string' ? body.status : 'pending',
          reason: typeof body.reason === 'string' ? body.reason : null,
          error: typeof body.error_message === 'string' ? body.error_message : null,
        };
      } catch (error) {
        // Hermes forgets a sign-in fifteen minutes after it started (or when it restarts).
        if ((error as RefusalLike)?.status === 404) {
          return { status: 'gone', reason: null, error: null };
        }
        throw signInError(error);
      }
    },

    async models(provider, profile) {
      let body: { providers?: Array<{ slug?: unknown; models?: unknown }> };
      try {
        body = await request(
          'GET',
          `/api/model/options${profileQuery(profile, { refresh: 'true' })}`,
        );
      } catch (error) {
        throw signInError(error);
      }
      const row = (body.providers ?? []).find((each) => each.slug === provider);
      if (!row || !Array.isArray(row.models)) return null;
      return row.models.filter((model): model is string => typeof model === 'string' && !!model);
    },

    async signOut(provider, profile) {
      await request(
        'DELETE',
        `/api/providers/oauth/${encodeURIComponent(provider)}${profileQuery(profile)}`,
      ).catch(() => undefined);
    },
  };
}

/** The contract's `ProviderSignIn.status`. */
export type SignInStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'failed';

/**
 * Hermes's state as the contract's (decision §55). A code that ran out — Hermes's `timeout`, a
 * sign-in Hermes no longer knows, or the clock past `expires_at` — is `expired`; the person
 * saying no is `denied`; everything else that ended without a credential is `failed`.
 */
export function signInStatusOf(poll: SignInPoll, expired: boolean): SignInStatus {
  switch (poll.status) {
    case 'approved':
      return 'approved';
    case 'denied':
      return 'denied';
    case 'pending':
      return expired ? 'expired' : 'pending';
    case 'gone':
      return 'expired';
    case 'error':
      return poll.reason === 'timeout' ? 'expired' : 'failed';
    default:
      return 'failed';
  }
}
