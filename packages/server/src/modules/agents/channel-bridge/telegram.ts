/**
 * Telegram's Bot API `sendMessage`, for the words a person writes into a conversation from the
 * hub (contract decision §153). Plain text — the person's words as they typed them — cut into
 * parts Telegram takes (4 096 UTF-16 units each), in the chat and the forum topic
 * (`message_thread_id`) the conversation is in. The token is never in a reason or a log line.
 */
import type { MirrorResult } from './mirror.js';

export const TELEGRAM_MAX_CHARS = 4096;

export interface TelegramPost {
  chatId: string;
  text: string;
  threadId: string | null;
}

/** Parts of at most `max` units, cut at a line break or a space where there is one. */
export function telegramParts(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n');
    if (cut < max / 4) cut = window.lastIndexOf(' ');
    if (cut < max / 4) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

const withoutToken = (text: string, token: string) => (token ? text.split(token).join('…') : text);

export async function telegramSendMessage(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  post: TelegramPost,
  timeoutMs: number,
): Promise<MirrorResult> {
  const thread = post.threadId && /^-?\d+$/.test(post.threadId) ? Number(post.threadId) : null;
  for (const part of telegramParts(post.text)) {
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: post.chatId,
          text: part,
          ...(thread !== null ? { message_thread_id: thread } : {}),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        message:
          err.name === 'TimeoutError' || err.name === 'AbortError'
            ? `Telegram did not answer within ${Math.round(timeoutMs / 1000)} s`
            : withoutToken(`Telegram could not be reached (${err.message})`, token),
      };
    }
    let body: { ok?: unknown; description?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = {};
    }
    if (body.ok !== true) {
      const said = typeof body.description === 'string' ? body.description.trim() : '';
      return {
        ok: false,
        message: withoutToken(said || `Telegram answered ${String(response.status)}`, token),
      };
    }
  }
  return { ok: true };
}
