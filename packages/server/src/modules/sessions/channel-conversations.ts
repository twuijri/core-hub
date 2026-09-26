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
 *   exact row first and deletes only that (contract decision §87).
 *
 * The one write is that delete, for an admin (§87). What was read is kept per Hermes profile and asked for again
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
  pagination?: { limit?: number; returned?: number };
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
}

export interface ChannelMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at: string;
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

/** The person's and the agent's messages with words in them; tools and system text left out. */
export function toMessages(messages: readonly HermesMessage[]): ChannelMessage[] {
  const out: ChannelMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = textOf(message);
    if (!text) continue;
    out.push({
      id: String(message.id),
      role: message.role,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
      created_at: isoOf(message.timestamp),
    });
  }
  return out;
}

function previewOf(message: ChannelMessage | undefined): ChannelMessagePreview | null {
  if (!message) return null;
  const flat = message.text.replace(/\s+/g, ' ').trim();
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
  private readonly lists = new Map<string, Cached<HermesSessionRow[]>>();
  private readonly pending = new Map<string, Promise<HermesSessionRow[]>>();
  /** The latest message of each conversation, keyed by what would change it. */
  private readonly latest = new Map<string, { key: string; value: ChannelMessagePreview | null }>();

  constructor(
    private readonly source: () => ChannelSource | null,
    options: ChannelConversationsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Every conversation of these profiles, most recent first, and why any profile is missing. */
  async list(
    scopes: readonly ChannelScope[],
    channel?: string,
  ): Promise<{ items: ChannelConversation[]; unavailable: ChannelUnavailable[] }> {
    const source = this.source();
    if (!source) {
      return {
        items: [],
        unavailable: [{ profile: null, reason: 'hermes_not_managed', message: null }],
      };
    }
    const items: ChannelConversation[] = [];
    const unavailable: ChannelUnavailable[] = [];
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
        let rows: HermesSessionRow[];
        try {
          rows = await this.rows(source, hermes);
        } catch (error) {
          // What was read before still stands; the list says why it may be stale.
          const stale = this.lists.get(hermes);
          unavailable.push({
            profile: scope.profile,
            reason: 'hermes_unreachable',
            message: error instanceof Error ? error.message : String(error),
          });
          if (!stale) return;
          rows = stale.value;
        }
        const shown = rows.filter((row) => !channel || channelOf(row.source ?? '') === channel);
        await this.readLatest(source, hermes, shown);
        for (const row of shown) {
          items.push(
            toConversation(
              row,
              scope.profile,
              this.latest.get(latestKey(hermes, row))?.value ?? null,
            ),
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
    return { items, unavailable };
  }

  /** One conversation and its messages, oldest first; `404` for anything that is not one. */
  async messages(
    scope: ChannelScope,
    id: string,
  ): Promise<{ conversation: ChannelConversation; items: ChannelMessage[]; has_more: boolean }> {
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
    const page = await ask<HermesMessagesPage | null>(`${base}/messages?${profile}`);
    const raw = Array.isArray(page?.messages) ? page.messages : [];
    const items = toMessages(raw);
    const limit = page?.pagination?.limit ?? 0;
    const returned = page?.pagination?.returned ?? raw.length;
    const last = previewOf(items.at(-1));
    this.latest.set(latestKey(hermes, row), { key: changeKey(row), value: last });
    return {
      conversation: toConversation(row, scope.profile, last),
      items,
      has_more: limit > 0 && returned >= limit,
    };
  }

  /**
   * Deletes one channel conversation from Hermes, permanently (contract decision §87). The row
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

  /** The profile's rows: what was read, while Hermes's store is unchanged; else read again. */
  private rows(source: ChannelSource, hermes: string): Promise<HermesSessionRow[]> {
    const cached = this.lists.get(hermes);
    if (cached && this.fresh(source, hermes, cached)) return Promise.resolve(cached.value);
    const running = this.pending.get(hermes);
    if (running) return running;
    const query = new URLSearchParams({
      profile: hermes,
      sources: CHANNEL_SOURCES.join(','),
      order: 'recent',
      limit: String(LIST_LIMIT),
    });
    const read = source
      .get<{ sessions?: HermesSessionRow[] } | null>(`/api/sessions?${query.toString()}`)
      .then((body) => {
        const rows = (Array.isArray(body?.sessions) ? body.sessions : []).filter(
          (row) =>
            row &&
            typeof row.id === 'string' &&
            CONVERSATION_ID.test(row.id) &&
            isChannel(row.source),
        );
        // Stamped after the read: Hermes may tidy its store while listing (auto-archive), and
        // that write must not make the next call read again.
        this.lists.set(hermes, { value: rows, at: this.now(), stamp: source.stamp(hermes) });
        return rows;
      })
      .finally(() => this.pending.delete(hermes));
    this.pending.set(hermes, read);
    return read;
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
