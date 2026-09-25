/**
 * Which run a call to the hub's own tools belongs to (contract decision §67).
 *
 * Hermes keeps **one MCP connection per profile** and says nothing on a tool call about
 * which conversation made it (`tools/mcp_tool_scope.py`: connections are keyed by profile
 * and server name). So the key on the wire can only say "this profile". The person is found
 * here, from the hub's own knowledge of what is running:
 *
 * - every run the hub starts opens a **lease** — its profile, its owner, its session — and a
 *   run token (`auth/run-tokens.ts`) minted for that owner in that profile; the run's end
 *   closes the lease and revokes the token. Outside a live run the key does nothing.
 * - a call is attributed to the live runs of the key's profile. One owner among them: that
 *   owner. Several: the runs whose agent has just announced a call to one of the hub's tools
 *   (`mcp__corehub__…` in its `tool.started` event) decide; the event and the call travel
 *   separately, so the hub waits a moment for it. Still more than one owner: the call is
 *   refused (`hub_tools_run_ambiguous`) rather than guessed — acting as the wrong person is
 *   the one mistake this must never make.
 * - a message on a channel (Telegram, WhatsApp …) is a turn of Hermes's messaging gateway, not
 *   a run of the hub's. The hub's hook in that gateway (`hook.ts`, decision §78) opens a
 *   **channel lease** for each turn: for the person who linked the sender, or for nobody with
 *   the reason. A call carries where it came from (`X-Corehub-Origin`: the hub's own process or
 *   a gateway), so a gateway's call is only ever one of its turns and a hub process's only
 *   one of the hub's runs — a stranger's message can never borrow a person's live chat.
 */
import { issueRunToken, revokeRunToken } from '../../auth/index.js';
import type { HubOrigin } from './block.js';

/** How Hermes names a tool of the server `corehub` (`tools/mcp_tool_schema.py`). */
export const HUB_TOOL_PREFIX = 'mcp__corehub__';

/** How long a call waits for the `tool.started` that says which run made it. */
export const ATTRIBUTION_WAIT_MS = 2000;
/** A channel turn nobody heard from for this long is over (its gateway died mid-turn). */
export const CHANNEL_LEASE_IDLE_MS = 15 * 60 * 1000;
const POLL_MS = 50;

/** Why a channel turn acts for nobody (decision §78). */
export type ChannelRefusal =
  'hub_tools_sender_not_linked' | 'hub_tools_sender_no_access' | 'hub_tools_group_chat';

export interface Lease {
  runId: string;
  /** `run`: a run of the hub's own; `channel`: a turn of Hermes's messaging gateway (§78). */
  kind: 'run' | 'channel';
  sessionId: string | null;
  workspaceId: string;
  /** The person it acts for; `null` for a channel turn that acts for nobody. */
  userId: string | null;
  /** Why it acts for nobody (`userId === null`). */
  refusal: ChannelRefusal | null;
  /** The run token calls in this lease act with; `null` when it acts for nobody. */
  token: string | null;
  startedAt: number;
  /** A channel turn's last word from its gateway. */
  seenAt: number;
  /** Calls to the hub's tools the agent announced and has not finished. */
  pending: number;
  /** When the agent last announced one, for choosing among several of one owner. */
  lastAnnouncedAt: number;
}

export type Attribution =
  | { ok: true; lease: Lease & { userId: string; token: string } }
  | {
      ok: false;
      reason: 'hub_tools_no_live_run' | 'hub_tools_run_ambiguous' | ChannelRefusal;
    };

export class RunLeases {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A run of the hub's started. No owner (a run the hub cannot attribute): no lease. */
  open(input: { runId: string; sessionId: string; workspaceId: string; userId: string | null }) {
    if (!input.userId) return;
    this.close(input.runId);
    const token = issueRunToken({
      userId: input.userId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    const at = this.now();
    this.leases.set(input.runId, {
      runId: input.runId,
      kind: 'run',
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      refusal: null,
      token,
      startedAt: at,
      seenAt: at,
      pending: 0,
      lastAnnouncedAt: 0,
    });
  }

  /**
   * A turn of a messaging gateway started (the hub's hook, §78): for the person who linked its
   * sender, or for nobody with the reason. Either way it is live in its profile, so a call from
   * that gateway meanwhile is its, and never a hub run's.
   */
  openChannel(input: {
    key: string;
    workspaceId: string;
    userId: string | null;
    refusal: ChannelRefusal | null;
  }): void {
    this.close(input.key);
    const at = this.now();
    const token = input.userId
      ? issueRunToken({
          userId: input.userId,
          workspaceId: input.workspaceId,
          runId: input.key,
          sessionId: null,
        })
      : null;
    this.leases.set(input.key, {
      runId: input.key,
      kind: 'channel',
      sessionId: null,
      workspaceId: input.workspaceId,
      userId: input.userId,
      refusal: input.userId ? null : (input.refusal ?? 'hub_tools_sender_not_linked'),
      token,
      startedAt: at,
      seenAt: at,
      pending: 0,
      lastAnnouncedAt: 0,
    });
  }

  /** The gateway said the turn is still going (`agent:step`). */
  touchChannel(key: string): void {
    const lease = this.leases.get(key);
    if (lease?.kind === 'channel') lease.seenAt = this.now();
  }

  close(runId: string): void {
    const lease = this.leases.get(runId);
    if (!lease) return;
    if (lease.token) revokeRunToken(lease.token);
    this.leases.delete(runId);
  }

  /**
   * The agent announced a tool call (`tool.started`); only the hub's own count — called by
   * name, or through Hermes's `tool_call` bridge, which is how a model reaches an MCP tool
   * Hermes lists on demand (`tools/tool_search.py`: `{calls: [{name, arguments}]}`).
   */
  toolStarted(runId: string, name: string | undefined, input?: unknown): void {
    const lease = this.leases.get(runId);
    if (!lease || !isHubCall(name, input)) return;
    lease.pending += 1;
    lease.lastAnnouncedAt = this.now();
  }

  toolEnded(runId: string, name: string | undefined, input?: unknown): void {
    const lease = this.leases.get(runId);
    if (!lease || !isHubCall(name, input)) return;
    lease.pending = Math.max(0, lease.pending - 1);
  }

  live(workspaceId: string): Lease[] {
    const now = this.now();
    for (const [key, lease] of this.leases) {
      if (lease.kind === 'channel' && now - lease.seenAt > CHANNEL_LEASE_IDLE_MS) this.close(key);
    }
    return [...this.leases.values()].filter((lease) => lease.workspaceId === workspaceId);
  }

  /**
   * Decide now, or say that it cannot be decided yet (`null`).
   *
   * `origin` is where the call came from (the block's `X-Corehub-Origin`): a hub process
   * (`hub`) can only be one of the hub's runs, a messaging gateway (`gateway`) only one of its
   * turns; unknown (`null`, a Hermes the hub did not start) could be either.
   */
  private decide(
    workspaceId: string,
    origin: HubOrigin | null,
    final: boolean,
  ): Attribution | null {
    const live = this.live(workspaceId).filter(
      (lease) =>
        origin === null || (origin === 'hub' ? lease.kind === 'run' : lease.kind === 'channel'),
    );
    if (live.length === 0) return { ok: false, reason: 'hub_tools_no_live_run' };
    const ownerOf = (lease: Lease) => lease.userId ?? `nobody:${lease.runId}`;
    const owners = new Set(live.map(ownerOf));
    const announced = live.filter((lease) => lease.pending > 0);
    if (owners.size === 1) return decided(newest(announced.length > 0 ? announced : live));
    // A gateway's turn announces nothing, so nothing can rule it out: two people (or a person
    // and a stranger) talking to it at once cannot be told apart. Refused at once — acting as
    // the wrong person is the one mistake this must never make.
    if (live.some((lease) => lease.kind === 'channel')) {
      return { ok: false, reason: 'hub_tools_run_ambiguous' };
    }
    const announcedOwners = new Set(announced.map(ownerOf));
    if (announcedOwners.size === 1) return decided(newest(announced));
    return final ? { ok: false, reason: 'hub_tools_run_ambiguous' } : null;
  }

  /** The run a call in this profile belongs to, waiting briefly when several could. */
  async attribute(
    workspaceId: string,
    waitMs = ATTRIBUTION_WAIT_MS,
    origin: HubOrigin | null = null,
  ): Promise<Attribution> {
    // Counted in polls, not read off the clock, so a test's frozen clock cannot hang it.
    const polls = Math.max(0, Math.ceil(waitMs / POLL_MS));
    for (let poll = 0; ; poll += 1) {
      const result = this.decide(workspaceId, origin, poll >= polls);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

function decided(lease: Lease): Attribution {
  if (lease.userId && lease.token) {
    return { ok: true, lease: lease as Lease & { userId: string; token: string } };
  }
  return { ok: false, reason: lease.refusal ?? 'hub_tools_sender_not_linked' };
}

/** Hermes's bridge to the tools it lists on demand. */
const BRIDGE_CALL = 'tool_call';

export function isHubCall(name: string | undefined, input?: unknown): boolean {
  if (name?.startsWith(HUB_TOOL_PREFIX)) return true;
  if (name !== BRIDGE_CALL || !input || typeof input !== 'object') return false;
  const calls = (input as { calls?: unknown }).calls;
  return (
    Array.isArray(calls) &&
    calls.some(
      (call) =>
        !!call &&
        typeof call === 'object' &&
        typeof (call as { name?: unknown }).name === 'string' &&
        (call as { name: string }).name.startsWith(HUB_TOOL_PREFIX),
    )
  );
}

function newest(leases: Lease[]): Lease {
  return leases.reduce((best, lease) =>
    lease.lastAnnouncedAt > best.lastAnnouncedAt ||
    (lease.lastAnnouncedAt === best.lastAnnouncedAt && lease.startedAt > best.startedAt)
      ? lease
      : best,
  );
}
