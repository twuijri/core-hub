/**
 * The Workflows page and its canvas (DECISIONS §52) — a tab of Schedules until 2026-09-28, its
 * own page since (DECISIONS §126); the old `/schedules?section=workflows…` addresses the tests
 * below still open prove the redirect keeps them working.
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
import { WorkflowsScreen } from '../src/screens/WorkflowsScreen.js';

afterEach(cleanup);

const FLOW = '01J8QK3ZR2W7M5N4P6T8V9X0WF';
const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0WG';
const RUN = '01J8QK3ZR2W7M5N4P6T8V9X0WR';
const APPROVAL = '01J8QK3ZR2W7M5N4P6T8V9X0AP';
const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const TRIGGER = '01J8QK3ZR2W7M5N4P6T8V9X0TG';

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
  limits: {
    max_duration_seconds: 1800,
    max_cost: { amount: '2.000000', currency: 'USD' },
    step_timeout_seconds: null,
  },
};

interface Seen {
  method: string;
  path: string;
  query: string;
  profile: string | null;
  body: unknown;
}

function fakeHub(
  options: {
    /** Answers the check instead of the default (a notify step without words is a problem). */
    validate?: (body: unknown) => { status: number; body: unknown } | null;
    /** How long the saved workflow takes to arrive. */
    workflowDelayMs?: number;
    /** Answers "Send test message" instead of the default partial send. */
    sendTest?: (body: unknown) => { status: number; body: unknown; raw?: boolean };
    /** The values "Use the last run's values" gets back. */
    lastRunValues?: unknown;
  } = {},
) {
  const seen: Seen[] = [];
  const triggers: Array<Record<string, unknown>> = [];
  const lines: Array<Record<string, unknown>> = [];
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
    if (path === '/workflows/validate' && options.validate) {
      const answer = options.validate(body);
      if (answer) return json(answer.body, answer.status);
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
    if (path === `/workflows/${FLOW}` && method === 'PATCH') return json({ ...saved, ...body });
    if (path === `/workflows/${FLOW}`) {
      const delay = options.workflowDelayMs ?? 0;
      return delay > 0
        ? new Promise<Response>((resolve) =>
            setTimeout(() => void json(saved).then(resolve), delay),
          )
        : json(saved);
    }
    if (path === '/workflows/test-step' && (body as { workflow_run_id?: string }).workflow_run_id) {
      // The last run's values: `check` finished, nobody typed an `input`.
      return json({
        rendered: 'x',
        answer: null,
        output: null,
        error: null,
        executed: false,
        values: options.lastRunValues ?? { 'steps.check.output': 'All checks passed.' },
      });
    }
    if (path === '/workflows/test-step') {
      const node = (body as { node: { kind: string } }).node;
      return json(
        node.kind === 'condition'
          ? {
              rendered: 'trigger.event == taskCreated',
              answer: true,
              output: 'true',
              error: null,
              executed: true,
            }
          : {
              rendered: 'Prompt about sample-task',
              answer: null,
              output: null,
              error: null,
              executed: false,
            },
      );
    }
    if (path === '/workflows/send-test' && options.sendTest) {
      const answer = options.sendTest(body);
      return answer.raw
        ? Promise.resolve(new Response(String(answer.body), { status: answer.status }))
        : json(answer.body, answer.status);
    }
    if (path === '/workflows/send-test') {
      return json({
        status: 'partial',
        message_id: '801',
        message_ids: ['801'],
        delivered_to: ['core_hub:01J8QK3ZR2W7M5N4P6T8V9X0SS'],
        failures: [{ target: 'telegram:-100404', reason: 'Bad Request: chat not found' }],
      });
    }
    if (path === '/sessions' && url.search.includes('limit=200')) {
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0SS', title: 'Reports', agent_id: AGENT }],
        next_cursor: null,
      });
    }
    if (path === `/workflows/${FLOW}/triggers` && method === 'GET') {
      return json({ items: triggers });
    }
    if (path === `/workflows/${FLOW}/triggers` && method === 'POST') {
      const made = {
        id: TRIGGER,
        workflow_id: FLOW,
        name: 'ClickUp',
        enabled: true,
        events: [],
        secret_stored: false,
        signature_header: null,
        signature_encoding: null,
        signature_prefix: null,
        path: `/api/v1/workflow-hooks/${TRIGGER}`,
        last_delivery_at: null,
        ...(body as object),
      };
      triggers.push(made);
      return json(made, 201);
    }
    if (path === `/workflow-triggers/${TRIGGER}` && method === 'PATCH') {
      const patch = { ...(body as Record<string, unknown>) };
      if ('secret' in patch) {
        patch.secret_stored = !!patch.secret;
        delete patch.secret;
      }
      Object.assign(triggers[0]!, patch);
      return json(triggers[0]);
    }
    if (path === `/workflow-triggers/${TRIGGER}/test`) {
      const line = {
        id: '01J8QK3ZR2W7M5N4P6T8V9X0DK',
        trigger_id: TRIGGER,
        workflow_id: FLOW,
        received_at: '2026-09-28T09:00:00Z',
        status: 'run_started',
        event: (body as { event?: string | null }).event ?? 'taskCreated',
        event_id: '1',
        task_id: 'core-hub-test-task',
        workflow_run_id: RUN,
        filtered: false,
        test: true,
        error: null,
        body_preview: '{}',
      };
      lines.unshift(line);
      return json(line);
    }
    if (path === `/workflow-triggers/${TRIGGER}/deliveries`) {
      return json({ items: lines, next_cursor: null });
    }
    if (path === `/workflows/${FLOW}/run`)
      return json({ job_id: '01J8QK3ZR2W7M5N4P6T8V9X0JY', workflow_run_id: RUN }, 202);
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
                    path="/schedules"
                    element={
                      <>
                        <SchedulesScreen />
                        <Where />
                      </>
                    }
                  />
                  <Route
                    path="/workflows"
                    element={
                      <>
                        <WorkflowsScreen />
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

describe('Workflows: its own page', () => {
  it("lists every profile's workflows and opens one in its own profile", async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/workflows');
    // Its own page now: Schedules has no Workflows tab any more.
    expect(screen.queryByRole('tab', { name: 'Workflows' })).toBeNull();
    const cards = await screen.findAllByTestId('workflow-card');
    expect(cards.map((card) => within(card).getByText(/Release|Digest/).textContent)).toEqual([
      'Release',
      'Digest',
    ]);
    expect(seen.find((c) => c.path === '/workflows')!.query).toBe('?profiles=all');
    await user.click(within(cards[0]!).getByTestId('workflow-open'));
    expect(await screen.findByTestId('workflow-editor')).toHaveAttribute('data-workflow-id', FLOW);
    expect(screen.getByTestId('where')).toHaveTextContent(
      `/workflows?workflow=${FLOW}&profile=designer`,
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

  it('checks a new drawing before it has a name, with the name hint by the name field', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules?section=workflows&workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    expect(screen.getByText('Give the workflow a name before saving.')).toBeInTheDocument();
    await user.click(screen.getByTestId('workflow-add-agent'));
    await waitFor(() =>
      expect(
        seen.some(
          (c) =>
            c.path === '/workflows/validate' && (c.body as { nodes: unknown[] }).nodes.length === 1,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true'),
    );
    expect(screen.queryByTestId('workflow-check-error')).toBeNull();
    expect(screen.getByTestId('workflow-save')).toBeDisabled();
    await user.type(screen.getByTestId('workflow-name'), 'Digest');
    expect(screen.queryByText('Give the workflow a name before saving.')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('workflow-save')).toBeEnabled());
  });

  it('does not check the empty drawing while a saved workflow is loading', async () => {
    const { seen, fetchImpl } = fakeHub({ workflowDelayMs: 700 });
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`);
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4), {
      timeout: 3000,
    });
    await waitFor(() => expect(seen.some((c) => c.path === '/workflows/validate')).toBe(true));
    const checks = seen.filter((c) => c.path === '/workflows/validate');
    expect(checks.map((c) => (c.body as { nodes: unknown[] }).nodes.length)).toEqual([4]);
    expect(screen.queryByTestId('workflow-check-error')).toBeNull();
  });

  it('puts each field a refused check names next to that field', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub({
      validate: (body) =>
        (body as { nodes: unknown[] }).nodes.length > 0
          ? {
              status: 400,
              body: {
                error: 'The request did not match the expected shape.',
                code: 'validation_failed',
                details: {
                  fields: [
                    { source: 'body', path: 'name', message: 'is too long' },
                    { source: 'body', path: 'nodes.0.title', message: 'is too long' },
                  ],
                },
              },
            }
          : null,
    });
    mount(fetchImpl, '/schedules?section=workflows&workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    await user.click(screen.getByTestId('workflow-add-agent'));
    expect(await screen.findByText('The name is not accepted: is too long')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-check-error')).toHaveTextContent(
      'The drawing could not be checked: fix the marked fields.',
    );
    const step = screen.getAllByTestId('workflow-node')[0]!;
    expect(step).toHaveAttribute('data-issues', '1');
    const issue = screen
      .getAllByTestId('workflow-issue')
      .find((item) => item.dataset.code === 'field_invalid')!;
    expect(issue).toHaveTextContent('The hub did not accept “title” as written.');
    expect(screen.getByTestId('workflow-save')).toBeDisabled();
  });

  it('adds a ClickUp trigger: its address to copy, a secret never shown, a test event and its line (§123)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`);
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4));
    const panel = await screen.findByTestId('workflow-triggers');
    await user.click(within(panel).getByTestId('workflow-trigger-add'));
    const card = await within(panel).findByTestId('workflow-trigger');
    expect(
      seen.find((c) => c.path === `/workflows/${FLOW}/triggers` && c.method === 'POST'),
    ).toMatchObject({
      profile: 'designer',
      body: { preset: 'clickup', events: ['taskCreated', 'taskStatusUpdated'] },
    });
    expect(within(card).getByTestId('workflow-trigger-url')).toHaveValue(
      `${window.location.origin}/api/v1/workflow-hooks/${TRIGGER}`,
    );
    expect(within(card).getByTestId('workflow-trigger-test')).toBeDisabled();

    await user.type(within(card).getByTestId('workflow-trigger-secret'), 'from-clickup');
    await user.click(within(card).getByTestId('workflow-trigger-secret-save'));
    await waitFor(() =>
      expect(within(card).getByTestId('workflow-trigger-secret')).toHaveAttribute(
        'placeholder',
        '[stored]',
      ),
    );
    expect(within(card).getByTestId('workflow-trigger-secret')).toHaveValue('');
    expect(
      seen.find((c) => c.path === `/workflow-triggers/${TRIGGER}` && c.method === 'PATCH')!.body,
    ).toEqual({ secret: 'from-clickup' });

    await user.click(within(card).getByTestId('workflow-trigger-event-taskAssigneeUpdated'));
    await waitFor(() =>
      expect(
        seen
          .filter((c) => c.path === `/workflow-triggers/${TRIGGER}` && c.method === 'PATCH')
          .at(-1)!.body,
      ).toEqual({ events: ['taskCreated', 'taskStatusUpdated', 'taskAssigneeUpdated'] }),
    );

    await user.click(within(card).getByTestId('workflow-trigger-test'));
    expect(await within(card).findByTestId('workflow-trigger-test-result')).toHaveTextContent(
      'Run started',
    );
    const line = await within(card).findByTestId('workflow-trigger-delivery');
    expect(line).toHaveAttribute('data-status', 'run_started');
    expect(line).toHaveTextContent('task core-hub-test-task');
    await user.click(within(line).getByTestId('workflow-delivery-run'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`run=${RUN}`));
  });

  it('a Send message step: Telegram and a conversation, a test send, saved as a notice with targets (§124)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules?section=workflows&workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    await user.type(screen.getByTestId('workflow-name'), 'Report');
    await user.click(screen.getByTestId('workflow-add-send'));
    await user.type(await screen.findByTestId('workflow-step-text'), 'Done');
    await user.click(screen.getByTestId('workflow-send-telegram'));
    await user.type(screen.getByTestId('workflow-send-chat'), '-100404');
    await user.click(screen.getByTestId('workflow-send-conversation'));
    await pick(user, 'workflow-send-session', 'Reports');
    await user.click(screen.getByTestId('workflow-send-test'));
    const result = await screen.findByTestId('workflow-send-test-result');
    expect(result).toHaveTextContent('Sent to some targets only');
    expect(result).toHaveTextContent('Bad Request: chat not found');
    expect(seen.find((c) => c.path === '/workflows/send-test')!.body).toEqual({
      text: 'Done',
      // Named in the hub's log only; a new workflow has no id yet (2026-09-29).
      node_id: 'notify_1',
      send: {
        targets: [
          { platform: 'telegram', chat_id: '-100404', formatting: 'plain' },
          {
            platform: 'core_hub',
            session_id: '01J8QK3ZR2W7M5N4P6T8V9X0SS',
            title: 'Reports',
            agent_id: AGENT,
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId('workflow-save')).toBeEnabled());
    await user.click(screen.getByTestId('workflow-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/workflows' && c.method === 'POST')).toBe(true),
    );
    const node = (
      seen.find((c) => c.path === '/workflows' && c.method === 'POST')!.body as {
        nodes: Array<Record<string, unknown>>;
      }
    ).nodes[0]!;
    expect(node).toMatchObject({ kind: 'notify', input: 'Done' });
    expect((node.send as { targets: unknown[] }).targets).toHaveLength(2);
  });

  it('Telegram formatting: chosen per step, named and drawn in the preview, used by the test and saved (§137)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/workflows?workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    await user.type(screen.getByTestId('workflow-name'), 'Formatted');
    await user.click(screen.getByTestId('workflow-add-send'));
    const words = await screen.findByTestId('workflow-step-text');
    fireEvent.change(words, {
      target: { value: '<b>اختبار</b> و <a href="https://x.test">رابط</a>' },
    });
    // No Telegram target yet: nothing to say about Telegram's formatting.
    expect(screen.queryByTestId('workflow-send-formatting-label')).toBeNull();
    await user.click(screen.getByTestId('workflow-send-telegram'));
    fireEvent.change(screen.getByTestId('workflow-send-chat'), { target: { value: '-1001' } });

    // Plain by default: said, and the tags shown as written.
    const label = () => screen.getByTestId('workflow-send-formatting-label');
    const preview = () => screen.getByTestId('workflow-send-preview');
    expect(label()).toHaveTextContent('Telegram formatting: Plain text');
    expect(preview()).toHaveAttribute('data-formatting', 'plain');
    expect(preview()).toHaveTextContent('<b>اختبار</b>');
    expect(preview().querySelector('strong')).toBeNull();

    // HTML: bold drawn from Telegram's entities; the link shown, never followed.
    await user.click(screen.getByTestId('workflow-send-formatting-html'));
    expect(label()).toHaveTextContent('Telegram formatting: HTML');
    expect(preview()).toHaveAttribute('data-rendered', 'formatted');
    expect(preview().querySelector('strong')).toHaveTextContent('اختبار');
    expect(preview().querySelector('a')).toBeNull();
    expect(preview().querySelector('[data-entity="link"]')).toHaveAttribute(
      'data-href',
      'https://x.test',
    );
    expect(preview()).not.toHaveTextContent('<b>');

    // Markup Telegram would refuse is said before sending; nothing of it enters the page as HTML.
    fireEvent.change(words, { target: { value: '<b>open <script>x</script>' } });
    expect(screen.getByTestId('workflow-send-preview-invalid')).toHaveTextContent(
      'Telegram would refuse this HTML',
    );
    expect(preview().querySelector('script')).toBeNull();
    expect(preview()).toHaveTextContent('<b>open <script>x</script>');

    // MarkdownV2.
    await user.click(screen.getByTestId('workflow-send-formatting-markdown_v2'));
    fireEvent.change(words, { target: { value: '*عريض* _مائل_ انتهى\\.' } });
    expect(label()).toHaveTextContent('Telegram formatting: MarkdownV2');
    expect(preview().querySelector('strong')).toHaveTextContent('عريض');
    expect(preview().querySelector('em')).toHaveTextContent('مائل');
    expect(preview()).toHaveTextContent('عريض مائل انتهى.');
    expect(screen.queryByTestId('workflow-send-preview-invalid')).toBeNull();

    // The test is sent with the chosen formatting.
    await user.click(screen.getByTestId('workflow-send-formatting-html'));
    fireEvent.change(words, { target: { value: '<b>اختبار</b>' } });
    // The chat id stays when the formatting changes, and the formatting when the chat id does.
    fireEvent.change(screen.getByTestId('workflow-send-chat'), { target: { value: '-1002' } });
    await user.click(screen.getByTestId('workflow-send-test'));
    await screen.findByTestId('workflow-send-test-result');
    expect(seen.filter((c) => c.path === '/workflows/send-test').at(-1)!.body).toMatchObject({
      text: '<b>اختبار</b>',
      send: { targets: [{ platform: 'telegram', chat_id: '-1002', formatting: 'html' }] },
    });

    await waitFor(() => expect(screen.getByTestId('workflow-save')).toBeEnabled());
    await user.click(screen.getByTestId('workflow-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/workflows' && c.method === 'POST')).toBe(true),
    );
    const node = (
      seen.find((c) => c.path === '/workflows' && c.method === 'POST')!.body as {
        nodes: Array<{ send: { targets: unknown[] } }>;
      }
    ).nodes[0]!;
    expect(node.send.targets).toEqual([
      { platform: 'telegram', chat_id: '-1002', formatting: 'html' },
    ]);
  });

  it('a Send message test with variables: values from the last run or typed, a preview, and no send until each has one (§124)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`);
    await screen.findByTestId('workflow-canvas');
    await user.click(await screen.findByTestId('workflow-add-send'));
    const words = await screen.findByTestId('workflow-step-text');
    fireEvent.change(words, {
      target: { value: 'Result: {{steps.check.output}} for {{input}} ({{ steps.check.output }})' },
    });
    await user.click(screen.getByTestId('workflow-send-telegram'));
    await user.type(screen.getByTestId('workflow-send-chat'), '-1001');

    // Each variable once, the preview with the holes still showing, and Send off.
    const sample = screen.getByTestId('workflow-send-sample');
    expect(within(sample).getByTestId('workflow-send-value-steps.check.output')).toBeTruthy();
    expect(within(sample).getByTestId('workflow-send-value-input')).toBeTruthy();
    expect(screen.getByTestId('workflow-send-preview')).toHaveTextContent(
      'Result: {{steps.check.output}} for {{input}}',
    );
    expect(screen.getByTestId('workflow-send-missing')).toHaveTextContent('{{input}}');
    expect(screen.getByTestId('workflow-send-test')).toBeDisabled();

    // The last run fills what it had; `input` it did not have stays for the person.
    await user.click(screen.getByTestId('workflow-send-last-run'));
    await screen.findByTestId('workflow-send-last-run-filled');
    const asked = seen.find(
      (c) =>
        c.path === '/workflows/test-step' &&
        (c.body as { workflow_run_id?: string }).workflow_run_id,
    )!;
    expect(asked.body).toMatchObject({ workflow_run_id: RUN, node: { kind: 'notify' } });
    expect(asked.profile).toBe('designer');
    expect(screen.getByTestId('workflow-send-value-steps.check.output')).toHaveValue(
      'All checks passed.',
    );
    expect(screen.getByTestId('workflow-send-missing')).toHaveTextContent('{{input}}');
    expect(screen.getByTestId('workflow-send-missing')).not.toHaveTextContent('steps.check');
    expect(screen.getByTestId('workflow-send-test')).toBeDisabled();

    await user.type(screen.getByTestId('workflow-send-value-input'), 'release 2');
    expect(screen.getByTestId('workflow-send-preview')).toHaveTextContent(
      'Result: All checks passed. for release 2 (All checks passed.)',
    );
    expect(screen.queryByTestId('workflow-send-missing')).toBeNull();
    await user.click(screen.getByTestId('workflow-send-test'));
    await screen.findByTestId('workflow-send-test-result');
    // The words go as written, with the values: the hub renders them with the run's own code.
    expect(seen.find((c) => c.path === '/workflows/send-test')!.body).toEqual({
      text: 'Result: {{steps.check.output}} for {{input}} ({{ steps.check.output }})',
      values: { 'steps.check.output': 'All checks passed.', input: 'release 2' },
      send: { targets: [{ platform: 'telegram', chat_id: '-1001', formatting: 'plain' }] },
      workflow_id: FLOW,
      node_id: 'notify_1',
    });
  });

  it('"Send test message" always ends in words: why it is off, the ids and where it went, or the real error (2026-09-29)', async () => {
    const user = userEvent.setup();
    let answer: { status: number; body: unknown; raw?: boolean } = {
      status: 200,
      body: {
        status: 'sent',
        message_id: '812',
        message_ids: ['812'],
        delivered_to: ['telegram:-1003938641118'],
        failures: [],
      },
    };
    const { seen, fetchImpl } = fakeHub({ sendTest: () => answer });
    mount(fetchImpl, `/workflows?workflow=${FLOW}&profile=designer`);
    await screen.findByTestId('workflow-canvas');
    await user.click(await screen.findByTestId('workflow-add-send'));
    // Found again each time: the button is wrapped while it is off (its reason's tooltip).
    const button = () => screen.getByTestId('workflow-send-test');

    // Off, and it says why: no target, then a Telegram target without its chat id, then no words.
    expect(button()).toBeDisabled();
    expect(screen.getByTestId('workflow-send-blocked')).toHaveTextContent(
      'Choose where to send it first',
    );
    await user.click(screen.getByTestId('workflow-send-telegram'));
    expect(screen.getByTestId('workflow-send-blocked')).toHaveTextContent(
      'Type the Telegram chat id first.',
    );
    // Copied out of right-to-left text: an invisible mark in front of the id.
    fireEvent.change(screen.getByTestId('workflow-send-chat'), {
      target: { value: '\u200e-1003938641118 ' },
    });
    expect(screen.getByTestId('workflow-send-blocked')).toHaveTextContent(
      'Write the message first.',
    );
    fireEvent.change(screen.getByTestId('workflow-step-text'), {
      target: { value: 'CORE_HUB_TELEGRAM_TEST_OK' },
    });
    expect(screen.queryByTestId('workflow-send-blocked')).toBeNull();
    expect(button()).toBeEnabled();

    // Sent: the state, where, and Telegram's message id.
    await user.click(button());
    const result = await screen.findByTestId('workflow-send-test-result');
    expect(result).toHaveAttribute('data-status', 'sent');
    expect(result).toHaveTextContent('Sent');
    expect(result).toHaveTextContent('telegram:-1003938641118');
    expect(result).toHaveTextContent('Message id: 812');
    expect(seen.find((c) => c.path === '/workflows/send-test')!.body).toEqual({
      text: 'CORE_HUB_TELEGRAM_TEST_OK',
      send: { targets: [{ platform: 'telegram', chat_id: '-1003938641118', formatting: 'plain' }] },
      workflow_id: FLOW,
      node_id: 'notify_1',
    });

    // Telegram refused: its own words.
    answer = {
      status: 200,
      body: {
        status: 'failed',
        message_id: null,
        message_ids: [],
        delivered_to: [],
        failures: [
          {
            target: 'telegram:-1003938641118',
            reason: 'Forbidden: bot is not a member of the supergroup chat',
          },
        ],
      },
    };
    await user.click(button());
    await waitFor(() =>
      expect(screen.getByTestId('workflow-send-test-result')).toHaveAttribute(
        'data-status',
        'failed',
      ),
    );
    expect(screen.getByTestId('workflow-send-test-result')).toHaveTextContent('Not sent');
    expect(screen.getByTestId('workflow-send-test-result')).toHaveTextContent(
      'Forbidden: bot is not a member of the supergroup chat',
    );

    // The hub refused: its message, never silence.
    answer = {
      status: 500,
      body: { error: 'Internal error', code: 'internal', details: { request_id: 'req-7' } },
    };
    await user.click(button());
    expect(await screen.findByTestId('workflow-send-test-error')).toHaveTextContent(
      'Internal error (req-7)',
    );
    expect(screen.queryByTestId('workflow-send-test-result')).toBeNull();

    // A page that is not the hub's answer (a proxy's): said, not drawn as nothing.
    answer = { status: 200, body: '<html>proxy</html>', raw: true };
    await user.click(button());
    await waitFor(() =>
      expect(screen.getByTestId('workflow-send-test-error')).toHaveTextContent('could not be read'),
    );
  });

  it('"Use the last run\'s values" with an answer it did not expect never blanks the page, and the values stay when the step is opened again', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub({
      lastRunValues: { 'steps.check.output': { text: 'All checks passed.' }, input: null },
    });
    mount(fetchImpl, `/workflows?workflow=${FLOW}&profile=designer`);
    await screen.findByTestId('workflow-canvas');
    await user.click(await screen.findByTestId('workflow-add-send'));
    fireEvent.change(await screen.findByTestId('workflow-step-text'), {
      target: { value: 'Result: {{steps.check.output}} {{input}}' },
    });
    await user.click(screen.getByTestId('workflow-send-last-run'));
    await screen.findByTestId('workflow-send-last-run-filled');
    expect(screen.getByTestId('workflow-send-value-steps.check.output')).toHaveValue(
      '{"text":"All checks passed."}',
    );
    // What the run had nothing for is named.
    expect(screen.getByTestId('workflow-send-last-run-empty')).toHaveTextContent('{{input}}');
    expect(screen.getByTestId('workflow-editor')).toBeTruthy();

    // Another step, then this one again: the values are still there (never saved into the step).
    fireEvent.focus(
      within(screen.getByTestId('workflow-canvas'))
        .getAllByTestId('workflow-node')
        .find((each) => each.getAttribute('data-node-id') === 'check')!,
    );
    await waitFor(() =>
      expect(screen.getByTestId('workflow-panel')).toHaveAttribute('data-node-id', 'check'),
    );
    fireEvent.focus(
      within(screen.getByTestId('workflow-canvas'))
        .getAllByTestId('workflow-node')
        .find((each) => each.getAttribute('data-node-id') === 'notify_1')!,
    );
    await waitFor(() =>
      expect(screen.getByTestId('workflow-panel')).toHaveAttribute('data-node-id', 'notify_1'),
    );
    expect(screen.getByTestId('workflow-send-sample')).toBeTruthy();
    expect(screen.getByTestId('workflow-send-value-steps.check.output')).toHaveValue(
      '{"text":"All checks passed."}',
    );
  });

  it('a failure alert is saved with the workflow, and a step is tried with a sample (§127)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules?section=workflows&workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    await user.type(screen.getByTestId('workflow-name'), 'Alerted');
    await user.click(screen.getByTestId('workflow-add-condition'));
    await user.click(await screen.findByTestId('workflow-step-test'));
    await user.click(screen.getByTestId('workflow-step-test-run'));
    const tested = await screen.findByTestId('workflow-step-test-result');
    expect(tested).toHaveTextContent('Yes — the green connections would follow');
    const sent = seen.find((c) => c.path === '/workflows/test-step')!.body as {
      node: { kind: string };
      trigger: { event: string };
      execute: boolean;
    };
    expect(sent).toMatchObject({ node: { kind: 'condition' }, execute: false });
    expect(sent.trigger.event).toBe('taskStatusUpdated');

    // Nothing selected: the workflow's own settings, with who is told when a run fails.
    fireEvent.keyDown(screen.getAllByTestId('workflow-node')[0]!, { key: 'Escape' });
    const alert = await screen.findByTestId('workflow-alert');
    await user.click(within(alert).getByTestId('workflow-alert-inbox'));
    await user.click(within(alert).getByTestId('workflow-alert-telegram'));
    await user.type(within(alert).getByTestId('workflow-alert-chat'), '-100777');
    await waitFor(() => expect(screen.getByTestId('workflow-save')).toBeEnabled());
    await user.click(screen.getByTestId('workflow-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/workflows' && c.method === 'POST')).toBe(true),
    );
    expect(
      (
        seen.find((c) => c.path === '/workflows' && c.method === 'POST')!.body as Record<
          string,
          unknown
        >
      ).on_failure,
    ).toEqual({ inbox: true, send: { targets: [{ platform: 'telegram', chat_id: '-100777' }] } });
  });

  it('a condition holds several rules, saved as the contract’s rules (§123)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules?section=workflows&workflow=new&profile=default');
    await screen.findByTestId('workflow-editor');
    await user.type(screen.getByTestId('workflow-name'), 'Filter');
    await user.click(screen.getByTestId('workflow-add-condition'));
    await user.click(await screen.findByTestId('workflow-condition-rules'));
    const rules = await screen.findByTestId('workflow-rules');
    expect(within(rules).getAllByTestId('workflow-rule')).toHaveLength(1);
    await user.clear(within(rules).getByTestId('workflow-rule-path'));
    await user.type(within(rules).getByTestId('workflow-rule-path'), 'trigger.event');
    await user.click(within(rules).getByTestId('workflow-rule-add'));
    const second = within(rules).getAllByTestId('workflow-rule')[1]!;
    await user.type(within(second).getByTestId('workflow-rule-value'), 'taskCreated');
    await pick(user, 'workflow-rules-match', 'any one rule holds');
    await waitFor(() => expect(screen.getByTestId('workflow-save')).toBeEnabled());
    await user.click(screen.getByTestId('workflow-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/workflows' && c.method === 'POST')).toBe(true),
    );
    const post = seen.find((c) => c.path === '/workflows' && c.method === 'POST')!;
    expect((post.body as { nodes: Array<Record<string, unknown>> }).nodes[0]!.rules).toEqual({
      match: 'any',
      items: [
        { path: 'trigger.event', operator: 'exists', value: null },
        { path: 'trigger.event', operator: '==', value: 'taskCreated' },
      ],
    });
  });

  it('keeps the workflow’s limits in the side panel while no step is selected (§102)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`);
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4));
    const settings = await screen.findByTestId('workflow-settings');
    const time = await within(settings).findByTestId('workflow-limit-time');
    await waitFor(() => expect(time).toHaveValue('30'));
    expect(within(settings).getByTestId('workflow-limit-cost')).toHaveValue('2');
    await user.clear(time);
    await user.type(time, '45');
    await user.click(within(settings).getByTestId('workflow-limits-save'));
    await waitFor(() =>
      expect(
        seen.find((c) => c.method === 'PATCH' && c.path === `/workflows/${FLOW}`),
      ).toMatchObject({
        profile: 'designer',
        body: {
          limits: {
            max_duration_seconds: 2700,
            max_cost: { amount: '2', currency: 'USD' },
            step_timeout_seconds: null,
          },
        },
      }),
    );
    // A selected step takes the panel; the limits return with nothing selected.
    const gate = screen.getAllByTestId('workflow-node').find((n) => n.dataset.nodeId === 'gate')!;
    gate.focus();
    await screen.findByTestId('workflow-panel');
    expect(screen.queryByTestId('workflow-settings')).toBeNull();
  });

  it('runs once with its own limits, starting from the workflow’s (§102)', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer`);
    await waitFor(() => expect(screen.getAllByTestId('workflow-node')).toHaveLength(4));
    await user.click(screen.getByTestId('workflow-run-with-limits'));
    const dialog = await screen.findByTestId('workflow-run-limits-dialog');
    expect(within(dialog).getByTestId('workflow-run-limit-time')).toHaveValue('30');
    const cost = within(dialog).getByTestId('workflow-run-limit-cost');
    await user.clear(cost);
    await user.type(cost, '0.5');
    await user.type(within(dialog).getByTestId('workflow-run-limit-step'), '5');
    await user.click(within(dialog).getByTestId('workflow-run-limited'));
    await waitFor(() =>
      expect(seen.find((c) => c.path === `/workflows/${FLOW}/run`)).toMatchObject({
        method: 'POST',
        profile: 'designer',
        body: {
          start_node_ids: null,
          limits: {
            max_duration_seconds: 1800,
            max_cost: { amount: '0.5', currency: 'USD' },
            step_timeout_seconds: 300,
          },
        },
      }),
    );
    // The workflow itself is left as it was.
    expect(seen.some((c) => c.method === 'PATCH')).toBe(false);
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

describe('the old Schedules address of Workflows (DECISIONS §126)', () => {
  it('lands on the Workflows page with the rest of the address kept', async () => {
    const { fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?section=workflows&workflow=${FLOW}&profile=designer&run=${RUN}`);
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        `/workflows?workflow=${FLOW}&profile=designer&run=${RUN}`,
      ),
    );
    expect(await screen.findByTestId('workflow-editor')).toHaveAttribute('data-workflow-id', FLOW);
  });

  it('keeps Schedules itself, without a Workflows tab', async () => {
    const { fetchImpl } = fakeHub();
    mount(fetchImpl, '/schedules');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/schedules$/);
    expect(screen.queryByRole('tab', { name: 'Workflows' })).toBeNull();
    expect(screen.queryByTestId('workflows-section')).toBeNull();
  });
});
