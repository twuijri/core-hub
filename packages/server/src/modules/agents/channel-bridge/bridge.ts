/**
 * The hub's side of the bridge in Hermes's messaging gateway (contract decision §153): which
 * homes carry the plugin (`plugin.ts`) and with which key, the outbox the plugin long-polls, its
 * acknowledgements, the turns it reports, and whether a gateway serving a profile is listening.
 *
 * Who serves whom: the plugin copy that polls is the one in the home a gateway was started for.
 * On a Hermes with one gateway per host (DECISIONS §129) that is the root's, and it serves every
 * profile — Hermes's routing table spans them all, as the real-Hermes test shows; on an older
 * Hermes each profile's gateway polls with its own home's key and is handed only its own
 * profile's items.
 *
 * Everything here is in memory: an item not taken before the hub stops is lost with the
 * outgoing message that made it, which says so (`sessions`, `bridge_no_answer`).
 */
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { HubError, notFound } from '../../../lib/errors.js';
import type { GatewayTopology } from '../hermes-gateways.js';
import { BRIDGE_KEY_PREFIX, bridgeUrl, hashBridgeKey, writeBridgePlugin } from './plugin.js';

/** One message for the plugin to put into a conversation (`ChannelBridgeItem`). */
export interface BridgeItem {
  id: string;
  session_key: string;
  text: string;
}

/** What the plugin reports (`ChannelBridgeEvent`). */
export interface BridgeEvent {
  event: 'turn_started' | 'turn_ended';
  platform: string;
  session_id: string | null;
  sender_id?: string | null;
  text?: string | null;
  outcome?: 'completed' | 'failed' | 'interrupted' | null;
}

/** Who hears what the plugin says: `sessions`, through the composition root. */
export interface BridgeListener {
  acknowledged(
    hermesProfile: string,
    itemId: string,
    accepted: boolean,
    reason: string | null,
  ): void;
  turn(hermesProfile: string, event: BridgeEvent): void;
}

export interface ChannelBridgeDeps {
  /** Hermes's root home while the hub runs Hermes itself; `null` otherwise. */
  managedRoot(): string | null;
  /** The named profiles under the root (`profiles/<name>`). */
  namedProfiles(root: string): string[];
  topology(): GatewayTopology;
  /** Where Hermes reaches the hub's MCP endpoint; `null` before the hub listens. */
  mcpUrl(): string | null;
  listener(): BridgeListener | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  now?: () => number;
}

/** A poller seen this recently is listening (it polls again at once after each answer). */
export const POLLER_FRESH_MS = 45_000;
/** The longest one poll is held open. */
export const MAX_WAIT_SECONDS = 25;

interface Waiter {
  serves: (profile: string) => boolean;
  wake: () => void;
}

export class ChannelBridge {
  private readonly now: () => number;
  /** sha256(key) → the Hermes profile whose home holds it. */
  private readonly keys = new Map<string, string>();
  private readonly queues = new Map<string, BridgeItem[]>();
  private readonly waiters = new Set<Waiter>();
  /** Per poller (its key's profile): when it last asked, and how many polls it holds open. */
  private readonly pollers = new Map<string, { seen: number; open: number }>();
  /** Items handed out and not acknowledged yet: id → the profile it is for. */
  private readonly handed = new Map<string, { profile: string; poller: string }>();
  private closed = false;

  constructor(private readonly deps: ChannelBridgeDeps) {
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------- the plugin in the homes

  /**
   * The plugin into one home, as the hub writes it, before a gateway starts there (or at boot).
   * Never throws: a home the hub could not write is logged, and the conversations it serves say
   * `bridge_offline`.
   */
  install(profile: string, home: string): void {
    try {
      const url = this.deps.mcpUrl();
      const { key } = writeBridgePlugin(home, { url: url ? bridgeUrl(url) : null, profile });
      this.keys.set(hashBridgeKey(key), profile);
    } catch (error) {
      this.deps.log.warn(
        { err: error, profile },
        'agents: could not write the channel bridge plugin into the profile',
      );
    }
  }

  /** Hermes's root home while the hub runs Hermes itself; `null` otherwise. */
  root(): string | null {
    return this.deps.managedRoot();
  }

  /** Every home of a Hermes the hub runs: the root and each named profile. */
  syncAll(): void {
    const root = this.deps.managedRoot();
    if (!root) return;
    this.install('default', root);
    for (const name of this.deps.namedProfiles(root)) {
      this.install(name, path.join(root, 'profiles', name));
    }
  }

  // -------------------------------------------------------------- what the hub asks

  /** Whether a gateway that serves this Hermes profile is listening for items now. */
  connected(profile: string): boolean {
    const at = this.now();
    for (const [poller, state] of this.pollers) {
      if (!this.serves(poller)(profile)) continue;
      if (state.open > 0 || at - state.seen < POLLER_FRESH_MS) return true;
    }
    return false;
  }

  /** Hands an item to whichever gateway serves the profile, now or at its next poll. */
  enqueue(profile: string, item: BridgeItem): void {
    const queue = this.queues.get(profile) ?? [];
    queue.push(item);
    this.queues.set(profile, queue);
    for (const waiter of [...this.waiters]) {
      if (waiter.serves(profile)) {
        waiter.wake();
        return;
      }
    }
  }

  /** Takes an item back that nobody took (the hub gave up on it). */
  withdraw(itemId: string): void {
    for (const [profile, queue] of this.queues) {
      const kept = queue.filter((item) => item.id !== itemId);
      if (kept.length !== queue.length) this.queues.set(profile, kept);
    }
  }

  // -------------------------------------------------------------- what the plugin asks

  private profileOfKey(bearer: string | null): string {
    if (!bearer || !bearer.startsWith(BRIDGE_KEY_PREFIX)) {
      throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    }
    const profile = this.keys.get(hashBridgeKey(bearer));
    if (!profile) throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    return profile;
  }

  /** The profiles a poller with this key's profile is handed items for. */
  private serves(poller: string): (profile: string) => boolean {
    return (profile) =>
      profile === poller || (poller === 'default' && this.deps.topology() === 'one-per-host');
  }

  private take(serves: (profile: string) => boolean): Array<BridgeItem & { profile: string }> {
    const out: Array<BridgeItem & { profile: string }> = [];
    for (const [profile, queue] of this.queues) {
      if (!serves(profile) || queue.length === 0) continue;
      for (const item of queue) out.push({ ...item, profile });
      this.queues.set(profile, []);
    }
    return out;
  }

  /**
   * `agents.channelBridgeOutbox`: what is waiting for the gateway this key's plugin runs in, at
   * once, or as soon as something arrives within `waitSeconds`. `open()` says whether the
   * plugin is still there to take it (a poll the plugin gave up on gets nothing).
   */
  async outbox(
    bearer: string | null,
    waitSeconds: number,
    open: () => boolean = () => true,
  ): Promise<{ items: BridgeItem[] }> {
    const poller = this.profileOfKey(bearer);
    const serves = this.serves(poller);
    const state = this.pollers.get(poller) ?? { seen: 0, open: 0 };
    state.seen = this.now();
    this.pollers.set(poller, state);
    let items = this.take(serves);
    const wait = this.closed
      ? 0
      : Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.trunc(waitSeconds) || 0));
    if (items.length === 0 && wait > 0) {
      state.open += 1;
      try {
        await new Promise<void>((resolve) => {
          const waiter: Waiter = {
            serves,
            wake: () => {
              this.waiters.delete(waiter);
              clearTimeout(timer);
              resolve();
            },
          };
          const timer = setTimeout(waiter.wake, wait * 1000);
          timer.unref?.();
          this.waiters.add(waiter);
        });
      } finally {
        state.open -= 1;
        state.seen = this.now();
      }
      if (!open()) return { items: [] };
      items = this.take(serves);
    }
    for (const item of items) this.handed.set(item.id, { profile: item.profile, poller });
    return { items: items.map(({ id, session_key, text }) => ({ id, session_key, text })) };
  }

  /** The hub is closing: every poll held open is answered now, so nothing holds the close up. */
  close(): void {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.wake();
  }

  /** `agents.channelBridgeAck`: Hermes took the item, or why not. */
  ack(
    bearer: string | null,
    itemId: string,
    body: { accepted: boolean; reason?: string | null },
  ): void {
    const poller = this.profileOfKey(bearer);
    const handed = this.handed.get(itemId);
    if (!handed || handed.poller !== poller) {
      throw notFound({ resource: 'channel_bridge_item', id: itemId });
    }
    this.handed.delete(itemId);
    this.deps
      .listener()
      ?.acknowledged(handed.profile, itemId, body.accepted === true, body.reason ?? null);
  }

  /** `agents.channelBridgeEvent`: a channel turn began or ended in this key's profile. */
  event(bearer: string | null, body: BridgeEvent): void {
    const profile = this.profileOfKey(bearer);
    this.deps.listener()?.turn(profile, body);
  }
}
