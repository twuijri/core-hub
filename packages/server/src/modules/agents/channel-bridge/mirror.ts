/**
 * Posting a message written from the hub on its channel, before the agent hears it (contract
 * decision §153): the person on the other end sees who wrote it.
 *
 * Not through Hermes's own `hermes send` / `send_message`: those write what they send into the
 * conversation as the agent's message (`gateway/mirror.py`, role `assistant`), so the agent would
 * read the words twice — once as its own — and a provider that wants turns to alternate would
 * refuse the next one. Instead, the way Hermes's own out-of-process senders do:
 * - Telegram: the Bot API's `sendMessage` with the profile's bot token, in the chat (and forum
 *   topic) the conversation is in. A bot does not receive its own messages, so nothing loops.
 * - WhatsApp (the bridge the hub runs, a linked phone): the profile's bridge on the loopback,
 *   `POST /send {chatId, message}` — what Hermes's adapter itself calls. The bridge remembers
 *   what it sent and drops the echo, so nothing loops either. In self-chat mode the bridge puts
 *   the agent's reply title in front of everything it sends, this too.
 */
import { telegramSendMessage, type TelegramPost } from './telegram.js';

export interface MirrorTarget {
  platform: string;
  chatId: string;
  threadId: string | null;
}

export type MirrorResult = { ok: true } | { ok: false; message: string };

export interface MirrorDeps {
  fetchImpl: typeof fetch;
  telegramApi: string;
  /** The profile's bot token; `null` when it has none. */
  telegramToken(): string | null;
  /** The port the profile's WhatsApp bridge listens on. */
  whatsappPort(): number;
  timeoutMs?: number;
}

/** A bare phone number as the bridge wants it (`<digits>@s.whatsapp.net`); a JID as it is. */
export function whatsappJid(value: string): string {
  const id = value.trim();
  if (id.includes('@')) {
    const [user = '', domain = ''] = id.split('@');
    return `${user.split(':')[0]}@${domain}`;
  }
  const digits = id.replace(/\D+/g, '');
  return /^\+?[\d\s().-]+$/.test(id) && digits ? `${digits}@s.whatsapp.net` : id;
}

export async function postMirror(
  target: MirrorTarget,
  text: string,
  deps: MirrorDeps,
): Promise<MirrorResult> {
  const timeoutMs = deps.timeoutMs ?? 20_000;
  if (target.platform === 'telegram') {
    const token = deps.telegramToken();
    if (!token) return { ok: false, message: 'this profile has no Telegram bot' };
    const post: TelegramPost = {
      chatId: target.chatId,
      text,
      threadId: target.threadId,
    };
    return telegramSendMessage(deps.fetchImpl, deps.telegramApi, token, post, timeoutMs);
  }
  if (target.platform === 'whatsapp') {
    const port = deps.whatsappPort();
    let response: Response;
    try {
      response = await deps.fetchImpl(`http://127.0.0.1:${String(port)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: whatsappJid(target.chatId), message: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        message:
          err.name === 'TimeoutError' || err.name === 'AbortError'
            ? `WhatsApp's bridge did not answer within ${Math.round(timeoutMs / 1000)} s`
            : `WhatsApp's bridge could not be reached (${err.message})`,
      };
    }
    let body: { success?: unknown; error?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = {};
    }
    if (response.ok && body.success === true) return { ok: true };
    return {
      ok: false,
      message:
        typeof body.error === 'string' && body.error.trim()
          ? body.error.trim()
          : `WhatsApp's bridge answered ${String(response.status)}`,
    };
  }
  return { ok: false, message: `${target.platform} is not supported` };
}
