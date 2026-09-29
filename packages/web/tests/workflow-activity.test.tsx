/**
 * A workflow card while its run goes (owner, 2026-09-29): the card's state from the listed
 * workflow and its live run — running with the step it is on, waiting for approval, idle when
 * the run is over — and, on the whole app with a scripted hub, the Workflows page following
 * `/rt/schedules`: a run that a trigger started elsewhere turns the card green with the step's
 * title and puts a dot on the sidebar's Workflows entry, and `workflow_run.completed` brings it
 * back to Idle without a reload. The browser journey (e2e zzzzzzzzzzzzzzzzz-workflow-running)
 * proves the same against the real hub, started by a real trigger delivery.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardActivity } from '../src/schedules/workflows/activity.js';
import { frameOf } from '../src/schedules/workflows/WorkflowActivity.js';

type Handler = (payload: unknown) => void;
const sockets: FakeSocket[] = [];

class FakeSocket {
  connected = true;
  active = true;
  io = { on: () => undefined };
  handlers = new Map<string, Set<Handler>>();
  constructor(readonly namespace: string) {
    sockets.push(this);
  }
  on(name: string, handler: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
    return this;
  }
  off(name: string, handler: Handler) {
    this.handlers.get(name)?.delete(handler);
    return this;
  }
  once() {
    return this;
  }
  connect() {
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
  /** The hub sends `name` on this namespace. */
  receive(name: string, payload: Record<string, unknown>) {
    const envelope = {
      event: name,
      namespace: this.namespace,
      profile: 'default',
      ts: new Date().toISOString(),
      seq: 1,
      payload,
    };
    for (const handler of this.handlers.get(name) ?? []) handler(envelope);
  }
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    connectNamespace: (options: { namespace: string }) => new FakeSocket(options.namespace),
  };
});

const { App } = await import('../src/app.js');
const { SessionStore } = await import('../src/auth/store.js');

const WF = '01J8QK3ZR2W7M5N4P6T8V9X0WF';
const QUIET = '01J8QK3ZR2W7M5N4P6T8V9X0WQ';
const RUN = '01J8QK3ZR2W7M5N4P6T8V9X0WR';

const node = (id: string, title: string, kind = 'delay') => ({
  id,
  kind,
  title,
  agent_id: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input: '5',
  approval_required: false,
  position: { x: 0, y: 0 },
});

const step = (node_id: string, status: string) => ({
  node_id,
  attempt: 1,
  status,
  approval_id: status === 'waiting_approval' ? '01J8QK3ZR2W7M5N4P6T8V9X0AP' : null,
  error: null,
});

describe('a card’s state', () => {
  const nodes = [node('wait', 'Wait a moment'), node('ok', '  ', 'approval')];
  const listed = (active: string | null, status: 'idle' | 'running' | 'waiting' | 'error') => ({
    active_run_id: active,
    status,
    nodes,
  });

  it('is idle with no run going, and says an error the list reports', () => {
    expect(cardActivity(listed(null, 'idle'), undefined)).toEqual({ state: 'idle' });
    expect(cardActivity(listed(null, 'error'), undefined)).toEqual({ state: 'error' });
  });

  it('is running before its run is read, and running on the step that works once it is', () => {
    expect(cardActivity(listed(RUN, 'running'), undefined)).toEqual({
      state: 'running',
      step: null,
    });
    expect(
      cardActivity(listed(RUN, 'running'), {
        id: RUN,
        status: 'running',
        steps: [step('wait', 'running')],
      }),
    ).toEqual({ state: 'running', step: 'Wait a moment' });
    // A run of another id (the list moved on) says nothing about the step.
    expect(
      cardActivity(listed(RUN, 'running'), {
        id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
        status: 'running',
        steps: [step('wait', 'running')],
      }),
    ).toEqual({ state: 'running', step: null });
  });

  it('waits for approval at the gate, and a gate with a blank title is named by the words alone', () => {
    const run = {
      id: RUN,
      status: 'waiting' as const,
      steps: [step('wait', 'succeeded'), step('ok', 'waiting_approval')],
    };
    expect(cardActivity(listed(RUN, 'running'), run)).toEqual({ state: 'waiting', step: null });
    expect(
      cardActivity({ ...listed(RUN, 'running'), nodes: [node('ok', 'Sign off')] }, run),
    ).toEqual({ state: 'waiting', step: 'Sign off' });
  });

  it('is idle once the run is over, even before the list catches up', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(
        cardActivity(listed(RUN, 'running'), {
          id: RUN,
          status,
          steps: [step('wait', 'succeeded')],
        }),
      ).toEqual({ state: 'idle' });
    }
  });

  it('draws a frame only while a run goes or waits', () => {
    expect(frameOf({ state: 'running', step: null })).toBe('running');
    expect(frameOf({ state: 'waiting', step: null })).toBe('waiting');
    expect(frameOf({ state: 'idle' })).toBeUndefined();
    expect(frameOf({ state: 'error' })).toBeUndefined();
  });
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

describe('the Workflows page follows a run it did not start', () => {
  afterEach(() => {
    cleanup();
    sockets.length = 0;
  });
  beforeEach(() => localStorage.clear());

  function hub(state: { running: boolean }) {
    const workflow = (id: string, name: string, live: boolean) => ({
      id,
      profile: 'default',
      owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0AA',
      created_at: '2026-09-29T08:00:00Z',
      updated_at: '2026-09-29T08:00:00Z',
      name,
      description: null,
      working_dir: null,
      nodes: [node('wait', 'Wait a moment')],
      edges: [],
      status: live ? 'running' : 'idle',
      active_run_id: live ? RUN : null,
      run_count: 3,
      schedule_count: 0,
      limits: {},
      on_failure: null,
    });
    return ((url: string) => {
      const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
      const json = (value: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (path.endsWith('/profiles'))
        return json({
          items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
        });
      if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
      if (path === '/workflows')
        return json({
          items: [
            workflow(WF, 'From ClickUp', state.running),
            workflow(QUIET, 'Nightly digest', false),
          ],
        });
      if (path === `/workflow-runs/${RUN}`)
        return json({
          id: RUN,
          workflow_id: WF,
          status: state.running ? 'running' : 'succeeded',
          input: null,
          steps: [step('wait', state.running ? 'running' : 'succeeded')],
          error: null,
          started_at: '2026-09-29T08:00:00Z',
          finished_at: state.running ? null : '2026-09-29T08:00:05Z',
        });
      return json({ items: [], next_cursor: null });
    }) as unknown as typeof fetch;
  }

  it('turns the card green with its step while the run goes, and back to Idle when it ends', async () => {
    const state = { running: true };
    const store = new SessionStore(memoryStorage());
    store.save({
      profile: 'default',
      token: 't',
      refresh_token: null,
      expires_at: null,
      user: {
        id: '01J8QK3ZR2W7M5N4P6T8V9X0AA',
        username: 'noura',
        display_name: 'Noura',
        role: 'owner',
      },
    });
    render(
      <App
        store={store}
        baseUrl="http://hub.test"
        fetchImpl={hub(state)}
        router={(children) => (
          <MemoryRouter initialEntries={['/workflows']}>{children}</MemoryRouter>
        )}
      />,
    );

    const cardOf = (id: string) =>
      screen
        .getAllByTestId('workflow-card')
        .find((card) => card.getAttribute('data-workflow-id') === id)!;
    await waitFor(() => expect(screen.getAllByTestId('workflow-card')).toHaveLength(2));
    await waitFor(() =>
      expect(within(cardOf(WF)).getByTestId('workflow-card-status')).toHaveTextContent(
        'Running · Wait a moment',
      ),
    );
    expect(cardOf(WF)).toHaveAttribute('data-frame', 'running');
    expect(cardOf(QUIET)).not.toHaveAttribute('data-frame');
    expect(within(cardOf(QUIET)).getByTestId('workflow-card-status')).toHaveTextContent('Idle');
    const sidebar = screen.getAllByRole('navigation', { name: 'Main menu' })[0]!;
    expect(within(sidebar).getByTestId('sidebar-workflows-running')).toBeInTheDocument();
    // The dot is the eye's cue: the entry keeps its own name while a run goes.
    expect(within(sidebar).getByRole('link', { name: 'Workflows' })).toBeInTheDocument();

    // The run ends on the hub; the page hears it on /rt/schedules and asks again.
    state.running = false;
    const schedules = sockets.filter((socket) => socket.namespace.endsWith('schedules'));
    expect(schedules.length).toBeGreaterThan(0);
    act(() => {
      for (const socket of schedules) {
        socket.receive('workflow_run.completed', { workflow_run_id: RUN, workflow_id: WF });
      }
    });
    await waitFor(() =>
      expect(within(cardOf(WF)).getByTestId('workflow-card-status')).toHaveTextContent('Idle'),
    );
    expect(cardOf(WF)).not.toHaveAttribute('data-frame');
    await waitFor(() =>
      expect(within(sidebar).queryByTestId('sidebar-workflows-running')).toBeNull(),
    );
  });
});
