/**
 * Signing in to a Google account as the Gemini Desktop app does (DECISIONS §155).
 *
 * Authorization code with PKCE (S256) and a random `state`, the app's own installed-app client,
 * `access_type=offline` and the `flexible-api` scope; then a refresh that mints a token with the
 * service scopes the native calls need. The redirect is the app's loopback address: nothing
 * listens there, the person pastes the address their browser landed on back into the hub, which
 * works from a server whose `localhost` is not the person's. As the owner's plugin does it
 * (`oauth.go`, `native_client.go`, MIT, THIRD-PARTY-NOTICES.md).
 */
import { createHash, randomBytes } from 'node:crypto';

/** The app's installed-app client: shared application configuration, not anybody's token. */
const CLIENT_ID = '839509190550-l232s7lupkp6f57818eshd7u4sl4920h.apps.googleusercontent.com';
const CLIENT_SECRET_SEALED = [
  29, 21, 25, 9, 10, 2, 119, 57, 62, 63, 56, 106, 29, 25, 49, 14, 23, 22, 3, 28, 14, 31, 50, 17, 27,
  105, 107, 42, 50, 28, 25, 24, 8, 41, 52,
];
function clientSecret(): string {
  return Buffer.from(CLIENT_SECRET_SEALED.map((byte) => byte ^ 0x5a)).toString('utf8');
}

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/auth';
export const TOKEN_ENDPOINT = 'https://www.googleapis.com/oauth2/v4/token';
export const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
export const REDIRECT_URI = 'http://localhost:51123/auth';
const FLEXIBLE_SCOPE = 'https://www.googleapis.com/auth/flexible-api';
export const SERVICE_SCOPES = [
  'https://www.googleapis.com/auth/assistant',
  'https://www.googleapis.com/auth/gemini',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gdm-genesis-janus.firstparty',
].join(' ');

/** How long a sign-in waits for its address, and it is used once. */
export const LOGIN_TTL_MS = 10 * 60_000;

/** A failure with the HTTP status the hub answers it as; the message never carries a token. */
export class GeminiDesktopError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiDesktopError';
  }
}

export interface PendingLogin {
  url: string;
  state: string;
  verifier: string;
  expiresAt: number;
  /** Set once an address was accepted (or refused for its `state`): never used again. */
  used: boolean;
}

/** The tokens of one account, as the hub stores them (encrypted, `secrets`). */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  email: string | null;
}

const b64url = (bytes: Buffer) => bytes.toString('base64url');

export function startLogin(now: number = Date.now()): PendingLogin {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: FLEXIBLE_SCOPE,
    access_type: 'offline',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return {
    url: `${AUTH_ENDPOINT}?${query.toString()}`,
    state,
    verifier,
    expiresAt: now + LOGIN_TTL_MS,
    used: false,
  };
}

/**
 * The code and state of a pasted address — the whole `http://localhost:51123/auth?…` address, or
 * only its query. Google's own refusal (`error=access_denied`) is said as such.
 */
export function readCallback(pasted: string): { code: string; state: string } {
  const value = pasted.trim();
  let query: URLSearchParams;
  try {
    query = /^https?:\/\//i.test(value)
      ? new URL(value).searchParams
      : new URLSearchParams(value.replace(/^[^?]*\?/, ''));
  } catch {
    throw new GeminiDesktopError(
      400,
      'the pasted address is not the one Google sent the browser to',
    );
  }
  const refused = query.get('error');
  if (refused) {
    throw new GeminiDesktopError(
      400,
      refused === 'access_denied'
        ? 'the sign-in was declined on Google’s page'
        : `Google refused the sign-in: ${refused.slice(0, 60)}`,
    );
  }
  const code = query.get('code')?.trim() ?? '';
  const state = query.get('state')?.trim() ?? '';
  if (!code || !state) {
    throw new GeminiDesktopError(
      400,
      'the pasted address has no sign-in code; copy the whole address the browser landed on',
    );
  }
  return { code, state };
}

/** Checks a pasted address against its sign-in: right `state`, in time, once. */
export function acceptCallback(
  login: PendingLogin,
  pasted: string,
  now: number = Date.now(),
): string {
  if (login.used)
    throw new GeminiDesktopError(400, 'this sign-in was already used; start a new one');
  if (now >= login.expiresAt) {
    login.used = true;
    throw new GeminiDesktopError(400, 'this sign-in expired; start a new one');
  }
  let read: { code: string; state: string };
  try {
    read = readCallback(pasted);
  } catch (error) {
    // Google's own refusal ends the sign-in; an address with no code may be pasted again.
    if (/[?&]error=/.test(pasted)) login.used = true;
    throw error;
  }
  const { code, state } = read;
  if (state !== login.state) {
    throw new GeminiDesktopError(
      400,
      'this address belongs to another sign-in; paste the address of this one',
    );
  }
  login.used = true;
  return code;
}

type FetchLike = typeof fetch;

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

/** Google's token service. Its body is never repeated: it may name the account. */
async function tokenCall(
  fetchImpl: FetchLike,
  values: Record<string, string>,
  now: () => number,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number; scope: string }> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...values,
        client_id: CLIENT_ID,
        client_secret: clientSecret(),
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GeminiDesktopError(502, 'could not reach Google’s token service');
  }
  let body: TokenAnswer;
  try {
    body = (await response.json()) as TokenAnswer;
  } catch {
    throw new GeminiDesktopError(502, 'Google’s token service answered something that is not JSON');
  }
  if (!response.ok) {
    const known = [
      'invalid_grant',
      'invalid_client',
      'invalid_scope',
      'access_denied',
      'invalid_request',
    ];
    const reason = body.error && known.includes(body.error) ? body.error : 'token request rejected';
    const status =
      body.error === 'invalid_grant' || body.error === 'invalid_client'
        ? 401
        : response.status >= 400 && response.status < 600
          ? response.status
          : 502;
    throw new GeminiDesktopError(status, `Google OAuth: ${reason}`);
  }
  if (!body.access_token || !body.expires_in || body.expires_in <= 0) {
    throw new GeminiDesktopError(502, 'Google returned an incomplete token answer');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: now() + body.expires_in * 1000,
    scope: body.scope ?? '',
  };
}

/** The account's verified e-mail, or why not. */
export async function verifiedEmail(fetchImpl: FetchLike, accessToken: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GeminiDesktopError(502, 'could not retrieve the Google account’s e-mail');
  }
  if (!response.ok)
    throw new GeminiDesktopError(502, 'could not retrieve the Google account’s e-mail');
  let profile: { email?: unknown; verified_email?: unknown };
  try {
    profile = (await response.json()) as typeof profile;
  } catch {
    throw new GeminiDesktopError(502, 'Google answered an unreadable account profile');
  }
  const email = typeof profile.email === 'string' ? profile.email.trim() : '';
  if (
    !email ||
    profile.verified_email !== true ||
    !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email) ||
    email.length > 254
  ) {
    throw new GeminiDesktopError(502, 'Google did not return a verified e-mail for this account');
  }
  return email.toLowerCase();
}

/**
 * The code of an accepted address, exchanged; then a service-scoped token from the same grant,
 * and the account's e-mail. A new sign-in must name its account.
 */
export async function exchange(
  fetchImpl: FetchLike,
  login: PendingLogin,
  code: string,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const first = await tokenCall(
    fetchImpl,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: login.verifier,
    },
    now,
  );
  if (!first.refreshToken) {
    throw new GeminiDesktopError(401, 'Google did not return a refresh token; start a new sign-in');
  }
  const refreshed = await refresh(
    fetchImpl,
    {
      accessToken: first.accessToken,
      refreshToken: first.refreshToken,
      expiresAt: first.expiresAt,
      scope: first.scope,
      email: null,
    },
    now,
  );
  if (!refreshed.email) {
    throw new GeminiDesktopError(502, 'could not tell which Google account signed in; try again');
  }
  return refreshed;
}

/**
 * A new access token with the service scopes. The refresh token Google sends back replaces the
 * stored one; when it sends none the stored one is kept. A failed e-mail lookup never undoes a
 * successful refresh (the rotated token must still be saved); a known e-mail is not asked again.
 */
export async function refresh(
  fetchImpl: FetchLike,
  tokens: TokenSet,
  now: () => number = Date.now,
): Promise<TokenSet> {
  if (!tokens.refreshToken)
    throw new GeminiDesktopError(401, 'the account has no refresh token; sign in again');
  const answer = await tokenCall(
    fetchImpl,
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, scope: SERVICE_SCOPES },
    now,
  );
  const next: TokenSet = {
    accessToken: answer.accessToken,
    refreshToken: answer.refreshToken ?? tokens.refreshToken,
    expiresAt: answer.expiresAt,
    scope: answer.scope,
    email: tokens.email,
  };
  if (!next.email) {
    try {
      next.email = await verifiedEmail(fetchImpl, next.accessToken);
    } catch {
      // Labelled on a later refresh; the refreshed tokens are what matters now.
    }
  }
  return next;
}
