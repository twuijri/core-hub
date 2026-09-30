/**
 * The "Send message" step (DECISIONS §124): a `notify` node with `send` delivers its words to
 * Telegram and/or a Core Hub conversation. Pure pieces here — splitting a long text, calling
 * Telegram's Bot API, reading a target — and the step itself in `workflow-engine.ts`.
 *
 * Nothing claims success without the platform's own id for what it took. A step that is tried
 * again (a retry, a rerun from a step) does not send twice: each part sent is written down by
 * the run it belongs to, the node, the target and the part (`workflow_sent_parts`).
 */
import type { WorkflowSend, WorkflowSendTarget } from './schema.js';
import { formattingOf } from './telegram-format.js';

/** Telegram's limit for one message's text, in UTF-16 code units (what `String#length` counts). */
export const TELEGRAM_MAX_CHARS = 4096;
/** The platforms a target may name today; the contract keeps it a plain string. */
export const SEND_PLATFORMS = ['telegram', 'core_hub'] as const;

/**
 * Cut a text into parts of at most `max` UTF-16 units, at the last paragraph break, else the
 * last line break, else the last space, before the limit; a single run of characters longer
 * than the limit is cut where it must, never inside a surrogate pair (an emoji, a rare
 * character). Arabic text is cut on the same boundaries: nothing here depends on the script.
 */
export function splitMessage(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 4) cut = window.lastIndexOf('\n');
    if (cut < max / 4) cut = window.lastIndexOf(' ');
    if (cut < max / 4) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      // A high surrogate at the edge belongs with the low one after it.
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    const part = rest.slice(0, cut).trimEnd();
    if (part) parts.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Invisible marks a chat id picks up when it is copied out of right-to-left text (LRM, RLM,
 * the isolates, zero-width spaces, a no-break space): Telegram would answer "chat not found"
 * for an id that looks right on screen.
 */
const INVISIBLE = /[\s\u00a0\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** A Telegram chat id as typed, without spaces or invisible direction marks. */
export function chatIdOf(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(INVISIBLE, '') : '';
}

/** A target's stable name: `telegram:<chat_id>`, `core_hub:<session_id>`. */
export function targetKey(target: WorkflowSendTarget): string {
  if (target.platform === 'telegram') return `telegram:${chatIdOf(target.chat_id)}`;
  if (target.platform === 'core_hub') return `core_hub:${target.session_id ?? ''}`;
  return `${target.platform}:`;
}

/** What is wrong with a send, as reason codes for the workflow check (`send_*`). */
export function sendProblems(send: WorkflowSend): Array<{ code: string; index: number | null }> {
  const out: Array<{ code: string; index: number | null }> = [];
  const targets = Array.isArray(send.targets) ? send.targets : [];
  if (targets.length === 0) out.push({ code: 'send_no_target', index: null });
  targets.forEach((target, index) => {
    // Telegram formatting (§137): plain, html or markdown_v2 — nothing else ever reaches Telegram.
    if (formattingOf(target.formatting) === null) {
      out.push({ code: 'send_formatting_unknown', index });
    } else if (!(SEND_PLATFORMS as readonly string[]).includes(target.platform)) {
      out.push({ code: 'send_platform_unknown', index });
    } else if (target.platform === 'telegram' && !chatIdOf(target.chat_id)) {
      out.push({ code: 'send_chat_missing', index });
    } else if (target.platform === 'core_hub' && !target.session_id && !target.agent_id) {
      out.push({ code: 'send_conversation_missing', index });
    }
  });
  return out;
}

export function hasSend(send: WorkflowSend | null | undefined): send is WorkflowSend {
  return !!send && typeof send === 'object' && Array.isArray(send.targets);
}

/**
 * What Telegram did with one message. A refusal carries a short `code` for the hub's log:
 * Telegram's own `error_code` (`400`, `403`…), `timeout`, or `unreachable`.
 */
export type TelegramAnswer =
  { ok: true; messageId: string } | { ok: false; reason: string; code: string };

/** How long one `sendMessage` may take before it counts as failed. */
export const TELEGRAM_TIMEOUT_MS = 20_000;

/** `text` with every copy of the bot token cut out, so no reason or log line carries it. */
export function withoutToken(text: string, token: string): string {
  return token ? text.split(token).join('…') : text;
}

/** Why a fetch failed, with its cause (Node's `fetch failed` alone names nothing). */
function reachFailure(error: unknown): { said: string; timeout: boolean } {
  const err = error instanceof Error ? error : new Error(String(error));
  const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
  const cause = (err as { cause?: unknown }).cause;
  const detail =
    cause instanceof Error
      ? [(cause as { code?: unknown }).code, cause.message].filter(Boolean).join(' ')
      : typeof cause === 'string'
        ? cause
        : '';
  return {
    said: detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message,
    timeout,
  };
}

/**
 * One `sendMessage` through the Bot API. The token goes in the path, as Telegram asks; it is
 * never written to a log or a reason. A refusal is Telegram's own `description`. `parseMode`
 * (§137) is written only when there is one: a plain message carries no `parse_mode` field.
 */
export async function telegramSend(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  chatId: string,
  text: string,
  timeoutMs: number = TELEGRAM_TIMEOUT_MS,
  parseMode: 'HTML' | 'MarkdownV2' | null = null,
): Promise<TelegramAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiBase.replace(/\/$/, '')}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const { said, timeout } = reachFailure(error);
    return {
      ok: false,
      code: timeout ? 'timeout' : 'unreachable',
      reason: timeout
        ? `Telegram did not answer within ${Math.round(timeoutMs / 1000)} s`
        : `Telegram could not be reached (${withoutToken(said, token)})`,
    };
  }
  let body: {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
    error_code?: number;
  } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (body.ok === true && body.result?.message_id !== undefined) {
    return { ok: true, messageId: String(body.result.message_id) };
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  return {
    ok: false,
    code: String(body.error_code ?? response.status),
    reason: withoutToken(description || `Telegram answered ${response.status}`, token),
  };
}

/**
 * What one target of a send did (`WorkflowSendTargetResult`, §137): where, with which Telegram
 * formatting, how many parts the words were sent in, the platform's ids, and why not.
 */
export interface SendTargetResult {
  target: string;
  platform: string;
  chat_id: string | null;
  session_id: string | null;
  /** `plain`, `html` or `markdown_v2` for Telegram; `null` for a conversation. */
  formatting: string | null;
  /** The `parse_mode` sent: `HTML`, `MarkdownV2`, or `null` (plain: no field at all). */
  parse_mode: string | null;
  status: 'sent' | 'failed';
  message_ids: string[];
  parts_count: number;
  reason: string | null;
}

/** What a send did — the step's `output` and `WorkflowSendResult`. */
export interface SendResult {
  status: 'sent' | 'partial' | 'failed';
  message_id: string | null;
  message_ids: string[];
  delivered_to: string[];
  failures: Array<{ target: string; reason: string }>;
  /** The (first) Telegram target's formatting, `parse_mode`, chat and parts (§137); null without one. */
  formatting: string | null;
  parse_mode: string | null;
  chat_id: string | null;
  parts_count: number | null;
  targets: SendTargetResult[];
}

export function resultOf(
  delivered: Array<{ target: string; ids: string[] }>,
  failures: Array<{ target: string; reason: string }>,
  targets: SendTargetResult[] = [],
): SendResult {
  const ids = delivered.flatMap((each) => each.ids);
  const telegram = targets.find((each) => each.platform === 'telegram') ?? null;
  return {
    status:
      failures.length === 0 && delivered.length > 0
        ? 'sent'
        : delivered.length > 0
          ? 'partial'
          : 'failed',
    message_id: ids[0] ?? null,
    message_ids: ids,
    delivered_to: delivered.map((each) => each.target),
    failures,
    formatting: telegram?.formatting ?? null,
    parse_mode: telegram?.parse_mode ?? null,
    chat_id: telegram?.chat_id ?? null,
    parts_count: telegram ? telegram.parts_count : null,
    targets,
  };
}
