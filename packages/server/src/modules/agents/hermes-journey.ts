/**
 * The agent's Journey: what Hermes has learned in one profile, as Hermes itself draws it.
 *
 * Hermes builds a "learning graph" (`agent/learning_graph.py` §build_learning_graph, MIT, tag
 * v2026.9.14) and shows it three ways — `hermes journey` in the terminal, the `/journey`
 * overlay of its TUI, and its desktop panel, which reads it from its server:
 * `GET /api/learning/graph?profile=<name>` (`hermes_cli/web_routers/status.py`), run under that
 * profile's home. The hub asks that server (ADR 0015), the same way it tests an MCP server or
 * lists pairing requests, and renames the fields; it decides nothing itself.
 *
 * What Hermes puts in it, observed against the image (a throwaway home with three skills, a
 * `.usage.json` and two `MEMORY.md` entries, `hermes -p work journey --json`):
 *
 * - **skills the profile learned**: only the profile's own skills (Hermes's bundled ones are
 *   left out) that the agent wrote (`created_by: agent` in `skills/.usage.json`) or has used
 *   (`use_count > 0`); a skill nobody used is not a node. Each with its category (front matter,
 *   else its folder), `useCount`, `pinned`, the curator `state`, and a `timestamp` in epoch
 *   seconds: the newest of its recorded use/view/patch/creation times, else the file's time;
 * - **every memory entry**: `MEMORY.md` and `USER.md` split on their `§` lines, one node each,
 *   id `memory:<memory|profile>:<n>` where `n` counts both files together (`MEMORY.md` first,
 *   so a lone `USER.md` entry after two memories is `memory:profile:2`), labelled with the
 *   entry's first line (80 characters);
 * - **edges**: a skill's `related_skills` when both ends are nodes, and each memory to at most
 *   four skills whose names or words it shares. Hermes compares Latin letters and digits only,
 *   so an Arabic memory links to nothing unless it names a skill;
 * - **clusters**: nodes per category, the largest first (`memory` counts the entries).
 *
 * Hermes's USER.md source is called `profile`; the hub's memory model calls that file `user`
 * (contract decision §12), so `memory_source` says `user`. Ids are passed through unchanged.
 */
import { HubError } from '../../lib/errors.js';
import { hermesFault, type HermesApiCall } from './hermes-tools.js';

export interface JourneyNode {
  id: string;
  label: string;
  kind: 'skill' | 'memory';
  category: string | null;
  use_count: number;
  pinned: boolean;
  state: 'active' | 'stale' | 'archived';
  agent_created: boolean;
  memory_source: 'memory' | 'user' | null;
  learned_at: string | null;
}

export interface Journey {
  nodes: JourneyNode[];
  edges: Array<{ source: string; target: string }>;
  clusters: Array<{ category: string; count: number }>;
}

interface HermesNode {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  category?: unknown;
  useCount?: unknown;
  pinned?: unknown;
  state?: unknown;
  createdBy?: unknown;
  memorySource?: unknown;
  timestamp?: unknown;
}

interface HermesGraph {
  nodes?: unknown;
  edges?: unknown;
  clusters?: unknown;
}

const STATES = new Set(['active', 'stale', 'archived']);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** Hermes's epoch seconds as the contract's ISO time; anything else is "no time". */
function isoOf(value: unknown): string | null {
  const seconds =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nodeOf(raw: HermesNode): JourneyNode | null {
  const id = text(raw.id);
  if (!id) return null;
  const kind = raw.kind === 'memory' ? 'memory' : raw.kind === 'skill' ? 'skill' : null;
  if (!kind) return null;
  const count = typeof raw.useCount === 'number' ? raw.useCount : Number(raw.useCount);
  const state = typeof raw.state === 'string' && STATES.has(raw.state) ? raw.state : 'active';
  return {
    id,
    label: text(raw.label) ?? id,
    kind,
    category: text(raw.category),
    use_count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    pinned: raw.pinned === true,
    state: state as JourneyNode['state'],
    agent_created: kind === 'skill' && raw.createdBy === 'agent',
    memory_source: kind === 'memory' ? (raw.memorySource === 'profile' ? 'user' : 'memory') : null,
    learned_at: isoOf(raw.timestamp),
  };
}

/** Hermes's payload in the contract's shape. Rows Hermes did not fill are left out, not guessed. */
export function journeyFromHermes(payload: HermesGraph): Journey {
  const nodes = (Array.isArray(payload.nodes) ? payload.nodes : [])
    .map((raw) => (raw && typeof raw === 'object' ? nodeOf(raw as HermesNode) : null))
    .filter((node): node is JourneyNode => node !== null);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(payload.edges) ? payload.edges : [])
    .map((raw) => {
      const edge = (raw ?? {}) as { source?: unknown; target?: unknown };
      const source = text(edge.source);
      const target = text(edge.target);
      return source && target && ids.has(source) && ids.has(target) ? { source, target } : null;
    })
    .filter((edge): edge is { source: string; target: string } => edge !== null);
  const clusters = (Array.isArray(payload.clusters) ? payload.clusters : [])
    .map((raw) => {
      const cluster = (raw ?? {}) as { category?: unknown; count?: unknown };
      const category = text(cluster.category);
      const count = typeof cluster.count === 'number' ? Math.floor(cluster.count) : NaN;
      return category && Number.isFinite(count) && count >= 0 ? { category, count } : null;
    })
    .filter((cluster): cluster is { category: string; count: number } => cluster !== null);
  return { nodes, edges, clusters };
}

/** Asks Hermes's server for the profile's learning graph. */
export async function readJourney(api: HermesApiCall, profile: string): Promise<Journey> {
  let payload: unknown;
  try {
    payload = await api<unknown>(
      'GET',
      `/api/learning/graph?profile=${encodeURIComponent(profile)}`,
    );
  } catch (error) {
    return hermesFault(error);
  }
  if (!payload || typeof payload !== 'object') {
    throw new HubError('service_unavailable', {
      details: { reason: 'hermes_api_unavailable', message: 'Hermes answered no graph' },
    });
  }
  return journeyFromHermes(payload as HermesGraph);
}
