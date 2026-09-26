/**
 * Who an agent is on screen — the same rules as the phones' `AgentIdentity`
 * (docs/design/family.md, "Agents"): its name as the hub's registry has it, its own picture
 * (`agents.getAvatar`, DECISIONS §76) or the catalog mark of an agent we ship (`agentMark`), else
 * its initial.
 *
 * A chat reply's author is only an id and the hub's placeholder name «agent»; the registry knows
 * the real one. A room seat carries a name of its own, and that name wins.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { useAgents } from '../hub/queries.js';
import type { Agent } from '../types.js';
import { Avatar, type AvatarSize } from '../ui/Avatar.js';
import { agentMark } from '../ui/brand/marks.js';

/** What the hub writes as an agent message's author name when it names nobody. */
export const AUTHOR_PLACEHOLDER = 'agent';

export interface AgentIdentity {
  id: string | null;
  name: string;
  slug: string | null;
  hasPicture: boolean;
  /** The registry knows this agent (else the name is the message's own, or the fallback). */
  known: boolean;
}

/**
 * The identity of an author. `shownName` is the name the message carries: a room seat's own
 * name wins over the agent's; a chat reply's placeholder never does.
 */
export function agentIdentity(
  authorId: string | null | undefined,
  shownName: string | null | undefined,
  agents: readonly Agent[],
  fallback: string,
): AgentIdentity {
  const agent = authorId ? agents.find((candidate) => candidate.id === authorId) : undefined;
  const shown = (shownName ?? '').trim();
  const registry = (agent?.name ?? '').trim();
  const name = shown && shown !== AUTHOR_PLACEHOLDER ? shown : registry || fallback;
  return {
    id: authorId ?? null,
    name,
    slug: agent?.slug ?? null,
    hasPicture: agent?.avatar.kind === 'image',
    known: !!agent,
  };
}

/** The identity of an agent from the registry itself. */
export function identityOfAgent(agent: Agent): AgentIdentity {
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    hasPicture: agent.avatar.kind === 'image',
    known: true,
  };
}

/** Resolves authors against the profile's agents, once per render. */
export function useAgentIdentities(): (
  authorId: string | null | undefined,
  shownName: string | null | undefined,
  fallback: string,
) => AgentIdentity {
  const agents = useAgents();
  const list = agents.data ?? [];
  return (authorId, shownName, fallback) => agentIdentity(authorId, shownName, list, fallback);
}

/**
 * The agent's own picture as an object URL: the bearer goes in the header, never the URL, so a
 * plain `<img src>` could not fetch it. `null` until it arrives, or when there is none.
 */
export function useAgentPicture(agentId: string | null, enabled: boolean): string | null {
  const { client, profile } = useAuth();
  const bytes = useQuery({
    queryKey: ['agent-avatar', profile, agentId],
    queryFn: async ({ signal }) => {
      const res = await client.request('get', '/agents/{agent_id}/avatar', {
        params: { agent_id: agentId as string },
        responseKind: 'bytes',
        ...(signal ? { signal } : {}),
      });
      return new Blob([res.data as unknown as ArrayBuffer], {
        type: res.headers.get('content-type') ?? 'image/png',
      });
    },
    enabled: enabled && !!agentId,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
  });
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes.data) return;
    const url = URL.createObjectURL(bytes.data);
    setSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setSrc(null);
    };
  }, [bytes.data]);
  return src;
}

const MARK_SIZE: Record<AvatarSize, number> = { xs: 12, sm: 16, md: 20, lg: 28 };

/** An agent's face: its picture, else its catalog mark, else its initial. */
export function AgentFace({
  identity,
  size = 'sm',
  testId = 'agent-face',
}: {
  identity: AgentIdentity;
  size?: AvatarSize;
  testId?: string;
}) {
  const picture = useAgentPicture(identity.id, identity.hasPicture);
  return (
    <Avatar
      name={identity.name}
      src={picture}
      size={size}
      {...(identity.slug ? { mark: agentMark(identity.slug, MARK_SIZE[size]) } : {})}
      testId={testId}
    />
  );
}
