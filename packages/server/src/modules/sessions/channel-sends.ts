/**
 * Writing into a Telegram or WhatsApp conversation from the hub (contract decision §153), and
 * hearing every channel turn as it happens.
 *
 * The conversation stays Hermes's and the channel's (§61): the hub keeps no copy of it. What it
 * keeps, in memory, is each message a person wrote from here while it follows it — posted on the
 * channel, taken by Hermes's gateway, the agent's turn begun, ended — so the screen can show it
 * at once and say what became of it. Once Hermes's transcript has it and its turn is over, the
 * transcript is the record.
 *
 * The order is the owner's (2026-10-08): the words are posted on the channel first, as
 * «من كور هب (<name>): …»; when the channel refuses, nothing reaches the agent and the person is
 * told in the platform's words. Only then are they handed to the hub's plugin in Hermes's
 * gateway (`agents`' bridge), which puts them into the conversation as its next turn. The same
 * words go to both, so what the agent reads is what the chat shows.
 *
 * The bridge also reports every channel turn — a message typed on the channel as much as one
 * from here — and each is announced as `channel_conversation.updated`, so a screen showing the
 * conversation or the list reads it again then instead of every half minute (§61's polling stays
 * as a slow fallback).
 */
import type { FastifyInstance } from 'fastify';
import { HubError } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import {
  channelOf,
  hubMessageText,
  isoOf,
  type ChannelConversations,
  type ChannelMessage,
  type ChannelRoute,
  type ChannelScope,
  type SendCheck,
  type SendUnavailable,
} from './channel-conversations.js';

/** The Hermes sources a message can be written into from the hub (owner, 2026-10-08). */
export const SENDABLE_SOURCES = ['telegram', 'whatsapp'] as const;

/** What `sessions` needs of `agents`' bridge, lent by the composition root. */
export interface ChannelSender {
  connected(hermesProfile: string): boolean;
  post(
    hermesProfile: string,
    target: { platform: string; chatId: string; threadId: string | null },
    text: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  enqueue(hermesProfile: string, item: { id: string; session_key: string; text: string }): void;
  withdraw(itemId: string): void;
  /** The hub profiles (workspace slugs) a Hermes profile is. */
  profilesOf(hermesProfile: string): string[];
  /** A person's name as the channel shows it (their display name, else their username). */
  personName(userId: string): string | null;
}

let senderFactory: ((app: FastifyInstance) => ChannelSender | null) | null = null;

/** Where messages written from the hub go; `null` (or a factory answering it): nowhere. */
export function registerChannelSender(
  factory: ((app: FastifyInstance) => ChannelSender | null) | null,
): ((app: FastifyInstance) => ChannelSender | null) | null {
  const previous = senderFactory;
  senderFactory = factory;
  return previous;
}

export function channelSenderFor(app: FastifyInstance): ChannelSender | null {
  return senderFactory?.(app) ?? null;
}

export type OutgoingStatus = 'posted' | 'delivered' | 'answering' | 'answered' | 'failed';
export type OutgoingFailure = 'bridge_no_answer' | 'not_accepted' | 'not_picked_up';

/** The contract's `ChannelOutgoing`. */
export interface ChannelOutgoing {
  id: string;
  conversation_id: string;
  client_message_id: string | null;
  text: string;
  author_name: string;
  status: OutgoingStatus;
  error: { reason: OutgoingFailure; message: string | null } | null;
  message_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Followed {
  wire: ChannelOutgoing;
  /** The hub profile (workspace slug) it was written in, and Hermes's profile. */
  profile: string;
  hermes: string;
  channel: string;
  /** The words as they went to the channel and to Hermes. */
  posted: string;
  timer: NodeJS.Timeout | null;
}

/** One turn event of the bridge (`ChannelBridgeEvent`). */
export interface TurnEvent {
  event: 'turn_started' | 'turn_ended';
  platform: string;
  session_id: string | null;
  sender_id?: string | null;
  text?: string | null;
  outcome?: 'completed' | 'failed' | 'interrupted' | null;
}

export interface ChannelSendsOptions {
  reader: () => ChannelConversations;
  sender: () => ChannelSender | null;
  /** `channel_conversation.updated` to everyone in a hub profile. */
  emit(profile: string, payload: Record<string, unknown>): void;
  now?: () => number;
  /** Hermes's gateway takes an item at its next poll; give up after this long. */
  ackTimeoutMs?: number;
  /** After Hermes took it, the agent's turn should begin within this long (or wait its turn). */
  startTimeoutMs?: number;
  /** How long a message nobody needs any more is still listed. */
  keepMs?: number;
}

export const ACK_TIMEOUT_MS = 30_000;
export const START_TIMEOUT_MS = 120_000;
export const KEEP_MS = 10 * 60_000;

/** The messages written from the hub, followed per hub, and every channel turn heard. */
export class ChannelSends {
  private readonly now: () => number;
  private readonly followed = new Map<string, Followed>();
  /** Hermes sessions with a turn running now, by `hermes\0session` (a queued item waits). */
  private readonly busy = new Set<string>();

  constructor(private readonly options: ChannelSendsOptions) {
    this.now = options.now ?? Date.now;
  }

  private stamp(): string {
    return isoOf(this.now() / 1000);
  }

  /** `can_send`, `send_unavailable` and `current_id` for a caller (§153). */
  checkFor(admin: boolean): SendCheck {
    return (hermes, route) => {
      const why = this.unavailable(hermes, route, admin);
      return {
        can_send: why === null,
        send_unavailable: why,
        current_id: why === 'not_current' ? route.currentId : null,
      };
    };
  }

  /** A person's name as the channel shows it, from `auth` through the composition root. */
  personName(userId: string): string | null {
    return this.options.sender()?.personName(userId) ?? null;
  }

  /** Whether every Hermes profile of these is heard as it happens. */
  live(hermesProfiles: readonly string[]): boolean {
    const sender = this.options.sender();
    return (
      !!sender && hermesProfiles.length > 0 && hermesProfiles.every((p) => sender.connected(p))
    );
  }

  private unavailable(hermes: string, route: ChannelRoute, admin: boolean): SendUnavailable | null {
    if (!admin) return 'not_admin';
    const sender = this.options.sender();
    if (!sender) return 'hermes_not_managed';
    if (!(SENDABLE_SOURCES as readonly string[]).includes(route.source)) {
      return 'platform_unsupported';
    }
    if (!route.sessionKey || !route.chatId) return 'no_route';
    if (route.currentId) return 'not_current';
    if (!sender.connected(hermes)) return 'bridge_offline';
    return null;
  }

  /**
   * `sessions.sendChannelMessage`: post on the channel, then hand to Hermes. Throws before
   * anything is posted when it cannot be written into, and when the channel refuses.
   */
  async send(
    scope: ChannelScope,
    id: string,
    input: { text: string; client_message_id?: string | null | undefined },
    author: { name: string; admin: boolean },
  ): Promise<ChannelOutgoing> {
    if (!author.admin) {
      throw new HubError('forbidden', {
        messageKey: 'auth.admin_only',
        details: { required_role: 'admin', reason: 'not_admin' },
      });
    }
    const sender = this.options.sender();
    if (!sender) {
      throw new HubError('service_unavailable', {
        details: { reason: 'hermes_not_managed', message: null },
      });
    }
    const { hermes, row, route } = await this.options.reader().route(scope, id);
    const why = this.unavailable(hermes, route, true);
    if (why === 'bridge_offline' || why === 'hermes_not_managed') {
      throw new HubError('service_unavailable', { details: { reason: why, message: null } });
    }
    if (why) {
      throw new HubError('state_invalid', {
        details: {
          reason: why,
          ...(why === 'not_current' ? { current_id: route.currentId } : {}),
        },
      });
    }
    const words = input.text.trim();
    if (!words) {
      throw new HubError('validation_failed', {
        details: { issues: [{ path: 'text', message: 'empty' }] },
      });
    }
    const posted = hubMessageText(author.name, words);
    // 1. On the channel first. A refusal stops here: nothing reaches the agent.
    const mirrored = await sender.post(
      hermes,
      { platform: route.source, chatId: route.chatId!, threadId: route.threadId },
      posted,
    );
    if (!mirrored.ok) {
      throw new HubError('service_unavailable', {
        message: mirrored.message,
        details: { reason: 'channel_send_failed', message: mirrored.message },
      });
    }
    // 2. Then to Hermes's gateway, as the conversation's next turn.
    const at = this.stamp();
    const followed: Followed = {
      wire: {
        id: newUlid(this.now()),
        conversation_id: row.id,
        client_message_id: input.client_message_id ?? null,
        text: words,
        author_name: author.name,
        status: 'posted',
        error: null,
        message_id: null,
        session_id: null,
        created_at: at,
        updated_at: at,
      },
      profile: scope.profile,
      hermes,
      channel: channelOf(route.source),
      posted,
      timer: null,
    };
    this.followed.set(followed.wire.id, followed);
    sender.enqueue(hermes, { id: followed.wire.id, session_key: route.sessionKey!, text: posted });
    this.arm(followed, this.options.ackTimeoutMs ?? ACK_TIMEOUT_MS, () => {
      this.options.sender()?.withdraw(followed.wire.id);
      this.fail(followed, 'bridge_no_answer', null);
    });
    this.announce(followed);
    return { ...followed.wire };
  }

  /** The bridge's acknowledgement of an item (`agents.channelBridgeAck`). */
  acknowledged(hermes: string, itemId: string, accepted: boolean, reason: string | null): void {
    const followed = this.followed.get(itemId);
    if (!followed || followed.hermes !== hermes || followed.wire.status !== 'posted') return;
    if (!accepted) {
      this.fail(followed, 'not_accepted', reason);
      return;
    }
    this.move(followed, 'delivered');
    this.waitForTurn(followed);
  }

  private waitForTurn(followed: Followed): void {
    this.arm(followed, this.options.startTimeoutMs ?? START_TIMEOUT_MS, () => {
      // Hermes queues it behind a turn already running: that is waiting, not lost.
      if (this.busy.has(`${followed.hermes}\u0000${followed.wire.conversation_id}`)) {
        this.waitForTurn(followed);
        return;
      }
      this.fail(followed, 'not_picked_up', null);
    });
  }

  /** A channel turn began or ended (`agents.channelBridgeEvent`). */
  turn(hermes: string, event: TurnEvent): void {
    const session = event.session_id ?? '';
    const key = `${hermes}\u0000${session}`;
    if (event.event === 'turn_started') {
      this.busy.add(key);
      const words = (event.text ?? '').trim();
      const mine = [...this.followed.values()]
        .filter(
          (each) =>
            each.hermes === hermes &&
            (each.wire.status === 'posted' || each.wire.status === 'delivered') &&
            words !== '' &&
            (words === each.posted.trim() || words.includes(each.posted.trim())),
        )
        // This conversation's own first, then the oldest.
        .sort(
          (a, b) =>
            Number(b.wire.conversation_id === session) -
              Number(a.wire.conversation_id === session) ||
            a.wire.created_at.localeCompare(b.wire.created_at),
        )[0];
      if (mine) {
        mine.wire.session_id = session || null;
        this.move(mine, 'answering');
      }
    } else {
      this.busy.delete(key);
      for (const each of this.followed.values()) {
        if (
          each.hermes === hermes &&
          each.wire.status === 'answering' &&
          each.wire.session_id === session
        ) {
          this.move(each, 'answered');
        }
      }
    }
    // Every channel turn: the screens showing it read it again.
    const channel = channelOf(event.platform);
    for (const profile of this.options.sender()?.profilesOf(hermes) ?? []) {
      if (!session) continue;
      this.options.emit(profile, {
        conversation_id: session,
        channel,
        reason: event.event,
        outgoing: null,
      });
    }
  }

  /**
   * What is still followed in this conversation, oldest first, each with the transcript message
   * it became when the transcript has it. One whose turn is over and that the transcript has is
   * done, and dropped; one nobody looked at for `keepMs` is dropped too.
   */
  outgoingFor(
    profile: string,
    conversationId: string,
    items: readonly ChannelMessage[],
  ): ChannelOutgoing[] {
    this.prune();
    const claimed = new Set(
      [...this.followed.values()].map((each) => each.wire.message_id).filter(Boolean) as string[],
    );
    const out: ChannelOutgoing[] = [];
    const mine = [...this.followed.values()]
      .filter((each) => each.profile === profile && each.wire.conversation_id === conversationId)
      .sort((a, b) => a.wire.created_at.localeCompare(b.wire.created_at));
    for (const each of mine) {
      if (!each.wire.message_id) {
        const since = Date.parse(each.wire.created_at) - 60_000;
        const found = items.find(
          (message) =>
            message.origin === 'hub' &&
            !claimed.has(message.id) &&
            message.author_name === each.wire.author_name &&
            message.text.trim() === each.wire.text &&
            Date.parse(message.created_at) >= since,
        );
        if (found) {
          each.wire.message_id = found.id;
          claimed.add(found.id);
        }
      }
      if (
        each.wire.message_id &&
        (each.wire.status === 'answered' || each.wire.status === 'failed')
      ) {
        this.drop(each);
        continue;
      }
      out.push({ ...each.wire, ...(each.wire.error ? { error: { ...each.wire.error } } : {}) });
    }
    return out;
  }

  /** Stops every timer (the hub is closing). */
  close(): void {
    for (const each of this.followed.values()) if (each.timer) clearTimeout(each.timer);
    this.followed.clear();
  }

  // -------------------------------------------------------------- internals

  private prune(): void {
    const keep = this.options.keepMs ?? KEEP_MS;
    for (const each of [...this.followed.values()]) {
      // A turn that never said it ended (its gateway went down) is let go later.
      const limit = each.wire.status === 'answering' ? keep * 3 : keep;
      if (Date.parse(each.wire.updated_at) < this.now() - limit) this.drop(each);
    }
  }

  private drop(followed: Followed): void {
    if (followed.timer) clearTimeout(followed.timer);
    this.followed.delete(followed.wire.id);
  }

  private arm(followed: Followed, ms: number, then: () => void): void {
    if (followed.timer) clearTimeout(followed.timer);
    followed.timer = setTimeout(() => {
      followed.timer = null;
      then();
    }, ms);
    followed.timer.unref?.();
  }

  private move(followed: Followed, status: OutgoingStatus): void {
    if (status !== 'delivered' && followed.timer) {
      clearTimeout(followed.timer);
      followed.timer = null;
    }
    followed.wire.status = status;
    followed.wire.updated_at = this.stamp();
    this.announce(followed);
  }

  private fail(followed: Followed, reason: OutgoingFailure, message: string | null): void {
    followed.wire.error = { reason, message };
    this.move(followed, 'failed');
  }

  private announce(followed: Followed): void {
    this.options.emit(followed.profile, {
      conversation_id: followed.wire.conversation_id,
      channel: followed.channel,
      reason: 'outgoing',
      outgoing: { ...followed.wire },
    });
  }
}
