/**
 * "Continue in Core Hub" (contract decision §58): what a channel conversation becomes when a
 * person carries it into a hub chat — the transcript as a Markdown file, and the first
 * message's short summary, both in the person's language.
 *
 * Pure: the conversation comes in as `sessions.listChannelMessages` reads it (§55); nothing
 * here reads Hermes or writes a row. The summary is facts the hub has (the channel, the other
 * party, how many messages, over what time) — not a model's summary, which would cost a turn
 * and could be wrong; the agent reads the whole transcript in the first turn anyway.
 */
import { t, type Language } from '../../i18n/index.js';
import type { ChannelConversation, ChannelMessage } from './channel-conversations.js';

export interface ChannelRead {
  conversation: ChannelConversation;
  items: ChannelMessage[];
  has_more: boolean;
}

/** `telegram` → "Telegram" / «تيليجرام»; a platform without a name of its own, capitalised. */
export function channelLabel(channel: string, language: Language): string {
  const key = `sessions.continue.channels.${channel}`;
  const named = t(key, language);
  return named === key ? channel.charAt(0).toUpperCase() + channel.slice(1) : named;
}

/** Who the conversation is with, as the list names them. */
export function peerOf(conversation: ChannelConversation): string {
  return (
    conversation.peer_name?.trim() ||
    conversation.title?.trim() ||
    conversation.peer_id?.trim() ||
    conversation.id
  );
}

/** `2026-09-25T09:15:00Z` → `2026-09-25 09:15` (UTC, Latin digits: it is a timestamp). */
function stamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 16).replace('T', ' ');
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** The span the messages cover, earliest and latest; the conversation's own when empty. */
function spanOf(read: ChannelRead): { from: string; to: string } {
  const first = read.items[0]?.created_at ?? read.conversation.started_at;
  const last = read.items[read.items.length - 1]?.created_at ?? read.conversation.last_message_at;
  return { from: stamp(first), to: stamp(last) };
}

/** The chat's title: the channel and the other party, as the list shows them. */
export function continuationTitle(read: ChannelRead, language: Language): string {
  return `${channelLabel(read.conversation.channel, language)}: ${peerOf(read.conversation)}`.slice(
    0,
    200,
  );
}

/** The transcript file: a heading with the facts, then every message, oldest first. */
export function transcriptOf(
  read: ChannelRead,
  language: Language,
): { name: string; text: string } {
  const { conversation } = read;
  const channel = channelLabel(conversation.channel, language);
  const peer = peerOf(conversation);
  const agent = t('sessions.continue.agent', language);
  const { from, to } = spanOf(read);
  const lines = [
    `# ${channel} — ${peer}`,
    '',
    fill(t('sessions.continue.facts', language), {
      count: read.items.length,
      from,
      to,
      profile: conversation.profile,
    }),
  ];
  if (conversation.title && conversation.title !== peer) lines.push('', conversation.title);
  if (read.has_more) {
    lines.push(
      '',
      fill(t('sessions.continue.latest_only', language), { count: read.items.length }),
    );
  }
  for (const message of read.items) {
    const who = message.role === 'user' ? peer : agent;
    lines.push('', `**${who}** — ${stamp(message.created_at)} UTC`, '', message.text.trim());
  }
  // A name the file store will keep: the platform and the other party, nothing a path could use.
  const safe = peer.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || conversation.id;
  return { name: `${conversation.channel}-${safe}.md`, text: `${lines.join('\n')}\n` };
}

/** The first message's words: the facts, where the transcript is, and the person's note. */
export function summaryOf(read: ChannelRead, language: Language, note: string | null): string {
  const { from, to } = spanOf(read);
  const values = {
    channel: channelLabel(read.conversation.channel, language),
    peer: peerOf(read.conversation),
    count: read.items.length,
    from,
    to,
  };
  let text = fill(t('sessions.continue.summary', language), values);
  if (read.has_more) {
    text += ` ${fill(t('sessions.continue.latest_only', language), values)}`;
  }
  const extra = note?.trim();
  return extra ? `${text}\n\n${extra}` : text;
}
