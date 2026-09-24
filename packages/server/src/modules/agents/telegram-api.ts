/**
 * The one question the hub asks Telegram itself: who is the bot behind this token (`getMe`).
 *
 * Linking Telegram is pasting the token @BotFather gave. Before it is stored the hub asks
 * Telegram's Bot API, so a mistyped or revoked token is refused on the spot in Telegram's own
 * words, and the page can name the bot (@username) people will message. Hermes's own onboarding
 * offers a second way — a bot made for you through an outside service — which the hub does not
 * use: the token, and the bot, stay between the person and Telegram.
 */
import { HubError } from '../../lib/errors.js';
import type { TelegramBot } from './channels.js';

/** Telegram's Bot API. A test (or an e2e hub) replaces `fetch`, never this. */
export const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramApiOptions {
  fetchImpl?: typeof fetch;
  /** Telegram's Bot API base; `TELEGRAM_API` unless a test points it elsewhere. */
  base?: string;
  timeoutMs?: number;
}

interface GetMeAnswer {
  ok?: boolean;
  description?: string;
  result?: { id?: number | string; is_bot?: boolean; username?: string; first_name?: string };
}

/**
 * `getMe` for `token`. A token Telegram refuses is `400 validation_failed` with
 * `details.reason = token_rejected` and Telegram's description; no answer is `503
 * service_unavailable`, `telegram_unreachable`. The token never appears in an error or a log.
 */
export async function telegramGetMe(
  token: string,
  options: TelegramApiOptions = {},
): Promise<TelegramBot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.base ?? TELEGRAM_API).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${base}/bot${token}/getMe`, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new HubError('service_unavailable', {
      details: { reason: 'telegram_unreachable' },
    });
  }
  let body: GetMeAnswer = {};
  try {
    body = (await response.json()) as GetMeAnswer;
  } catch {
    // Not Telegram's JSON: a proxy's page, a gateway error.
  }
  if (response.status >= 500 || (!response.ok && body.ok === undefined)) {
    throw new HubError('service_unavailable', {
      details: { reason: 'telegram_unreachable' },
    });
  }
  const result = body.result;
  if (!response.ok || body.ok !== true || !result || result.id === undefined) {
    throw new HubError('validation_failed', {
      details: {
        field: 'token',
        reason: 'token_rejected',
        message: typeof body.description === 'string' ? body.description : null,
      },
    });
  }
  return {
    id: String(result.id),
    username: typeof result.username === 'string' ? result.username : null,
    name: typeof result.first_name === 'string' ? result.first_name : null,
  };
}
