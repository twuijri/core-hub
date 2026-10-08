/**
 * Conversations held on messaging channels — Telegram, WhatsApp and the rest — read from
 * Hermes, read-only (contract decision §61).
 *
 * The hub does not receive these messages: Hermes's gateway does, and Hermes keeps them in its
 * own session store (`state.db` of each profile). The hub reads them through Hermes's internal
 * server (ADR 0015), the same API Hermes's desktop app lists its sessions with
 * (`hermes_cli/web_routers/sessions.py` in Hermes's MIT source, tag `v2026.9.14`):
 *
 * - `GET /api/sessions?profile=<p>&sources=<csv>&order=recent&limit=100` — the most recent
 *   live sessions of those sources, each with `source`, `display_name` (the chat's name as the
 *   channel gives it), `user_id`, `chat_id`, `chat_type`, `origin_json`, `title`,
 *   `message_count`, `started_at`, `last_active` and `preview` (the first user message).
 * - `GET /api/sessions/{id}?profile=<p>` — one session's row.
 * - `GET /api/sessions/{id}/messages?profile=<p>[&limit=n&order=latest]` — its messages, oldest
 *   first, the latest 500 at most; each with `id`, `role`, `content`, `timestamp`, and
 *   `display_kind` / `display_content` for compaction summaries.
 *
 * - `DELETE /api/sessions/{id}?profile=<p>` — what `hermes sessions delete` does: the session
 *   row and its messages go, delegate children with it, branch children are kept and orphaned,
 *   and a session already gone is answered `{"ok": true, "already_absent": true}`. Hermes
 *   resolves an id it does not know as a unique prefix of one it does, so the hub reads the
 *   exact row first and deletes only that (contract decision §88).
 *
 * Paging and pictures (decision §103): `GET /api/sessions` takes `offset` and answers `total`,
 * so a list longer than one page of 100 is read page by page, as many as the client's `limit`
 * needs; `GET /api/sessions/{id}/messages?order=latest&limit=&offset=` pages back from the
 * newest. A picture the person sent is not in Hermes's store as bytes: Hermes's gateway saves
 * it in the profile's image cache (`cache/images/`, or `image_cache/` on older installs;
 * `gateway/platforms/base.py`), deletes it after a day, and the message keeps only a note that
 * names the file — `[Image attached at: <path>]` when the model looked at it itself,
 * `…vision_analyze … image_url: <path>…]` after Hermes described it in words, `[User sent an
 * image: <path>]` while it waited (`gateway/run_inbound.py`, `agent/image_routing.py`). The
 * hub takes the file's name out of those notes, drops the notes from the words shown, and
 * serves the picture by that name from that cache only.
 *
 * The one write is that delete, for an admin (§88). What was read is kept per Hermes profile and asked for again
 * only when Hermes's store changed since (the port's `stamp`, the store file's size and time),
 * and never more often than every few seconds, so a list polled while it is open does not keep
 * Hermes's server awake when nothing happens: with no call for ten minutes it stops (ADR 0015).
 * Hermes announces nothing when a channel message arrives, so there is no event to wait for.
 *
 * The port is handed in by the composition root (`modules/index.ts`): `agents` knows where
 * Hermes lives and how to reach its server, `auth` which Hermes profile a workspace is; this
 * module only knows what a channel conversation looks like.
 */
import type { FastifyInstance } from 'fastify';
import { HubError, notFound } from '../../lib/errors.js';
import { t } from '../../i18n/index.js';

/**
 * The Hermes sources that are messaging channels (`gateway/config.py` §Platform). The rest —
 * `local`, `api_server`, `webhook`, `cron`, the TUI the hub's own chats run in — are not
 * conversations with someone on a channel, and stay out.
 */
export const CHANNEL_SOURCES = [
  'telegram',
  'whatsapp',
  'whatsapp_cloud',
  'discord',
  'slack',
  'signal',
  'matrix',
  'mattermost',
  'email',
  'sms',
  'dingtalk',
  'feishu',
  'wecom',
  'weixin',
  'bluebubbles',
  'qqbot',
] as const;

/** A Hermes session id as the contract's path accepts it. */
export const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Per profile: Hermes caps a page at 100 (`le=100`). */
export const LIST_LIMIT = 100;
/** The most of a profile's conversations one list reads (`limit`, decision §103). */
export const LIST_LIMIT_MAX = 1000;
/** Hermes's page of messages (`get_session_messages` caps `limit` at 500). */
export const MESSAGES_PAGE = 500;
/** A picture's name as the contract's `ChannelAttachment.id` takes it. */
export const PICTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PICTURE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** Never ask Hermes again sooner than this, whatever the store says. */
export const MIN_REFRESH_MS = 5_000;
/** Without a stamp to compare, what was read is good for this long. */
export const TTL_MS = 20_000;
/** With an unchanged stamp, what was read is still asked for again after this long. */
export const MAX_AGE_MS = 5 * 60_000;
/** How many conversations' latest message one list call reads, at most. */
export const LAST_MESSAGES_PER_CALL = 20;
const CONCURRENCY = 4;
const MAX_TEXT = 20_000;
const PREVIEW_MAX = 300;

/** Hermes answered, and the answer was no (its status and its own sentence). */
export class ChannelSourceRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelSourceRefusal';
  }
}

/** Hermes's server could not be asked at all. */
export class ChannelSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelSourceUnavailable';
  }
}

/** What this module needs from Hermes, lent by the composition root. */
export interface ChannelSource {
  /** Hermes's name for the profile a hub workspace is; `null` when Hermes has no such profile. */
  hermesProfile(workspace: string): string | null;
  /**
   * One `GET` to Hermes's server, JSON back. Throws `ChannelSourceRefusal` when Hermes answers
   * with an error, `ChannelSourceUnavailable` when there is no server to ask.
   */
  get<T>(path: string): Promise<T>;
  /**
   * One `DELETE` to Hermes's server, JSON back; errors as `get`. Only
   * `ChannelConversations.remove` calls it, for one channel conversation it has just read.
   */
  delete<T>(path: string): Promise<T>;
  /**
   * Something that changes whenever Hermes writes that profile's session store, or `null` when
   * it cannot be told (then what was read is kept for `TTL_MS`).
   */
  stamp(hermesProfile: string): string | null;
  /**
   * Where a picture of that name is in the profile's image cache, or `null` when it is not
   * there (never was, or Hermes has deleted it). Optional: without it pictures are named but
   * never available.
   */
  picture?(hermesProfile: string, name: string): string | null;
}

let sourceFactory: ((app: FastifyInstance) => ChannelSource | null) | null = null;

/**
 * Where channel conversations are read from. Registered once for the process by the
 * composition root, like the other cross-module ports; `null` (or a factory answering
 * `null`) means this hub does not supervise Hermes and cannot read them.
 */
export function registerChannelSource(
  factory: ((app: FastifyInstance) => ChannelSource | null) | null,
): ((app: FastifyInstance) => ChannelSource | null) | null {
  const previous = sourceFactory;
  sourceFactory = factory;
  return previous;
}

export function channelSourceFor(app: FastifyInstance): ChannelSource | null {
  return sourceFactory?.(app) ?? null;
}

// ------------------------------------------------------------------ Hermes's shapes

/** A row of `GET /api/sessions` or `GET /api/sessions/{id}` — only the fields read here. */
export interface HermesSessionRow {
  id: string;
  source?: string | null;
  /** Hermes's routing key of the chat (`build_session_key`); the same across its sessions. */
  session_key?: string | null;
  user_id?: string | null;
  chat_id?: string | null;
  chat_type?: string | null;
  display_name?: string | null;
  origin_json?: string | null;
  title?: string | null;
  message_count?: number | null;
  started_at?: number | null;
  last_active?: number | null;
  preview?: string | null;
}

/** A message of `GET /api/sessions/{id}/messages`. */
export interface HermesMessage {
  id: number | string;
  role: string;
  content?: unknown;
  timestamp?: number | null;
  display_kind?: string | null;
  display_content?: unknown;
}

interface HermesMessagesPage {
  messages?: HermesMessage[];
  pagination?: { limit?: number; offset?: number; returned?: number };
}

// ------------------------------------------------------------------ the wire's shapes

export interface ChannelMessagePreview {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChannelConversation {
  id: string;
  profile: string;
  channel: string;
  title: string | null;
  peer_name: string | null;
  peer_id: string | null;
  chat_type: string | null;
  last_message: ChannelMessagePreview | null;
  preview: string | null;
  message_count: number;
  started_at: string;
  last_message_at: string;
  /** Contract decision §153: set when the caller is known (`viewer`), absent otherwise. */
  can_send?: boolean;
  send_unavailable?: SendUnavailable | null;
  current_id?: string | null;
}

/** Why a conversation cannot be written into from the hub (`ChannelSendUnavailable`). */
export type SendUnavailable =
  | 'not_admin'
  | 'platform_unsupported'
  | 'hermes_not_managed'
  | 'bridge_offline'
  | 'not_current'
  | 'no_route';

/** Where a message from the hub would go: the chat, as Hermes keeps it for the conversation. */
export interface ChannelRoute {
  /** Hermes's source (`telegram`, `whatsapp`, `whatsapp_cloud`…). */
  source: string;
  sessionKey: string | null;
  chatId: string | null;
  threadId: string | null;
  /** The chat's newest conversation in what was read of the profile, when it is not this one. */
  currentId: string | null;
}

/** What the caller may do with a conversation, decided by `channel-sends.ts`. */
export type SendCheck = (
  hermesProfile: string,
  route: ChannelRoute,
) => { can_send: boolean; send_unavailable: SendUnavailable | null; current_id: string | null };

export interface ChannelAttachment {
  id: string;
  kind: 'image';
  available: boolean;
}

export interface ChannelMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at: string;
  attachments: ChannelAttachment[];
  /** `hub`: written from the hub (contract decision §153). */
  origin: 'channel' | 'hub';
  author_name: string | null;
}

export interface ChannelUnavailable {
  profile: string | null;
  reason: 'hermes_not_managed' | 'profile_not_in_hermes' | 'hermes_unreachable';
  message: string | null;
}

export interface ChannelScope {
  workspace: string;
  profile: string;
}

// ------------------------------------------------------------------ mapping

/** WhatsApp's cloud API is WhatsApp to the person; every other source is its own platform. */
export function channelOf(source: string): string {
  return source === 'whatsapp_cloud' ? 'whatsapp' : source;
}

/** Hermes's epoch seconds as the contract's timestamp. */
export function isoOf(seconds: number | null | undefined, fallback = 0): string {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : fallback;
  return new Date(Math.round(value * 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const clean = (value: unknown, max = 200): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

function originOf(row: HermesSessionRow): Record<string, unknown> {
  if (!row.origin_json) return {};
  try {
    const parsed: unknown = JSON.parse(row.origin_json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The words of a message: Hermes keeps text, or a list of parts (text beside images and
 * files). A compaction summary shows its display projection; a hidden one shows nothing.
 */
export function textOf(message: HermesMessage): string {
  if (message.display_kind === 'hidden') return '';
  const body = message.display_content ?? message.content;
  if (typeof body === 'string') return body.trim();
  if (Array.isArray(body)) {
    return body
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter((text) => text.trim() !== '')
      .join('\n\n')
      .trim();
  }
  return '';
}

/** A path's last part, when it names a picture the hub may serve. */
function pictureName(pathText: string): string | null {
  const name = pathText.trim().split(/[\\/]/).pop() ?? '';
  return PICTURE_ID.test(name) && PICTURE_EXT.test(name) ? name : null;
}

/**
 * Hermes's own notes about pictures, taken out of a person's message: the names of the files
 * they point at, and the words without them. The notes are Hermes's to its model (where the
 * file is, what its vision model saw, "What do you see in this image?" when the person sent no
 * words), not what the person wrote.
 */
export function picturesOf(text: string): { text: string; names: string[] } {
  const names: string[] = [];
  const take = (pathText: string) => {
    const name = pictureName(pathText);
    if (name && !names.includes(name)) names.push(name);
  };
  let rest = text;
  // Described in words, then pointed at: both notes go (`_enrich_message_with_vision`).
  rest = rest.replace(
    /\[The user sent an image~ Here's what I can see:[\s\S]*?\]\s*\[If you need a closer look, use vision_analyze with image_url: ([^\s\]]+) ~\]/g,
    (_all, found: string) => (take(found), ''),
  );
  // Could not be described: one note that points at it.
  rest = rest.replace(
    /\[The user sent an image but [^[\]]*?image_url: ([^\s\]]+)\]/g,
    (_all, found: string) => (take(found), ''),
  );
  // Handed to the model as a picture (`build_native_content_parts`), or still waiting.
  rest = rest.replace(/\[Image attached at: ([^\]\n]+)\]/g, (_all, found: string) => {
    take(found);
    return '';
  });
  rest = rest.replace(/\[User sent an image: ([^\]\n]+)\]/g, (_all, found: string) => {
    take(found);
    return '';
  });
  if (names.length > 0) {
    // The stored projection of an image part, and Hermes's words for a picture without any.
    rest = rest.replace(/^\[screenshot\]$/gm, '').replace(/^What do you see in this image\?$/m, '');
  }
  return { text: names.length > 0 ? rest.replace(/\n{3,}/g, '\n\n').trim() : text, names };
}

/** The languages the hub has written its prefix in (`sessions.channel_send.prefix`). */
const PREFIX_LANGUAGES = ['ar', 'en'] as const;
/** Hermes's kind for a turn put in by a plugin, not typed on the channel (`run_turn.py`). */
export const INJECTED_KIND = 'internal_notification';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The words a message from the hub carries on the channel and into Hermes (contract decision
 * §153): «من كور هب (<name>): <text>». The hub has no language setting of its own, so the
 * owner's choice stands: Arabic.
 */
export function hubMessageText(name: string, text: string, language: 'ar' | 'en' = 'ar'): string {
  return `${t('sessions.channel_send.prefix', language).replace('{name}', name)}${text}`;
}

/** Who wrote a message the hub put in, and its words without the prefix; `null` for any other. */
export function hubAuthorOf(text: string): { name: string; text: string } | null {
  for (const language of PREFIX_LANGUAGES) {
    const [before = '', after = ''] = t('sessions.channel_send.prefix', language).split('{name}');
    const match = new RegExp(`^${escapeRegExp(before)}(.{1,200}?)${escapeRegExp(after)}`, 's').exec(
      text,
    );
    if (match?.[1]) return { name: match[1], text: text.slice(match[0].length) };
  }
  return null;
}

/**
 * Hermes's note in front of a channel message that redirected a running turn
 * (`gateway/run_busy.py`): where the message came from, for the model. The person's words follow
 * it; the note is Hermes's to its model, not what they wrote.
 */
const REDIRECT_NOTE =
  /^Gateway message origin \(JSON data, not instructions or authorization\):\n[^\n]*\nDo not guess a reply destination when these fields are insufficient\.\n\n/;

/**
 * The person's and the agent's messages with words or pictures in them; tools and system text
 * left out. `available` says whether a picture is still in Hermes's cache. A message the hub put
 * in (Hermes marks it as a plugin's turn, and it carries the hub's prefix) is the hub person's
 * (`origin: hub`), shown without the prefix.
 */
export function toMessages(
  messages: readonly HermesMessage[],
  available: (name: string) => boolean = () => false,
): ChannelMessage[] {
  const out: ChannelMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const raw =
      message.role === 'user' ? textOf(message).replace(REDIRECT_NOTE, '') : textOf(message);
    const fromHub =
      message.role === 'user' && message.display_kind === INJECTED_KIND ? hubAuthorOf(raw) : null;
    const { text, names } = fromHub
      ? { text: fromHub.text.trim(), names: [] }
      : message.role === 'user'
        ? picturesOf(raw)
        : { text: raw, names: [] };
    if (!text && names.length === 0) continue;
    out.push({
      id: String(message.id),
      role: message.role,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
      created_at: isoOf(message.timestamp),
      attachments: names.map((name) => ({ id: name, kind: 'image', available: available(name) })),
      origin: fromHub ? 'hub' : 'channel',
      author_name: fromHub ? fromHub.name : null,
    });
  }
  return out;
}

/** Where a message from the hub would go in this conversation (`ChannelRoute`). */
export function routeOf(
  row: HermesSessionRow,
  rows: readonly HermesSessionRow[] = [],
): ChannelRoute {
  const origin = originOf(row);
  const key = clean(row.session_key, 400);
  // The chat's newest conversation: Hermes puts a message for that chat there, whichever the
  // hub shows (a reset or `/new` starts a newer one under the same key).
  let currentId: string | null = null;
  if (key) {
    const newest = rows
      .filter((each) => clean(each.session_key, 400) === key)
      .reduce<HermesSessionRow | null>(
        (best, each) =>
          !best ||
          (each.started_at ?? 0) > (best.started_at ?? 0) ||
          ((each.started_at ?? 0) === (best.started_at ?? 0) && each.id > best.id)
            ? each
            : best,
        null,
      );
    if (newest && newest.id !== row.id && (newest.started_at ?? 0) >= (row.started_at ?? 0)) {
      currentId = newest.id;
    }
  }
  return {
    source: row.source ?? '',
    sessionKey: key,
    chatId: clean(row.chat_id, 200) ?? clean(origin.chat_id, 200),
    threadId: clean(origin.thread_id, 200),
    currentId,
  };
}

function previewOf(message: ChannelMessage | undefined): ChannelMessagePreview | null {
  if (!message) return null;
  // A message from the hub reads in the list as the channel shows it, with who wrote it.
  const words =
    message.origin === 'hub' && message.author_name
      ? hubMessageText(message.author_name, message.text)
      : message.text;
  const flat = words.replace(/\s+/g, ' ').trim();
  return {
    role: message.role,
    text: flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat,
  };
}

/** One Hermes row as the contract's `ChannelConversation`. */
export function toConversation(
  row: HermesSessionRow,
  profile: string,
  last: ChannelMessagePreview | null,
): ChannelConversation {
  const origin = originOf(row);
  const started = row.started_at ?? 0;
  return {
    id: row.id,
    profile,
    channel: channelOf(row.source ?? 'other'),
    title: clean(row.title),
    peer_name: clean(row.display_name) ?? clean(origin.user_name) ?? clean(origin.chat_name),
    peer_id:
      clean(row.user_id) ?? clean(row.chat_id) ?? clean(origin.user_id) ?? clean(origin.chat_id),
    chat_type: clean(row.chat_type, 40) ?? clean(origin.chat_type, 40),
    last_message: last,
    preview: clean(row.preview, PREVIEW_MAX),
    message_count: Math.max(0, Math.trunc(row.message_count ?? 0)),
    started_at: isoOf(started),
    last_message_at: isoOf(row.last_active ?? started),
  };
}

const isChannel = (source: string | null | undefined): boolean =>
  (CHANNEL_SOURCES as readonly string[]).includes(source ?? '');

// ------------------------------------------------------------------ the service

/** What was read of one profile's list. */
interface Listed {
  rows: HermesSessionRow[];
  /** Hermes's count of the profile's channel conversations. */
  total: number;
  /** Every page there is was read. */
  exhausted: boolean;
}

interface Cached<T> {
  value: T;
  at: number;
  stamp: string | null;
}

export interface ChannelConversationsOptions {
  now?: () => number;
}

/** What one hub reads of Hermes's channel conversations, with what it read kept briefly. */
export class ChannelConversations {
  private readonly now: () => number;
  /** Per Hermes profile: the rows read so far (most recent first) and Hermes's count of all. */
  private readonly lists = new Map<string, Cached<Listed>>();
  private readonly pending = new Map<string, { want: number; read: Promise<Listed> }>();
  /** The latest message of each conversation, keyed by what would change it. */
  private readonly latest = new Map<string, { key: string; value: ChannelMessagePreview | null }>();

  constructor(
    private readonly source: () => ChannelSource | null,
    options: ChannelConversationsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Every conversation of these profiles, most recent first — up to `limit` of each profile's
   * (decision §103) — and why any profile is missing. `has_more`: some profile has more.
   */
  async list(
    scopes: readonly ChannelScope[],
    channel?: string,
    limit: number = LIST_LIMIT,
    check?: SendCheck,
  ): Promise<{
    items: ChannelConversation[];
    unavailable: ChannelUnavailable[];
    has_more: boolean;
  }> {
    const want = Math.min(Math.max(1, Math.trunc(limit) || LIST_LIMIT), LIST_LIMIT_MAX);
    const source = this.source();
    if (!source) {
      return {
        items: [],
        unavailable: [{ profile: null, reason: 'hermes_not_managed', message: null }],
        has_more: false,
      };
    }
    const items: ChannelConversation[] = [];
    const unavailable: ChannelUnavailable[] = [];
    let hasMore = false;
    await Promise.all(
      scopes.map(async (scope) => {
        const hermes = source.hermesProfile(scope.workspace);
        if (!hermes) {
          unavailable.push({
            profile: scope.profile,
            reason: 'profile_not_in_hermes',
            message: null,
          });
          return;
        }
        let listed: Listed;
        try {
          listed = await this.rows(source, hermes, want);
        } catch (error) {
          // What was read before still stands; the list says why it may be stale.
          const stale = this.lists.get(hermes);
          unavailable.push({
            profile: scope.profile,
            reason: 'hermes_unreachable',
            message: error instanceof Error ? error.message : String(error),
          });
          if (!stale) return;
          listed = stale.value;
        }
        const rows = listed.rows.slice(0, want);
        if (listed.total > rows.length) hasMore = true;
        const shown = rows.filter((row) => !channel || channelOf(row.source ?? '') === channel);
        await this.readLatest(source, hermes, shown);
        for (const row of shown) {
          const conversation = toConversation(
            row,
            scope.profile,
            this.latest.get(latestKey(hermes, row))?.value ?? null,
          );
          items.push(
            check ? { ...conversation, ...check(hermes, routeOf(row, listed.rows)) } : conversation,
          );
        }
      }),
    );
    items.sort(
      (a, b) =>
        b.last_message_at.localeCompare(a.last_message_at) ||
        a.profile.localeCompare(b.profile) ||
        b.id.localeCompare(a.id),
    );
    unavailable.sort((a, b) => (a.profile ?? '').localeCompare(b.profile ?? ''));
    return { items, unavailable, has_more: hasMore };
  }

  /**
   * One conversation and a page of its messages, oldest first; `404` for anything that is not
   * one. `offset` skips that many of Hermes's newest messages (decision §103).
   */
  async messages(
    scope: ChannelScope,
    id: string,
    offset = 0,
    check?: SendCheck,
  ): Promise<{
    conversation: ChannelConversation;
    items: ChannelMessage[];
    has_more: boolean;
    next_offset: number | null;
  }> {
    const missing = () => notFound({ resource: 'channel_conversation', id });
    if (!CONVERSATION_ID.test(id)) throw missing();
    const source = this.source();
    if (!source) {
      throw new HubError('service_unavailable', {
        details: { reason: 'hermes_not_managed', message: null },
      });
    }
    const hermes = source.hermesProfile(scope.workspace);
    if (!hermes) throw missing();
    const profile = `profile=${encodeURIComponent(hermes)}`;
    const base = `/api/sessions/${encodeURIComponent(id)}`;
    const ask = async <T>(path: string): Promise<T> => {
      try {
        return await source.get<T>(path);
      } catch (error) {
        if (error instanceof ChannelSourceRefusal && error.status === 404) throw missing();
        if (error instanceof ChannelSourceRefusal || error instanceof ChannelSourceUnavailable) {
          throw new HubError('service_unavailable', {
            message: `Hermes's API is not available: ${error.message}`,
            details: { reason: 'hermes_api_unavailable', message: error.message },
          });
        }
        throw error;
      }
    };
    const row = await ask<HermesSessionRow | null>(`${base}?${profile}`);
    // Only a conversation from a channel is one: the hub's own chats run in Hermes too, and
    // they are read where they belong (`sessions.listMessages`), not here.
    if (!row || typeof row.id !== 'string' || !isChannel(row.source)) throw missing();
    const skip = Math.max(0, Math.trunc(offset) || 0);
    // The first page is asked exactly as before (Hermes's default: its latest 500); an older
    // one names its place.
    const pageQuery =
      skip === 0
        ? profile
        : `${profile}&order=latest&limit=${MESSAGES_PAGE}&offset=${String(skip)}`;
    const page = await ask<HermesMessagesPage | null>(`${base}/messages?${pageQuery}`);
    const raw = Array.isArray(page?.messages) ? page.messages : [];
    const items = toMessages(raw, (name) => (source.picture?.(hermes, name) ?? null) !== null);
    const limit = page?.pagination?.limit ?? 0;
    const returned = page?.pagination?.returned ?? raw.length;
    const hasMore = limit > 0 && returned >= limit;
    if (skip === 0) {
      const last = previewOf(items.at(-1));
      this.latest.set(latestKey(hermes, row), { key: changeKey(row), value: last });
    }
    const conversation = toConversation(
      row,
      scope.profile,
      this.latest.get(latestKey(hermes, row))?.value ?? null,
    );
    return {
      conversation: check
        ? {
            ...conversation,
            ...check(hermes, routeOf(row, this.lists.get(hermes)?.value.rows ?? [])),
          }
        : conversation,
      items,
      has_more: hasMore,
      next_offset: hasMore ? skip + returned : null,
    };
  }

  /**
   * One conversation and where a message from the hub would go (contract decision §153), read
   * afresh: the row by its exact id, and the profile's list again, so a newer conversation of
   * the same chat is seen. `404` for anything that is not a channel conversation.
   */
  async route(
    scope: ChannelScope,
    id: string,
  ): Promise<{ hermes: string; row: HermesSessionRow; route: ChannelRoute }> {
    const missing = () => notFound({ resource: 'channel_conversation', id });
    if (!CONVERSATION_ID.test(id)) throw missing();
    const source = this.source();
    if (!source) {
      throw new HubError('service_unavailable', {
        details: { reason: 'hermes_not_managed', message: null },
      });
    }
    const hermes = source.hermesProfile(scope.workspace);
    if (!hermes) throw missing();
    let row: HermesSessionRow | null;
    let rows: HermesSessionRow[];
    try {
      row = await source.get<HermesSessionRow | null>(
        `/api/sessions/${encodeURIComponent(id)}?profile=${encodeURIComponent(hermes)}`,
      );
      this.invalidate(hermes);
      rows = (await this.rows(source, hermes, LIST_LIMIT)).rows;
    } catch (error) {
      if (error instanceof ChannelSourceRefusal && error.status === 404) throw missing();
      if (error instanceof ChannelSourceRefusal || error instanceof ChannelSourceUnavailable) {
        throw new HubError('service_unavailable', {
          message: `Hermes's API is not available: ${error.message}`,
          details: { reason: 'hermes_api_unavailable', message: error.message },
        });
      }
      throw error;
    }
    if (!row || row.id !== id || !isChannel(row.source)) throw missing();
    return { hermes, row, route: routeOf(row, rows) };
  }

  /** Hermes's profile for a hub workspace, or `null` (no Hermes, or no such profile). */
  hermesProfileOf(workspace: string): string | null {
    return this.source()?.hermesProfile(workspace) ?? null;
  }

  /** Forget what was read of a profile: Hermes's gateway says something happened there. */
  invalidate(hermes: string): void {
    this.lists.delete(hermes);
  }

  /**
   * A picture named in a conversation of this profile (decision §103): where it is in the
   * profile's image cache, or `404` — a name that is not a picture's, or one Hermes has deleted.
   */
  picture(scope: ChannelScope, id: string, name: string): string {
    const missing = () => notFound({ resource: 'channel_picture', id: name });
    if (!CONVERSATION_ID.test(id) || !PICTURE_ID.test(name) || !PICTURE_EXT.test(name)) {
      throw missing();
    }
    const source = this.source();
    if (!source) {
      throw new HubError('service_unavailable', {
        details: { reason: 'hermes_not_managed', message: null },
      });
    }
    const hermes = source.hermesProfile(scope.workspace);
    if (!hermes) throw missing();
    const file = source.picture?.(hermes, name) ?? null;
    if (!file) throw missing();
    return file;
  }

  /**
   * Deletes one channel conversation from Hermes, permanently (contract decision §88). The row
   * is read first, by its exact id: anything that is not a channel conversation of this
   * profile — the hub's own chats run in Hermes too — is `404`, and so is an id Hermes would
   * only match as a prefix. What was read of the profile is dropped, so the next list reads
   * Hermes again.
   */
  async remove(scope: ChannelScope, id: string): Promise<void> {
    const missing = () => notFound({ resource: 'channel_conversation', id });
    if (!CONVERSATION_ID.test(id)) throw missing();
    const source = this.source();
    if (!source) {
      throw new HubError('service_unavailable', {
        details: { reason: 'hermes_not_managed', message: null },
      });
    }
    const hermes = source.hermesProfile(scope.workspace);
    if (!hermes) throw missing();
    const path = `/api/sessions/${encodeURIComponent(id)}?profile=${encodeURIComponent(hermes)}`;
    const ask = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (error instanceof ChannelSourceRefusal && error.status === 404) throw missing();
        if (error instanceof ChannelSourceRefusal || error instanceof ChannelSourceUnavailable) {
          throw new HubError('service_unavailable', {
            message: `Hermes's API is not available: ${error.message}`,
            details: { reason: 'hermes_api_unavailable', message: error.message },
          });
        }
        throw error;
      }
    };
    const row = await ask(() => source.get<HermesSessionRow | null>(path));
    if (!row || row.id !== id || !isChannel(row.source)) throw missing();
    await ask(() => source.delete<unknown>(path));
    this.lists.delete(hermes);
    this.latest.delete(latestKey(hermes, row));
  }

  // -------------------------------------------------------------- internals

  /**
   * The profile's rows, most recent first, at least `want` of them when Hermes has that many:
   * what was read, while Hermes's store is unchanged and it was enough; else read again, a page
   * of 100 at a time (decision §103).
   */
  private rows(source: ChannelSource, hermes: string, want: number): Promise<Listed> {
    const cached = this.lists.get(hermes);
    const enough = (listed: Listed) =>
      listed.rows.length >= Math.min(want, listed.total) || listed.exhausted;
    if (cached && enough(cached.value) && this.fresh(source, hermes, cached)) {
      return Promise.resolve(cached.value);
    }
    const running = this.pending.get(hermes);
    if (running && running.want >= want) return running.read;
    const read = this.readPages(source, hermes, want)
      .then((listed) => {
        // Stamped after the read: Hermes may tidy its store while listing (auto-archive), and
        // that write must not make the next call read again.
        this.lists.set(hermes, { value: listed, at: this.now(), stamp: source.stamp(hermes) });
        return listed;
      })
      .finally(() => {
        if (this.pending.get(hermes)?.read === read) this.pending.delete(hermes);
      });
    this.pending.set(hermes, { want, read });
    return read;
  }

  private async readPages(source: ChannelSource, hermes: string, want: number): Promise<Listed> {
    const rows: HermesSessionRow[] = [];
    let total = 0;
    let exhausted = false;
    for (let offset = 0; rows.length < want; offset += LIST_LIMIT) {
      const query = new URLSearchParams({
        profile: hermes,
        sources: CHANNEL_SOURCES.join(','),
        order: 'recent',
        limit: String(LIST_LIMIT),
      });
      // The first page is asked as it always was; the next ones say where they start.
      if (offset > 0) query.set('offset', String(offset));
      const body = await source.get<{
        sessions?: HermesSessionRow[];
        total?: number;
      } | null>(`/api/sessions?${query.toString()}`);
      const page = Array.isArray(body?.sessions) ? body.sessions : [];
      total = typeof body?.total === 'number' ? body.total : offset + page.length;
      for (const row of page) {
        if (
          row &&
          typeof row.id === 'string' &&
          CONVERSATION_ID.test(row.id) &&
          isChannel(row.source) &&
          !rows.some((seen) => seen.id === row.id)
        ) {
          rows.push(row);
        }
      }
      if (page.length < LIST_LIMIT || offset + LIST_LIMIT >= total) {
        exhausted = true;
        break;
      }
    }
    return { rows, total: Math.max(total, rows.length), exhausted };
  }

  private fresh(source: ChannelSource, hermes: string, cached: Cached<unknown>): boolean {
    const age = this.now() - cached.at;
    if (age < MIN_REFRESH_MS) return true;
    const stamp = source.stamp(hermes);
    if (stamp !== null && cached.stamp !== null) return stamp === cached.stamp && age < MAX_AGE_MS;
    return age < TTL_MS;
  }

  /**
   * The latest message of the conversations whose last one is not known yet or changed — a
   * bounded number per call, a few at a time; the rest show Hermes's preview until the next.
   * A conversation whose read fails keeps what it had.
   */
  private async readLatest(
    source: ChannelSource,
    hermes: string,
    rows: readonly HermesSessionRow[],
  ): Promise<void> {
    const due = rows
      .filter((row) => this.latest.get(latestKey(hermes, row))?.key !== changeKey(row))
      .slice(0, LAST_MESSAGES_PER_CALL);
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const row = due[next++]!;
        const query = new URLSearchParams({ profile: hermes, limit: '6', order: 'latest' });
        try {
          const page = await source.get<HermesMessagesPage | null>(
            `/api/sessions/${encodeURIComponent(row.id)}/messages?${query.toString()}`,
          );
          const items = toMessages(Array.isArray(page?.messages) ? page.messages : []);
          this.latest.set(latestKey(hermes, row), {
            key: changeKey(row),
            value: previewOf(items.at(-1)),
          });
        } catch {
          // Hermes's preview stands in; the next list call tries again.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  }
}

const latestKey = (hermes: string, row: HermesSessionRow) => `${hermes}\u0000${row.id}`;
const changeKey = (row: HermesSessionRow) =>
  `${row.last_active ?? row.started_at ?? 0}:${row.message_count ?? 0}`;
