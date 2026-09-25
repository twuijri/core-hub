/**
 * The workflow editor's state, as pure functions: what the canvas draws and what is saved.
 *
 * The drawing is the contract's own `WorkflowWrite` — nodes with their `position`, edges
 * with their `route` — so there is nothing to translate on save and nothing lost on load.
 * The hub stays the judge of what is valid (`schedules.validateWorkflow`); this file only
 * keeps the drawing consistent: an edge never outlives its node, a node id is unique and
 * stays inside the contract's pattern, and one edge joins two nodes once per route.
 *
 * Positions are *logical*: `x` is the distance along the reading direction, so a flow
 * drawn in Arabic runs right-to-left and the same workflow opened in English runs
 * left-to-right (the canvas mirrors itself; `WorkflowCanvas.tsx`, DECISIONS §52).
 */

export const NODE_KINDS = ['agent', 'condition', 'delay', 'notify', 'approval'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type Route = 'always' | 'success' | 'failure';

export interface Position {
  x: number;
  y: number;
}

export interface WfNode {
  id: string;
  kind: NodeKind;
  title: string;
  agent_id: string | null;
  model: string | null;
  provider: string | null;
  reasoning_effort: string | null;
  skills: string[];
  input: string | null;
  approval_required: boolean;
  position: Position;
}

export interface WfEdge {
  id: string;
  from: string;
  to: string;
  route: Route;
}

export interface Draft {
  name: string;
  description: string | null;
  working_dir: string | null;
  nodes: WfNode[];
  edges: WfEdge[];
}

export type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

export interface EditorState {
  draft: Draft;
  selected: Selection;
  /** Changed since it was loaded or saved. */
  dirty: boolean;
}

/** The size a node is drawn at, in canvas units; edges meet its sides. */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 76;
/** The gap `add` leaves between a new node and the one before it. */
const GAP_X = 72;
const GAP_Y = 40;
/** Longest delay the engine takes (`MAX_DELAY_SECONDS` on the hub). */
export const MAX_DELAY_SECONDS = 3600;

export type Action =
  | { type: 'load'; draft: Draft }
  | { type: 'rename'; name: string }
  | { type: 'describe'; description: string | null }
  | { type: 'add'; kind: NodeKind; title: string; position?: Position; agentId?: string | null }
  | { type: 'move'; id: string; position: Position }
  | { type: 'nudge'; id: string; dx: number; dy: number }
  | { type: 'update'; id: string; patch: Partial<Omit<WfNode, 'id' | 'kind'>> }
  | { type: 'remove_node'; id: string }
  | { type: 'connect'; from: string; to: string; route: Route }
  | { type: 'set_route'; id: string; route: Route }
  | { type: 'remove_edge'; id: string }
  | { type: 'remove_selected' }
  | { type: 'select'; selection: Selection }
  | { type: 'saved' };

export function emptyDraft(name = ''): Draft {
  return { name, description: null, working_dir: null, nodes: [], edges: [] };
}

export function initialState(draft: Draft = emptyDraft()): EditorState {
  return { draft, selected: null, dirty: false };
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** A fresh id for a node of this kind: `agent_1`, `agent_2`, … never one already taken. */
export function nextNodeId(kind: NodeKind, nodes: readonly { id: string }[]): string {
  const taken = new Set(nodes.map((node) => node.id));
  for (let n = 1; ; n += 1) {
    const id = `${kind}_${n}`;
    if (!taken.has(id)) return id;
  }
}

function nextEdgeId(edges: readonly WfEdge[]): string {
  const taken = new Set(edges.map((edge) => edge.id));
  for (let n = 1; ; n += 1) {
    const id = `e${n}`;
    if (!taken.has(id)) return id;
  }
}

/** What a new node of each kind says until someone changes it: runnable where it can be. */
function defaultInput(kind: NodeKind): string {
  switch (kind) {
    case 'delay':
      return '60';
    case 'condition':
      return 'input exists';
    default:
      return '';
  }
}

export function newNode(
  kind: NodeKind,
  id: string,
  title: string,
  position: Position,
  agentId: string | null = null,
): WfNode {
  return {
    id,
    kind,
    title,
    agent_id: kind === 'agent' ? agentId : null,
    model: null,
    provider: null,
    reasoning_effort: null,
    skills: [],
    input: defaultInput(kind),
    approval_required: false,
    position,
  };
}

/**
 * Where a new node goes: after the selected node (or the last one), along the reading
 * direction; below it when that spot is taken.
 */
export function placeFor(draft: Draft, after: string | null): Position {
  const anchor =
    draft.nodes.find((node) => node.id === after) ?? draft.nodes[draft.nodes.length - 1];
  if (!anchor) return { x: 40, y: 40 };
  let spot = { x: anchor.position.x + NODE_WIDTH + GAP_X, y: anchor.position.y };
  const overlaps = (p: Position) =>
    draft.nodes.some(
      (node) =>
        Math.abs(node.position.x - p.x) < NODE_WIDTH &&
        Math.abs(node.position.y - p.y) < NODE_HEIGHT,
    );
  for (let guard = 0; overlaps(spot) && guard < 50; guard += 1) {
    spot = { x: spot.x, y: spot.y + NODE_HEIGHT + GAP_Y };
  }
  return spot;
}

const round = (value: number) => Math.round(value);

export function reducer(state: EditorState, action: Action): EditorState {
  const { draft } = state;
  const change = (next: Draft, selected: Selection = state.selected): EditorState => ({
    draft: next,
    selected,
    dirty: true,
  });
  switch (action.type) {
    case 'load':
      return { draft: action.draft, selected: null, dirty: false };
    case 'saved':
      return { ...state, dirty: false };
    case 'rename':
      return change({ ...draft, name: action.name });
    case 'describe':
      return change({ ...draft, description: action.description });
    case 'select':
      return { ...state, selected: action.selection };
    case 'add': {
      const id = nextNodeId(action.kind, draft.nodes);
      const after = state.selected?.type === 'node' ? state.selected.id : null;
      const position = action.position ?? placeFor(draft, after);
      const node = newNode(action.kind, id, action.title, position, action.agentId ?? null);
      return change({ ...draft, nodes: [...draft.nodes, node] }, { type: 'node', id });
    }
    case 'move':
    case 'nudge': {
      const nodes = draft.nodes.map((node) => {
        if (node.id !== action.id) return node;
        const position =
          action.type === 'move'
            ? action.position
            : { x: node.position.x + action.dx, y: node.position.y + action.dy };
        return { ...node, position: { x: round(position.x), y: round(position.y) } };
      });
      return change({ ...draft, nodes });
    }
    case 'update': {
      if (!draft.nodes.some((node) => node.id === action.id)) return state;
      const nodes = draft.nodes.map((node) =>
        node.id === action.id ? { ...node, ...action.patch } : node,
      );
      return change({ ...draft, nodes });
    }
    case 'remove_node': {
      if (!draft.nodes.some((node) => node.id === action.id)) return state;
      const nodes = draft.nodes.filter((node) => node.id !== action.id);
      // An edge never outlives either end.
      const edges = draft.edges.filter((edge) => edge.from !== action.id && edge.to !== action.id);
      const selected = removedSelection(state.selected, action.id, edges);
      return change({ ...draft, nodes, edges }, selected);
    }
    case 'connect': {
      const { from, to, route } = action;
      const ids = new Set(draft.nodes.map((node) => node.id));
      if (from === to || !ids.has(from) || !ids.has(to)) return state;
      const existing = draft.edges.find(
        (edge) => edge.from === from && edge.to === to && edge.route === route,
      );
      if (existing) return { ...state, selected: { type: 'edge', id: existing.id } };
      const id = nextEdgeId(draft.edges);
      return change(
        { ...draft, edges: [...draft.edges, { id, from, to, route }] },
        { type: 'edge', id },
      );
    }
    case 'set_route': {
      const edges = draft.edges.map((edge) =>
        edge.id === action.id ? { ...edge, route: action.route } : edge,
      );
      return change({ ...draft, edges });
    }
    case 'remove_edge': {
      if (!draft.edges.some((edge) => edge.id === action.id)) return state;
      const edges = draft.edges.filter((edge) => edge.id !== action.id);
      const selected =
        state.selected?.type === 'edge' && state.selected.id === action.id ? null : state.selected;
      return change({ ...draft, edges }, selected);
    }
    case 'remove_selected': {
      const selected = state.selected;
      if (!selected) return state;
      return selected.type === 'node'
        ? reducer(state, { type: 'remove_node', id: selected.id })
        : reducer(state, { type: 'remove_edge', id: selected.id });
    }
  }
}

function removedSelection(selected: Selection, nodeId: string, edges: WfEdge[]): Selection {
  if (!selected) return null;
  if (selected.type === 'node') return selected.id === nodeId ? null : selected;
  return edges.some((edge) => edge.id === selected.id) ? selected : null;
}

// ------------------------------------------------------------- to and from the hub

/** The hub's `Workflow` (or anything with its drawing fields). */
export interface WorkflowLike {
  name: string;
  description?: string | null;
  working_dir?: string | null;
  nodes: readonly unknown[];
  edges: readonly unknown[];
}

const KINDS = new Set<string>(NODE_KINDS);
const ROUTES = new Set<string>(['always', 'success', 'failure']);

/** A saved workflow as the editor's drawing. Unknown kinds or routes are left out. */
export function fromWorkflow(workflow: WorkflowLike): Draft {
  const nodes: WfNode[] = [];
  for (const raw of workflow.nodes as Array<Partial<WfNode>>) {
    if (!raw || typeof raw.id !== 'string' || !KINDS.has(String(raw.kind))) continue;
    nodes.push({
      id: raw.id,
      kind: raw.kind as NodeKind,
      title: raw.title ?? '',
      agent_id: raw.agent_id ?? null,
      model: raw.model ?? null,
      provider: raw.provider ?? null,
      reasoning_effort: raw.reasoning_effort ?? null,
      skills: Array.isArray(raw.skills) ? [...raw.skills] : [],
      input: raw.input ?? null,
      approval_required: raw.approval_required === true,
      position: {
        x: Number(raw.position?.x ?? 0) || 0,
        y: Number(raw.position?.y ?? 0) || 0,
      },
    });
  }
  const edges: WfEdge[] = [];
  for (const raw of workflow.edges as Array<Partial<WfEdge>>) {
    if (!raw || typeof raw.id !== 'string' || !ROUTES.has(String(raw.route))) continue;
    edges.push({
      id: raw.id,
      from: String(raw.from),
      to: String(raw.to),
      route: raw.route as Route,
    });
  }
  return {
    name: workflow.name,
    description: workflow.description ?? null,
    working_dir: workflow.working_dir ?? null,
    nodes,
    edges,
  };
}

/** The drawing as the contract's `WorkflowWrite`: what `createWorkflow`/`updateWorkflow` take. */
export function toWrite(draft: Draft) {
  return {
    name: draft.name.trim(),
    description: draft.description?.trim() ? draft.description.trim() : null,
    working_dir: draft.working_dir,
    nodes: draft.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      agent_id: node.kind === 'agent' ? node.agent_id : null,
      model: node.kind === 'agent' ? node.model : null,
      provider: node.kind === 'agent' ? node.provider : null,
      reasoning_effort: node.reasoning_effort,
      skills: [...node.skills],
      input: node.input,
      approval_required: node.kind === 'approval' ? false : node.approval_required,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: draft.edges.map((edge) => ({ ...edge })),
  };
}

/** Whether every id is one the contract accepts (`^[A-Za-z0-9_-]{1,40}$`). */
export function idsValid(draft: Draft): boolean {
  return draft.nodes.every((node) => ID_PATTERN.test(node.id));
}

/**
 * The steps that can have finished before this one: everything with a path to it. These
 * are the `{{steps.<id>.output}}` a prompt can use; a later step's output would be empty.
 */
export function upstreamOf(draft: Draft, nodeId: string): WfNode[] {
  const into = new Map<string, string[]>();
  for (const edge of draft.edges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from]);
  const seen = new Set<string>();
  const stack = [...(into.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id) || id === nodeId) continue;
    seen.add(id);
    stack.push(...(into.get(id) ?? []));
  }
  return draft.nodes.filter((node) => seen.has(node.id));
}

/** Insert `text` into `value` at the caret (or at the end), returning the new value and caret. */
export function insertAt(
  value: string,
  text: string,
  start: number | null,
  end: number | null,
): { value: string; caret: number } {
  const from = start ?? value.length;
  const to = end ?? from;
  return { value: value.slice(0, from) + text + value.slice(to), caret: from + text.length };
}

// ------------------------------------------------------------- conditions

/** The comparisons the engine understands (`expr.ts` on the hub), in the order offered. */
export const OPERATORS = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'matches',
  'exists',
  'empty',
] as const;
export type Operator = (typeof OPERATORS)[number];
export const UNARY: ReadonlySet<Operator> = new Set(['exists', 'empty']);

export interface ConditionParts {
  path: string;
  operator: Operator;
  value: string;
}

/**
 * A condition's text as its three parts, for the form. `null` when the text is not one
 * comparison the form can show — the form then offers the text as it is, and the hub's
 * check says what is wrong with it.
 */
export function splitCondition(text: string): ConditionParts | null {
  const trimmed = text.trim();
  if (trimmed === '') return { path: '', operator: '==', value: '' };
  for (const unary of ['exists', 'empty'] as const) {
    if (trimmed.endsWith(` ${unary}`)) {
      return { path: trimmed.slice(0, -unary.length - 1).trim(), operator: unary, value: '' };
    }
  }
  for (const operator of ['==', '!=', '>=', '<=', 'contains', 'matches', '>', '<'] as const) {
    const at = trimmed.indexOf(` ${operator} `);
    if (at === -1) continue;
    const raw = trimmed.slice(at + operator.length + 2).trim();
    const quoted = /^"(.*)"$/s.exec(raw) ?? /^'(.*)'$/s.exec(raw);
    return {
      path: trimmed.slice(0, at).trim(),
      operator,
      value: quoted ? (quoted[1] ?? '') : raw,
    };
  }
  return null;
}

/** The three parts as the text the engine reads; a value that is not a number is quoted. */
export function joinCondition(parts: ConditionParts): string {
  const path = parts.path.trim();
  if (UNARY.has(parts.operator)) return `${path} ${parts.operator}`;
  const value = parts.value;
  const numeric = value.trim() !== '' && Number.isFinite(Number(value.trim()));
  return `${path} ${parts.operator} ${numeric ? value.trim() : `"${value}"`}`;
}

// ------------------------------------------------------------- a run on the canvas

export type NodeRunState = 'idle' | 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface RunStep {
  node_id: string;
  attempt: number;
  status: string;
  approval_id: string | null;
  output?: string | null;
  route?: 'success' | 'failure' | null;
  error: string | null;
}

export interface RunLike {
  status: string;
  steps: readonly RunStep[];
}

/** The latest attempt of each node in a run. */
export function latestSteps(run: RunLike): Map<string, RunStep> {
  const out = new Map<string, RunStep>();
  for (const step of run.steps) {
    const seen = out.get(step.node_id);
    if (!seen || step.attempt > seen.attempt) out.set(step.node_id, step);
  }
  return out;
}

/**
 * Each node's state in a run, as the canvas colours it: a node the run reached has its
 * step's state; a node it never reached is `skipped` once the run is over, and `idle`
 * while it may still be reached.
 */
export function nodeStates(draft: Draft, run: RunLike): Map<string, NodeRunState> {
  const steps = latestSteps(run);
  const over = ['succeeded', 'failed', 'cancelled'].includes(run.status);
  const out = new Map<string, NodeRunState>();
  for (const node of draft.nodes) {
    const step = steps.get(node.id);
    out.set(node.id, step ? stateOfStep(step.status) : over ? 'skipped' : 'idle');
  }
  return out;
}

function stateOfStep(status: string): NodeRunState {
  switch (status) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'running':
      return 'running';
    case 'waiting_approval':
    case 'pending':
    case 'queued':
      return 'waiting';
    case 'skipped':
    case 'cancelled':
      return 'skipped';
    default:
      return 'idle';
  }
}

/**
 * The edges a run went along: from a step that finished, on its route (`always` either
 * way), to a node the run then reached.
 */
export function takenEdges(draft: Draft, run: RunLike): Set<string> {
  const steps = latestSteps(run);
  const out = new Set<string>();
  for (const edge of draft.edges) {
    const from = steps.get(edge.from);
    if (!from || !steps.has(edge.to)) continue;
    const route = from.route ?? routeFromStatus(from.status);
    if (!route) continue;
    if (edge.route === 'always' || edge.route === route) out.add(edge.id);
  }
  return out;
}

function routeFromStatus(status: string): 'success' | 'failure' | null {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'rejected') return 'failure';
  return null;
}

// ------------------------------------------------------------- the hub's check

export interface WorkflowIssue {
  code: string;
  node_id: string | null;
  edge_id: string | null;
  detail: string | null;
  message: string;
}

export interface Validation {
  valid: boolean;
  problems: WorkflowIssue[];
  warnings: WorkflowIssue[];
}

/** The findings about each node and each edge, problems first. */
export function issuesByTarget(validation: Validation | null): {
  nodes: Map<string, WorkflowIssue[]>;
  edges: Map<string, WorkflowIssue[]>;
  general: WorkflowIssue[];
} {
  const nodes = new Map<string, WorkflowIssue[]>();
  const edges = new Map<string, WorkflowIssue[]>();
  const general: WorkflowIssue[] = [];
  for (const issue of [...(validation?.problems ?? []), ...(validation?.warnings ?? [])]) {
    if (issue.node_id) nodes.set(issue.node_id, [...(nodes.get(issue.node_id) ?? []), issue]);
    else if (issue.edge_id) edges.set(issue.edge_id, [...(edges.get(issue.edge_id) ?? []), issue]);
    else general.push(issue);
  }
  return { nodes, edges, general };
}

/** Problems are refusals; warnings are not. */
export function isProblem(validation: Validation | null, issue: WorkflowIssue): boolean {
  return (validation?.problems ?? []).includes(issue);
}
