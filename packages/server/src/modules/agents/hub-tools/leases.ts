/**
 * Which run a call to the hub's own tools belongs to (contract decision §47).
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
 */
import { issueRunToken, revokeRunToken } from '../../auth/index.js';

/** How Hermes names a tool of the server `corehub` (`tools/mcp_tool_schema.py`). */
export const HUB_TOOL_PREFIX = 'mcp__corehub__';

/** How long a call waits for the `tool.started` that says which run made it. */
export const ATTRIBUTION_WAIT_MS = 2000;
const POLL_MS = 50;

export interface Lease {
  runId: string;
  sessionId: string;
  workspaceId: string;
  userId: string;
  /** The run token calls in this run act with. */
  token: string;
  startedAt: number;
  /** Calls to the hub's tools the agent announced and has not finished. */
  pending: number;
  /** When the agent last announced one, for choosing among several of one owner. */
  lastAnnouncedAt: number;
}

export type Attribution =
  | { ok: true; lease: Lease }
  | { ok: false; reason: 'hub_tools_no_live_run' | 'hub_tools_run_ambiguous' };

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
    this.leases.set(input.runId, {
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      token,
      startedAt: this.now(),
      pending: 0,
      lastAnnouncedAt: 0,
    });
  }

  close(runId: string): void {
    const lease = this.leases.get(runId);
    if (!lease) return;
    revokeRunToken(lease.token);
    this.leases.delete(runId);
  }

  /** The agent announced a tool call (`tool.started`); only the hub's own count. */
  toolStarted(runId: string, name: string | undefined): void {
    const lease = this.leases.get(runId);
    if (!lease || !name?.startsWith(HUB_TOOL_PREFIX)) return;
    lease.pending += 1;
    lease.lastAnnouncedAt = this.now();
  }

  toolEnded(runId: string, name: string | undefined): void {
    const lease = this.leases.get(runId);
    if (!lease || !name?.startsWith(HUB_TOOL_PREFIX)) return;
    lease.pending = Math.max(0, lease.pending - 1);
  }

  live(workspaceId: string): Lease[] {
    return [...this.leases.values()].filter((lease) => lease.workspaceId === workspaceId);
  }

  /** Decide now, or say that it cannot be decided yet (`null`). */
  private decide(workspaceId: string, final: boolean): Attribution | null {
    const live = this.live(workspaceId);
    if (live.length === 0) return { ok: false, reason: 'hub_tools_no_live_run' };
    const owners = new Set(live.map((lease) => lease.userId));
    const announced = live.filter((lease) => lease.pending > 0);
    if (owners.size === 1) {
      return { ok: true, lease: newest(announced.length > 0 ? announced : live) };
    }
    const announcedOwners = new Set(announced.map((lease) => lease.userId));
    if (announcedOwners.size === 1) return { ok: true, lease: newest(announced) };
    return final ? { ok: false, reason: 'hub_tools_run_ambiguous' } : null;
  }

  /** The run a call in this profile belongs to, waiting briefly when several could. */
  async attribute(workspaceId: string, waitMs = ATTRIBUTION_WAIT_MS): Promise<Attribution> {
    // Counted in polls, not read off the clock, so a test's frozen clock cannot hang it.
    const polls = Math.max(0, Math.ceil(waitMs / POLL_MS));
    for (let poll = 0; ; poll += 1) {
      const decided = this.decide(workspaceId, poll >= polls);
      if (decided) return decided;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

function newest(leases: Lease[]): Lease {
  return leases.reduce((best, lease) =>
    lease.lastAnnouncedAt > best.lastAnnouncedAt ||
    (lease.lastAnnouncedAt === best.lastAnnouncedAt && lease.startedAt > best.startedAt)
      ? lease
      : best,
  );
}
