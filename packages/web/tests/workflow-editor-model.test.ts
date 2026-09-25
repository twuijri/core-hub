/**
 * The workflow editor's state (DECISIONS §48): adding, connecting and deleting keep the
 * drawing consistent, the drawing is the contract's `WorkflowWrite` both ways, a condition
 * form round-trips the engine's text, and a run is read onto the canvas — each node's state
 * and the edges taken. And the canvas arithmetic: a flow runs the way the page reads.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  fromWorkflow,
  initialState,
  issuesByTarget,
  joinCondition,
  nodeStates,
  reducer,
  splitCondition,
  takenEdges,
  toWrite,
  upstreamOf,
  insertAt,
  type Action,
  type EditorState,
} from '../src/schedules/workflows/model.js';
import { edgeCurve, fitView, toWorld, zoomAt } from '../src/schedules/workflows/geometry.js';

const apply = (state: EditorState, ...actions: Action[]) => actions.reduce(reducer, state);

function twoSteps() {
  return apply(
    initialState(emptyDraft('flow')),
    { type: 'add', kind: 'agent', title: 'Ask', agentId: 'A1' },
    { type: 'add', kind: 'notify', title: 'Tell' },
    { type: 'connect', from: 'agent_1', to: 'notify_1', route: 'success' },
  );
}

describe('workflow editor: the drawing', () => {
  it('adds steps with unique ids, after the selected one, and selects the new one', () => {
    const state = twoSteps();
    expect(state.draft.nodes.map((n) => [n.id, n.kind, n.title])).toEqual([
      ['agent_1', 'agent', 'Ask'],
      ['notify_1', 'notify', 'Tell'],
    ]);
    expect(state.draft.nodes[0]!.agent_id).toBe('A1');
    expect(state.draft.nodes[1]!.agent_id).toBeNull();
    // Along the reading direction, not on top of the first.
    expect(state.draft.nodes[1]!.position.x).toBeGreaterThan(state.draft.nodes[0]!.position.x);
    expect(state.selected).toEqual({ type: 'edge', id: 'e1' });
    expect(state.dirty).toBe(true);

    const third = apply(state, { type: 'add', kind: 'agent', title: 'Again' });
    expect(third.draft.nodes.at(-1)!.id).toBe('agent_2');
    expect(third.selected).toEqual({ type: 'node', id: 'agent_2' });
    // A delay and a condition start runnable.
    const more = apply(
      third,
      { type: 'add', kind: 'delay', title: 'Wait' },
      { type: 'add', kind: 'condition', title: 'If' },
    );
    expect(more.draft.nodes.find((n) => n.kind === 'delay')!.input).toBe('60');
    expect(more.draft.nodes.find((n) => n.kind === 'condition')!.input).toBe('input exists');
  });

  it('connects once per route, never a node to itself or to nothing', () => {
    let state = twoSteps();
    state = apply(state, { type: 'connect', from: 'agent_1', to: 'notify_1', route: 'success' });
    expect(state.draft.edges).toHaveLength(1);
    state = apply(state, { type: 'connect', from: 'agent_1', to: 'notify_1', route: 'failure' });
    expect(state.draft.edges.map((e) => [e.id, e.route])).toEqual([
      ['e1', 'success'],
      ['e2', 'failure'],
    ]);
    const same = apply(
      state,
      { type: 'connect', from: 'agent_1', to: 'agent_1', route: 'success' },
      { type: 'connect', from: 'agent_1', to: 'ghost', route: 'success' },
    );
    expect(same.draft.edges).toHaveLength(2);
    const rerouted = apply(state, { type: 'set_route', id: 'e2', route: 'always' });
    expect(rerouted.draft.edges[1]!.route).toBe('always');
  });

  it('deleting a node takes its edges with it; deleting the selection works for both', () => {
    let state = twoSteps();
    state = apply(state, { type: 'select', selection: { type: 'node', id: 'agent_1' } });
    state = apply(state, { type: 'remove_selected' });
    expect(state.draft.nodes.map((n) => n.id)).toEqual(['notify_1']);
    expect(state.draft.edges).toEqual([]);
    expect(state.selected).toBeNull();

    let other = twoSteps();
    other = apply(other, { type: 'remove_selected' }); // the new edge was selected
    expect(other.draft.edges).toEqual([]);
    expect(other.draft.nodes).toHaveLength(2);
  });

  it('moves and nudges a node to whole units', () => {
    const state = apply(
      twoSteps(),
      { type: 'move', id: 'agent_1', position: { x: 10.4, y: 20.6 } },
      { type: 'nudge', id: 'agent_1', dx: 16, dy: -16 },
    );
    expect(state.draft.nodes[0]!.position).toEqual({ x: 26, y: 5 });
  });

  it('serializes to the contract and back without losing anything', () => {
    const state = apply(
      twoSteps(),
      { type: 'update', id: 'agent_1', patch: { input: 'Sum up {{input}}', model: 'or/m' } },
      { type: 'update', id: 'notify_1', patch: { input: 'Said: {{steps.agent_1.output}}' } },
    );
    const write = toWrite(state.draft);
    expect(write).toEqual({
      name: 'flow',
      description: null,
      working_dir: null,
      nodes: [
        {
          id: 'agent_1',
          kind: 'agent',
          title: 'Ask',
          agent_id: 'A1',
          model: 'or/m',
          provider: null,
          reasoning_effort: null,
          skills: [],
          input: 'Sum up {{input}}',
          approval_required: false,
          position: state.draft.nodes[0]!.position,
        },
        {
          id: 'notify_1',
          kind: 'notify',
          title: 'Tell',
          agent_id: null,
          model: null,
          provider: null,
          reasoning_effort: null,
          skills: [],
          input: 'Said: {{steps.agent_1.output}}',
          approval_required: false,
          position: state.draft.nodes[1]!.position,
        },
      ],
      edges: [{ id: 'e1', from: 'agent_1', to: 'notify_1', route: 'success' }],
    });
    expect(fromWorkflow(write)).toEqual(state.draft);
    // Something this client does not draw is left out rather than drawn wrong.
    const odd = fromWorkflow({
      ...write,
      nodes: [...write.nodes, { id: 'x', kind: 'teleport' }],
      edges: [...write.edges, { id: 'y', from: 'a', to: 'b', route: 'sometimes' }],
    });
    expect(odd.nodes).toHaveLength(2);
    expect(odd.edges).toHaveLength(1);
  });

  it('offers only earlier steps to a template, and inserts at the caret', () => {
    const state = apply(twoSteps(), { type: 'add', kind: 'approval', title: 'Gate' });
    const withGate = apply(state, {
      type: 'connect',
      from: 'notify_1',
      to: 'approval_1',
      route: 'success',
    });
    expect(upstreamOf(withGate.draft, 'approval_1').map((n) => n.id)).toEqual([
      'agent_1',
      'notify_1',
    ]);
    expect(upstreamOf(withGate.draft, 'agent_1')).toEqual([]);
    expect(insertAt('Say  now', '{{input}}', 4, 4)).toEqual({
      value: 'Say {{input}} now',
      caret: 13,
    });
    expect(insertAt('abc', 'X', null, null)).toEqual({ value: 'abcX', caret: 4 });
  });
});

describe('workflow editor: conditions', () => {
  it('splits and joins the engine’s one comparison', () => {
    expect(splitCondition('steps.a.output == "urgent"')).toEqual({
      path: 'steps.a.output',
      operator: '==',
      value: 'urgent',
    });
    expect(splitCondition('amount >= 100')).toEqual({
      path: 'amount',
      operator: '>=',
      value: '100',
    });
    expect(splitCondition('input exists')).toEqual({ path: 'input', operator: 'exists', value: '' });
    expect(splitCondition('nonsense here')).toBeNull();
    expect(joinCondition({ path: 'amount', operator: '>', value: '10' })).toBe('amount > 10');
    expect(joinCondition({ path: 'kind', operator: '==', value: 'invoice x' })).toBe(
      'kind == "invoice x"',
    );
    expect(joinCondition({ path: 'items', operator: 'empty', value: 'ignored' })).toBe(
      'items empty',
    );
    for (const text of ['a.b != "x"', 'n <= 5', 'body contains "hi"', 'items empty']) {
      expect(joinCondition(splitCondition(text)!)).toBe(text);
    }
  });
});

describe('workflow editor: a run on the canvas', () => {
  const draft = apply(
    initialState(emptyDraft('flow')),
    { type: 'add', kind: 'condition', title: 'If' },
    { type: 'add', kind: 'notify', title: 'Yes' },
    { type: 'add', kind: 'notify', title: 'No' },
    { type: 'connect', from: 'condition_1', to: 'notify_1', route: 'success' },
    { type: 'connect', from: 'condition_1', to: 'notify_2', route: 'failure' },
  ).draft;

  it('colours each node by its step, and names the edges the run went along', () => {
    const run = {
      status: 'succeeded',
      steps: [
        {
          node_id: 'condition_1',
          attempt: 1,
          status: 'succeeded',
          approval_id: null,
          output: 'false',
          route: 'failure' as const,
          error: null,
        },
        {
          node_id: 'notify_2',
          attempt: 1,
          status: 'succeeded',
          approval_id: null,
          output: 'No',
          route: 'success' as const,
          error: null,
        },
      ],
    };
    expect(Object.fromEntries(nodeStates(draft, run))).toEqual({
      condition_1: 'done',
      notify_1: 'skipped',
      notify_2: 'done',
    });
    expect([...takenEdges(draft, run)]).toEqual(['e2']);
  });

  it('a run still going leaves unreached steps idle, and a waiting step waits', () => {
    const run = {
      status: 'waiting',
      steps: [
        {
          node_id: 'condition_1',
          attempt: 1,
          status: 'waiting_approval',
          approval_id: 'AP',
          error: null,
        },
      ],
    };
    expect(nodeStates(draft, run).get('condition_1')).toBe('waiting');
    expect(nodeStates(draft, run).get('notify_1')).toBe('idle');
    expect(takenEdges(draft, run).size).toBe(0);
  });

  it('files each finding under the node or edge it names', () => {
    const problem = {
      code: 'delay_out_of_range',
      node_id: 'd',
      edge_id: null,
      detail: '3600',
      message: 'm',
    };
    const warning = { code: 'no_start', node_id: null, edge_id: null, detail: null, message: 'w' };
    const edge = { code: 'edge_to_unknown', node_id: null, edge_id: 'e9', detail: 'x', message: 'e' };
    const found = issuesByTarget({ valid: false, problems: [problem, edge], warnings: [warning] });
    expect(found.nodes.get('d')).toEqual([problem]);
    expect(found.edges.get('e9')).toEqual([edge]);
    expect(found.general).toEqual([warning]);
  });
});

describe('workflow editor: the canvas follows the reading direction', () => {
  it('mirrors x in a right-to-left language, and a zoom keeps the point under the pointer', () => {
    const ltr = fitView([{ position: { x: 0, y: 0 } }, { position: { x: 400, y: 0 } }], 800, 400, false);
    const rtl = fitView([{ position: { x: 0, y: 0 } }, { position: { x: 400, y: 0 } }], 800, 400, true);
    // The first step is at the start of the line: the left in English, the right in Arabic.
    const firstLtr = ltr.tx + ltr.zoom * 0;
    const firstRtl = rtl.tx - rtl.zoom * 0;
    const lastLtr = ltr.tx + ltr.zoom * 400;
    const lastRtl = rtl.tx - rtl.zoom * 400;
    expect(firstLtr).toBeLessThan(lastLtr);
    expect(firstRtl).toBeGreaterThan(lastRtl);
    // Screen → drawing is the inverse in both directions.
    for (const view of [ltr, rtl]) {
      const rtlView = view === rtl;
      const at = toWorld(view, rtlView, 300, 120);
      const zoomed = zoomAt(view, rtlView, 1.5, 300, 120);
      const again = toWorld(zoomed, rtlView, 300, 120);
      expect(again.x).toBeCloseTo(at.x, 6);
      expect(again.y).toBeCloseTo(at.y, 6);
    }
  });

  it('draws an edge as a curve from port to port', () => {
    const { d, mid } = edgeCurve({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(d.startsWith('M 0 0 C')).toBe(true);
    expect(mid).toEqual({ x: 100, y: 50 });
  });
});
