/**
 * A workflow's triggers as nodes at the start of its drawing (owner, 2026-09-29: "like n8n").
 *
 * Nothing here is saved in the drawing. A trigger is its own record on the hub — a webhook
 * (`WorkflowTrigger`, DECISIONS §123), a schedule whose target is the workflow, or "Run" by
 * hand — and every one of them starts a run the same way: at the steps nothing leads into
 * (`workflow-engine.ts` → `start`). So the canvas draws each trigger as a node before the
 * first steps and a line from it to each of them; the lines are that rule drawn, not edges of
 * the drawing, and they change only when the steps do. The drawing, its edges and what the
 * phones read stay exactly as they were.
 */
import { NODE_HEIGHT, NODE_WIDTH, type Draft, type Position, type WfNode } from './model.js';

export type TriggerKind = 'manual' | 'webhook' | 'schedule';

/** One trigger as the canvas draws it. */
export interface CanvasTrigger {
  /** `manual`, a webhook trigger's id, `schedule:<id>`, or a pending trigger's local id. */
  id: string;
  kind: TriggerKind;
  title: string;
  /** One line under the title: the preset, when it runs, the input to send. */
  detail: string;
  /** Made when the workflow is first saved. */
  pending: boolean;
  /** Off: it starts nothing until switched on again. */
  enabled: boolean;
}

export const MANUAL_TRIGGER_ID = 'manual';

/** The size a trigger node is drawn at, in canvas units. */
export const TRIGGER_WIDTH = 184;
export const TRIGGER_HEIGHT = 64;
/** The room between the triggers and the first steps, and between two triggers. */
const GAP_X = 104;
const GAP_Y = 20;
/** Where the drawing starts when it has no step yet. */
const ORIGIN: Position = { x: 40, y: 40 };

/** The steps a run starts at: those nothing leads into (the engine's own rule). */
export function firstSteps(draft: Pick<Draft, 'nodes' | 'edges'>): WfNode[] {
  const reached = new Set(draft.edges.map((edge) => edge.to));
  return draft.nodes.filter((node) => !reached.has(node.id));
}

/**
 * Where each of `count` triggers is drawn: one column before the drawing's first step,
 * centred on the steps they start.
 */
export function triggerPlaces(draft: Pick<Draft, 'nodes' | 'edges'>, count: number): Position[] {
  if (count <= 0) return [];
  const nodes = draft.nodes;
  const starts = firstSteps(draft);
  const around = starts.length > 0 ? starts : nodes;
  const x =
    nodes.length > 0
      ? Math.min(...nodes.map((node) => node.position.x)) - GAP_X - TRIGGER_WIDTH
      : ORIGIN.x;
  const centre =
    around.length > 0
      ? around.reduce((sum, node) => sum + node.position.y + NODE_HEIGHT / 2, 0) / around.length
      : ORIGIN.y + NODE_HEIGHT / 2;
  const tall = count * TRIGGER_HEIGHT + (count - 1) * GAP_Y;
  const top = Math.round(centre - tall / 2);
  return Array.from({ length: count }, (_, index) => ({
    x: Math.round(x),
    y: top + index * (TRIGGER_HEIGHT + GAP_Y),
  }));
}

/** Where a trigger's line leaves it. */
export function triggerPort(position: Position): Position {
  return { x: position.x + TRIGGER_WIDTH, y: position.y + TRIGGER_HEIGHT / 2 };
}

/** Where a first step added from a trigger's "+" goes: after the triggers, below any step there. */
export function firstStepPlace(draft: Pick<Draft, 'nodes'>, trigger: Position | null): Position {
  const base = trigger
    ? { x: trigger.x + TRIGGER_WIDTH + GAP_X, y: trigger.y + TRIGGER_HEIGHT / 2 - NODE_HEIGHT / 2 }
    : ORIGIN;
  let spot = { x: Math.round(base.x), y: Math.round(base.y) };
  const overlaps = (p: Position) =>
    draft.nodes.some(
      (node) =>
        Math.abs(node.position.x - p.x) < NODE_WIDTH &&
        Math.abs(node.position.y - p.y) < NODE_HEIGHT,
    );
  for (let guard = 0; overlaps(spot) && guard < 50; guard += 1) {
    spot = { x: spot.x, y: spot.y + NODE_HEIGHT + 40 };
  }
  return spot;
}
