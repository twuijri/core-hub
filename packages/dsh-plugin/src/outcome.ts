/**
 * What a `/corehub` or `/hermes` command hands back to the chat, and how the plugin's own chat
 * view reads it again.
 *
 * The harness logs a command's result text (`command/done`) and renders it in the chat. The
 * plugin's browser half replaces that row for its two commands (`conversation.chat.commandview`,
 * keyed by command name) with a readable card. The card needs two facts the text alone does not
 * carry: which sub-command ran (`/corehub` does not record its input, because a pairing code is
 * a secret) and the language the plugin answered in. Both ride in the first line as a Markdown
 * link reference definition (`[//]: # (corehub link ar)`), which every Markdown renderer shows as
 * nothing, so a client without the plugin's view still shows a readable text.
 *
 * Pure: shared by the host half (writing) and the browser half (reading).
 */

export type OutcomeLanguage = 'en' | 'ar';

export interface OutcomeMeta {
  /** The command (`corehub`, `hermes`). */
  command: string;
  /** The sub-command (`link`, `status`, `models`, `unlink`, `help`), or `ask` for `/hermes`. */
  sub: string;
  language: OutcomeLanguage;
}

const MARKER = /^\[\/\/\]: # \(([a-z][a-z0-9_-]*) ([a-z][a-z0-9_-]*) (en|ar)\)[ \t]*(?:\r?\n|$)/;

/** The result text: the marker line, a blank line, then the Markdown body. */
export function encodeOutcome(meta: OutcomeMeta, body: string): string {
  const command = safeWord(meta.command);
  const sub = safeWord(meta.sub);
  return `[//]: # (${command} ${sub} ${meta.language})\n\n${body}`;
}

/** The marker (when the text has one) and the body without it. */
export function decodeOutcome(text: string | null | undefined): {
  meta: OutcomeMeta | null;
  body: string;
} {
  const raw = text ?? '';
  const match = MARKER.exec(raw);
  if (!match) return { meta: null, body: raw };
  return {
    meta: {
      command: match[1] ?? '',
      sub: match[2] ?? '',
      language: match[3] === 'ar' ? 'ar' : 'en',
    },
    body: raw.slice(match[0].length).replace(/^\s*\n/, ''),
  };
}

/** The echo of the command the person typed, with a pairing code never shown. */
export function commandEcho(command: string, sub: string | null, args: string | null): string {
  if (args !== null && args.trim()) return `/${command} ${args.trim()}`;
  if (!sub) return `/${command}`;
  return sub === 'link' ? `/${command} link ••••` : `/${command} ${sub}`;
}

function safeWord(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return /^[a-z]/.test(w) ? w : `x${w}`;
}
