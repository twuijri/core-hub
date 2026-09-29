/**
 * The workflow editor like n8n (2026-09-29): a step added from a "+" comes after that step and
 * is connected to it; triggers added before the first save wait in the editor's state (never in
 * the drawing that is saved); and the canvas draws each trigger before the steps a run starts
 * at — the ones nothing leads into, which is the engine's own rule.
 */
import { describe, expect, it } from 'vitest';
import {
  NODE_HEIGHT,
  emptyDraft,
  hasUnsaved,
  initialState,
  nextPendingId,
  reducer,
  toWrite,
  type Action,
  type EditorState,
} from '../src/schedules/workflows/model.js';
import {
  TRIGGER_HEIGHT,
  TRIGGER_WIDTH,
  firstStepPlace,
  firstSteps,
  triggerPlaces,
} from '../src/schedules/workflows/trigger-nodes.js';

const apply = (state: EditorState, ...actions: Action[]) => actions.reduce(reducer, state);

describe('adding from a "+"', () => {
  it('puts the new step after the one it came from and connects them on that route', () => {
    const state = apply(
      initialState(emptyDraft('flow')),
      { type: 'add', kind: 'condition', title: 'Is it new?' },
      {
        type: 'add',
        kind: 'notify',
        title: 'No',
        after: { from: 'condition_1', route: 'failure' },
        patch: { send: { targets: [] } },
      },
    );
    const [condition, notice] = state.draft.nodes;
    expect(notice).toMatchObject({ id: 'notify_1', send: { targets: [] } });
    expect(notice!.position.x).toBeGreaterThan(condition!.position.x);
    expect(state.draft.edges).toEqual([
      { id: 'e1', from: 'condition_1', to: 'notify_1', route: 'failure' },
    ]);
    expect(state.selected).toEqual({ type: 'node', id: 'notify_1' });
  });

  it('adds an unconnected step when the step it names is gone', () => {
    const state = apply(initialState(emptyDraft('flow')), {
      type: 'add',
      kind: 'agent',
      title: 'Ask',
      after: { from: 'ghost', route: 'success' },
    });
    expect(state.draft.nodes).toHaveLength(1);
    expect(state.draft.edges).toEqual([]);
  });
});

describe('triggers that wait for the first save', () => {
  it('are unsaved work, kept apart from the drawing that is saved', () => {
    let state = initialState(emptyDraft('flow'));
    expect(hasUnsaved(state)).toBe(false);
    const id = nextPendingId(state.pending);
    state = reducer(state, {
      type: 'pending_add',
      trigger: { id, kind: 'schedule', schedule: { mode: 'cron', value: '0 9 * * *' } },
    });
    expect(state.dirty).toBe(false);
    expect(hasUnsaved(state)).toBe(true);
    expect(nextPendingId(state.pending)).toBe('pending-2');
    state = reducer(state, {
      type: 'pending_update',
      trigger: { id, kind: 'schedule', schedule: { mode: 'interval', value: '15' } },
    });
    expect(state.pending[0]).toMatchObject({ schedule: { mode: 'interval', value: '15' } });
    expect(toWrite(state.draft)).not.toHaveProperty('pending');
    // A save does not drop them; making them does.
    state = reducer(state, { type: 'saved' });
    expect(state.pending).toHaveLength(1);
    state = reducer(state, { type: 'pending_remove', ids: [id] });
    expect(hasUnsaved(state)).toBe(false);
  });

  it('come back with the drawing someone left without saving', () => {
    const left = apply(initialState(emptyDraft('flow')), {
      type: 'add',
      kind: 'agent',
      title: 'Ask',
    });
    const state = reducer(initialState(emptyDraft()), {
      type: 'restore',
      draft: left.draft,
      pending: [{ id: 'pending-1', kind: 'webhook', preset: 'github' }],
    });
    expect(state.draft.nodes.map((node) => node.id)).toEqual(['agent_1']);
    expect(state.dirty).toBe(true);
    expect(state.pending).toHaveLength(1);
  });
});

describe('trigger nodes on the canvas', () => {
  const draft = apply(
    initialState(emptyDraft('flow')),
    { type: 'add', kind: 'agent', title: 'A', position: { x: 300, y: 100 } },
    { type: 'add', kind: 'agent', title: 'B', position: { x: 300, y: 300 } },
    { type: 'add', kind: 'notify', title: 'C', position: { x: 600, y: 200 } },
    { type: 'connect', from: 'agent_1', to: 'notify_1', route: 'success' },
  ).draft;

  it('start at the steps nothing leads into', () => {
    expect(firstSteps(draft).map((node) => node.id)).toEqual(['agent_1', 'agent_2']);
  });

  it('stand in one column before the first step, centred on the steps they start', () => {
    const places = triggerPlaces(draft, 2);
    expect(places).toHaveLength(2);
    for (const place of places) expect(place.x + TRIGGER_WIDTH).toBeLessThan(300);
    const centre = (places[0]!.y + places[1]!.y + TRIGGER_HEIGHT) / 2;
    expect(centre).toBeCloseTo((100 + 300 + NODE_HEIGHT) / 2, 0);
    expect(places[1]!.y - places[0]!.y).toBeGreaterThanOrEqual(TRIGGER_HEIGHT);
  });

  it('put a first step added from a trigger after it, below any step already there', () => {
    const [place] = triggerPlaces(emptyDraft(), 1);
    const spot = firstStepPlace(emptyDraft(), place!);
    expect(spot.x).toBeGreaterThan(place!.x + TRIGGER_WIDTH);
    const taken = firstStepPlace({ nodes: [{ ...draft.nodes[0]!, position: spot }] }, place!);
    expect(taken.y).toBeGreaterThan(spot.y);
  });
});
