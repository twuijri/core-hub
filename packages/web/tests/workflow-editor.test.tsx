/**
 * The Workflows section of the Schedules page and its canvas (DECISIONS §48).
 *
 * Asserted: every profile's workflows are listed (`profiles=all`); a new workflow is drawn
 * from the palette, connected from the side panel, checked by the hub as it changes (its
 * findings marked on the step they name), saved as the contract's drawing in the right
 * profile; the keyboard deletes the selected step; and a run opens on the canvas with each
 * step's state, its output, the edges taken and the answers on a step that waits.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SchedulesScreen } from '../src/schedules/SchedulesScreen.js';

afterEach(cleanup);

const FLOW = '01J8QK3ZR2W7M5N4P6T8V9X0WF';
const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0WG';
const RUN = '01J8QK3ZR2W7M5N4P6T8V9X0WR';
const APPROVAL = '01J8QK3ZR2W7M5N4P6T8V9X0AP';
const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

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

const node = (id: string, kind: string, title: string, input: string, x: number) => ({
  id,
  kind,
  title,
  agent_id: kind === 'agent' ? AGENT : null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input,
  approval_required: false,
  position: { x, y: 40 },
});

const saved = {
  id: FLOW,
  profile: 'designer',
  name: 'Release',
  description: null,
  working_dir: null,
  nodes: [
    node('check', 'agent', 'Check', 'Check it', 40),
    node('gate', 'approval', 'Gate', 'Ship it?', 320),
    node('tell', 'notify', 'Tell', 'Shipped', 600),
    node('other', 'notify', 'Other', 'Never', 600),
  ],
  edges: [
    { id: 'e1', from: 'check', to: 'gate', route: 'success' },
    { id: 'e2', from: 'gate', to: 'tell', route: 'success' },
    { id: 'e3', from: 'check', to: 'other', route: 'failure' },
  ],
  status: 'waiting',
  active_run_id: RUN,
  run_count: 1,
  schedule_count: 0,
  updated_at: '2026-09-25T06:00:00Z',
};

interface Seen {
  method: string;
  path: string;
  query: string;
  profile: string | null;
  body: unknown;
}

function fakeHub() {
  const seen: Seen[] = [];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const profile = new Headers(init?.headers).get('X-Hub-Profile');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method, path, query: url.search, profile, body });
    if (path === '/profiles') {
      return json({
        items: [
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'designer', name: 'Designer' },
        ],
      });
    }
    if (path === '/agents') {
      return json({ items: [{ id: AGENT, slug: 'direct', name: 'Direct' }] });
    }
    if (path === '/workflows/validate') {
      const nodes = (body as { nodes: Array<{ id: string; kind: string; input: string }> }).nodes;
      const problems = nodes
        .filter((n) => n.kind === 'notify' && n.input === '')
        .map((n) => ({
          code: 'template_step_unknown',
          node_id: n.id,
          edge_id: null,
          detail: 'steps.ghost.output',
          message: 'm',
        }));
      return json({ valid: problems.length === 0, problems, warnings: [] });
    }
    if (path === '/workflows' && method === 'GET') {
      return json({
        items: [saved, { ...saved, id: OTHER, profile: 'default', name: 'Digest', status: 'idle' }],
        next_cursor: null,
      });
    }
    if (path === '/workflows' && method === 'POST') {
      return json({ ...saved, ...(body as object), id: OTHER, profile: profile ?? 'default' }, 201);
    }
    if (path === `/workflows/${FLOW}`) return json(saved);
    if (path === `/workflows/${FLOW}/runs`) {
      return json({
        items: [
          {
            id: RUN,
            workflow_id: FLOW,
            status: 'waiting',
            input: null,
            steps: [],
            error: null,
            started_at: '2026-09-25T06:00:00Z',
            finished_at: null,
          },
        ],
        next_cursor: null,
      });
    }
    if (path === `/workflow-runs/${RUN}`) {
      return json({
        id: RUN,
        workflow_id: FLOW,
        status: 'waiting',
        input: null,
        steps: [
          {
            node_id: 'check',
            attempt: 1,
            status: 'succeeded',
            approval_id: null,
            output: 'All checks passed.',
            route: 'success',
            error: null,
          },
          {
            node_id: 'gate',
            attempt: 1,
            status: 'waiting_approval',
            approval_id: APPROVAL,
            output: null,
            route: null,
            error: null,
          },
        ],
        error: null,
        started_at: '2026-09-25T06:00:00Z',
        finished_at: null,
      });
    }
    if (path === `/approvals/${APPROVAL}`) {
      return json({ id: APPROVAL, status: 'pending', title: 'Gate', description: 'Ship it?' });
    }
    if (path === `/approvals/${APPROVAL}/respond`)
      return json({ id: APPROVAL, status: 'approved' });
    return json({ items: [] });
  };
  return { seen, fetchImpl };
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function mount(fetchImpl: typeof fetch, at: string, language: 'en' | 'ar' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={[at]}>
                <Routes>
                  <Route
                    path="*"
                    element={
                      <>
                        <SchedulesScreen />
                        <Where />
                      </>
                    }
                  />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, testId: string, option: string) {
  await user.click(screen.getByTestId(testId));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('Schedules: the Workflows section', () => {
  it("lists every profile's workflows and opens one in its own profile", async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules');
    await user.click(screen.getByRole('tab', { name: 'Workflows' }));
    const cards = await screen.findAllByTestId('workflow-card');
    expect(cards.map((card) => within(card).getByText(/Release|Digest/).textContent)).toEqual([
      'Release',
      'Digest',
    ]);
    expect(seen.find((c) => c.path === '/workflows')!.query).toBe('?profiles=all');
    await user.click(within(cards[0]!).getByTestId('workflow-open'));
    expect(await screen.findByTestId('workflow-editor')).toHaveAttribute('data-workflow-id', FLOW);
    expect(screen.getByTestId('where')).toHaveTextContent(
      `/schedules?section=workflows&workflow=${FLOW}&profile=designer`,
    );
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4));
    expect(seen.find((c) => c.path === `/workflows/${FLOW}`)!.profile).toBe('designer');
  });

  it('draws a new workflow, marks what the hub finds, and saves the drawing', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules?section=workflows&workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    await user.type(screen.getByTestId('workflow-name'), 'Digest');
    await user.click(screen.getByTestId('workflow-add-agent'));
    await user.type(await screen.findByTestId('workflow-step-prompt'), 'Sum up the day');
    await user.click(screen.getByTestId('workflow-add-notify'));

    // The notice has no words yet: the hub's finding is marked on it, and Save waits.
    const tell = await screen.findByRole('button', { name: /Notify · Notify/ });
    await waitFor(() => expect(tell).toHaveAttribute('data-issues', '1'));
    expect(screen.getByTestId('workflow-save')).toBeDisabled();
    await user.type(screen.getByTestId('workflow-step-text'), 'Done');
    await waitFor(() => expect(screen.getByTestId('workflow-save')).toBeEnabled());

    // Connected from the side panel, without a pointer.
    await user.click(screen.getAllByTestId('workflow-node')[0]!);
    await pick(user, 'workflow-connect-target', 'Notify');
    await user.click(screen.getByTestId('workflow-connect'));
    expect(screen.getAllByTestId('workflow-edge')).toHaveLength(1);

    await user.click(screen.getByTestId('workflow-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/workflows' && c.method === 'POST')).toBe(true),
    );
    const post = seen.find((c) => c.path === '/workflows' && c.method === 'POST')!;
    expect(post.profile).toBe('default');
    expect(post.body).toMatchObject({
      name: 'Digest',
      nodes: [
        { id: 'agent_1', kind: 'agent', agent_id: AGENT, input: 'Sum up the day' },
        { id: 'notify_1', kind: 'notify', input: 'Done' },
      ],
      edges: [{ id: 'e1', from: 'agent_1', to: 'notify_1', route: 'success' }],
    });
    // The address follows the saved workflow.
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`workflow=${OTHER}`));
  });

  it('the keyboard deletes the selected step and its connections', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`);
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4));
    const gate = screen.getAllByTestId('workflow-node').find((n) => n.dataset.nodeId === 'gate')!;
    gate.focus();
    expect(await screen.findByTestId('workflow-panel')).toHaveAttribute('data-node-id', 'gate');
    fireEvent.keyDown(gate, { key: 'Delete' });
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(3));
    expect(screen.getAllByTestId('workflow-edge').map((e) => e.dataset.edgeId)).toEqual(['e3']);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('shows a run on the canvas: states, output, edges taken, and the answers on the waiting step', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer&run=${RUN}`);
    const view = await screen.findByTestId('workflow-run-view');
    await waitFor(() =>
      expect(
        within(view)
          .getAllByTestId('workflow-node')
          .map((n) => [n.dataset.nodeId, n.dataset.state]),
      ).toEqual([
        ['check', 'done'],
        ['gate', 'waiting'],
        ['tell', 'idle'],
        ['other', 'idle'],
      ]),
    );
    const taken = within(view)
      .getAllByTestId('workflow-edge')
      .map((e) => [e.dataset.edgeId, e.dataset.taken]);
    expect(taken).toEqual([
      ['e1', 'true'],
      ['e2', 'false'],
      ['e3', 'false'],
    ]);
    // The waiting step opens selected, with its question and the two answers.
    expect(await within(view).findByTestId('workflow-approval-question')).toHaveTextContent(
      'Ship it?',
    );
    // A finished step's output.
    await user.click(within(view).getAllByTestId('workflow-node')[0]!);
    expect(await within(view).findByTestId('workflow-step-output')).toHaveTextContent(
      'All checks passed.',
    );
    // The compact answers on the node itself.
    const onNode = within(view).getAllByTestId('workflow-approve')[0]!;
    await user.click(onNode);
    await waitFor(() =>
      expect(seen.some((c) => c.path === `/approvals/${APPROVAL}/respond`)).toBe(true),
    );
    expect(seen.find((c) => c.path === `/approvals/${APPROVAL}/respond`)!.profile).toBe('designer');
  });

  it('runs right-to-left in Arabic', async () => {
    const { fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`, 'ar');
    expect(await screen.findByTestId('workflow-canvas')).toHaveAttribute('data-direction', 'rtl');
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4));
    expect(screen.getByRole('tab', { name: 'تحرير' })).toBeInTheDocument();
  });
});
