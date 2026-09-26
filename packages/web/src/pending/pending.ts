/**
 * The pending-actions bar's model: what is waiting for the person, and where each thing is
 * handled. Pure, so the routing rules are tested without a hub.
 *
 * Waiting things are the approvals and questions of every profile the person may enter
 * (`sessions.listApprovals`, one call per profile — conversations, rooms and workflow gates
 * alike), and, for an admin, in the profile they are in: the senders waiting to pair with a
 * channel (`agents.listPairing`) and the memory and skill writes Hermes's agent staged for
 * review (`agents.listPendingWrites`, decision §102).
 */
import { chatHref, globalAgentHref, PROFILE_PARAM } from '../chat/anchor.js';
import { agentRoute, routeOf } from '../navigation/manifest.js';
import type { Approval, Schemas } from '../types.js';

export type PendingWrite = Schemas['PendingWrite'];

export interface PendingPairing {
  platform: string;
  request_id: string;
  user_id: string;
  user_name: string | null;
  requested_at: string;
}

export type PendingItem =
  | { kind: 'approval'; key: string; profile: string; at: string; approval: Approval }
  | {
      kind: 'pairing';
      key: string;
      profile: string;
      at: string;
      agentId: string;
      request: PendingPairing;
    }
  | {
      /** A memory or skill write the agent staged for review (§58), counted since §102. */
      kind: 'write';
      key: string;
      profile: string;
      at: string;
      agentId: string;
      write: PendingWrite;
    };

/**
 * Every waiting thing, oldest first: what has waited longest is the most likely to expire
 * and the first a person should see. An approval can arrive twice (the list and a refetch
 * racing); the key keeps one.
 */
export function mergePending(
  approvals: ReadonlyArray<{ profile: string; items: readonly Approval[] }>,
  pairing: ReadonlyArray<{ profile: string; agentId: string; items: readonly PendingPairing[] }>,
  writes: ReadonlyArray<{ profile: string; agentId: string; items: readonly PendingWrite[] }> = [],
): PendingItem[] {
  const seen = new Map<string, PendingItem>();
  for (const group of approvals) {
    for (const approval of group.items) {
      if (approval.status !== 'pending') continue;
      const key = `approval:${approval.id}`;
      seen.set(key, {
        kind: 'approval',
        key,
        profile: group.profile,
        at: approval.created_at,
        approval,
      });
    }
  }
  for (const group of pairing) {
    for (const request of group.items) {
      const key = `pairing:${group.profile}:${request.platform}:${request.request_id}`;
      seen.set(key, {
        kind: 'pairing',
        key,
        profile: group.profile,
        at: request.requested_at,
        agentId: group.agentId,
        request,
      });
    }
  }
  for (const group of writes) {
    for (const write of group.items) {
      const key = `write:${group.profile}:${write.kind}:${write.id}`;
      seen.set(key, {
        kind: 'write',
        key,
        profile: group.profile,
        // A write Hermes did not date waits from the start of time: first in the list.
        at: write.created_at ?? '',
        agentId: group.agentId,
        write,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Where a waiting thing is handled. `inLink` is the profile a link carries (only once the
 * person has more than one); `globalAgent` names, per profile, the person's global-agent
 * conversation when it is known, so its approvals open its own page rather than a chat.
 * A room's question opens the room it was asked in (`/rooms/<id>`, in its profile); a staged
 * write opens the agent's settings, where the list of writes waiting for review is. `null`
 * when there is no page for it.
 */
export function pendingHref(
  item: PendingItem,
  inLink: (profile: string) => string | null,
  globalAgent: (profile: string) => string | null = () => null,
): string | null {
  // Pairing is read in the profile the person is in, which is where the agent's page opens.
  if (item.kind === 'pairing') return agentRoute('agent_channels', item.agentId);
  // Staged writes are read in the profile the person is in too, like pairing.
  if (item.kind === 'write') return agentRoute('agent_settings', item.agentId);
  const profile = inLink(item.profile);
  const { approval } = item;
  if (approval.session_id) {
    if (approval.session_id === globalAgent(item.profile)) return globalAgentHref(profile);
    return chatHref(approval.session_id, null, undefined, profile);
  }
  if (approval.room_id) {
    const room = `${routeOf('rooms').split('/:')[0]}/${approval.room_id}`;
    return profile ? `${room}?${PROFILE_PARAM}=${encodeURIComponent(profile)}` : room;
  }
  if (approval.workflow_run_id) {
    // The Schedules page opens a run named in its address, in that run's profile.
    const params = new URLSearchParams({ workflow_run: approval.workflow_run_id });
    params.set(PROFILE_PARAM, item.profile);
    return `${routeOf('schedules')}?${params.toString()}`;
  }
  return null;
}
