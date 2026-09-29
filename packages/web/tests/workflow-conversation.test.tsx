/**
 * An agent step's conversation (DECISIONS §136) in the web editor: a new one every run stays
 * the default; "The same conversation every run" shows the picker first — the profile's
 * conversations by title with their last activity — and picking one fills the id and takes
 * its agent; "Paste a conversation id instead" is the secondary way, a pasted id is looked up
 * at once and shown by its title (or the hub's reason), a template is said to be filled at
 * run time; "Test conversation" asks the hub without sending; and the drawing round-trips the
 * field to the contract and back, keeping a mode this client does not know.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { ConversationForm, lookupId } from '../src/schedules/workflows/ConversationForm.js';
import { fromWorkflow, newNode, toWrite, type WfNode } from '../src/schedules/workflows/model.js';
import type { Agent } from '../src/types.js';
import { stubListViewport } from './helpers/ui.js';

afterEach(cleanup);
let unstub: () => void = () => undefined;
beforeAll(() => {
  unstub = stubListViewport();
});
afterAll(() => unstub());

const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const OTHER_AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AH';
const CHAT = '01J8QK3ZR2W7M5N4P6T8V9X0SA';
const THEIRS = '01J8QK3ZR2W7M5N4P6T8V9X0SB';
const GONE = '01J8QK3ZR2W7M5N4P6T8V9X0ZZ';

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

function fakeHub() {
  const checks: Array<{ profile: string | null; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const profile = new Headers(init?.headers).get('X-Hub-Profile');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (path === '/sessions') {
      return json({
        items: [
          {
            id: CHAT,
            title: 'ClickUp reports',
            agent_id: AGENT,
            last_message_at: '2026-09-29T08:00:00Z',
            source: 'workflow',
          },
          { id: THEIRS, title: 'Research', agent_id: OTHER_AGENT, source: 'chat' },
          { id: GONE.replace('ZZ', 'RM'), title: 'Seat', agent_id: AGENT, source: 'room' },
        ],
        next_cursor: null,
      });
    }
    if (path === '/workflows/conversation-check') {
      checks.push({ profile, body });
      const id = String(body.session_id);
      if (id === GONE) {
        return json({
          status: 'not_found',
          session_id: id,
          title: null,
          agent_id: null,
          active_run_id: null,
          reason: 'not found',
        });
      }
      const title = id === CHAT ? 'ClickUp reports' : 'Research';
      const owner = id === CHAT ? AGENT : OTHER_AGENT;
      const mismatch = body.agent_id && body.agent_id !== owner;
      return json({
        status: mismatch ? 'agent_mismatch' : 'ready',
        session_id: id,
        title,
        agent_id: owner,
        active_run_id: null,
        last_message_at: null,
        reason: null,
      });
    }
    return json({ error: 'not here', code: 'not_found' }, 404);
  };
  return { fetchImpl, checks };
}

const agents = [
  { id: AGENT, name: 'Direct' },
  { id: OTHER_AGENT, name: 'Scholar' },
] as unknown as Agent[];

/** The form over a live node, so each change is what the editor would keep. */
function Harness({ start, onChange }: { start: WfNode; onChange: (node: WfNode) => void }) {
  const [node, setNode] = useState(start);
  return (
    <ConversationForm
      node={node}
      profile="designer"
      agents={agents}
      update={(patch) =>
        setNode((current) => {
          const next = { ...current, ...patch };
          onChange(next);
          return next;
        })
      }
    />
  );
}

function mount(start: WfNode, language: 'en' | 'ar' = 'en') {
  const hub = fakeHub();
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'designer',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  let latest = start;
  render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={hub.fetchImpl}>
            <MemoryRouter>
              <Harness start={start} onChange={(node) => (latest = node)} />
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return { hub, node: () => latest };
}

const agentNode = (patch: Partial<WfNode> = {}): WfNode => ({
  ...newNode('agent', 'ask', 'Ask', { x: 0, y: 0 }, AGENT),
  ...patch,
});

describe('an agent step’s conversation (§136)', () => {
  it('is a new conversation per run by default; the same one shows the picker first', async () => {
    const user = userEvent.setup();
    const view = mount(agentNode());
    expect(screen.getByRole('radio', { name: /A new conversation for each run/ })).toBeChecked();
    expect(screen.queryByTestId('workflow-conversation-pick')).toBeNull();

    await user.click(screen.getByRole('radio', { name: /The same conversation every run/ }));
    expect(view.node().conversation).toEqual({ mode: 'reuse', create_if_missing: false });
    // The picker is the main control; the id field is behind a link.
    expect(screen.getByTestId('workflow-conversation-pick')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-conversation-id')).toBeNull();
    expect(screen.getByTestId('workflow-conversation-blocked')).toHaveTextContent(
      'Choose a conversation, or paste its id.',
    );

    await user.click(screen.getByTestId('workflow-conversation-pick'));
    const options = await screen.findAllByTestId('combobox-option');
    expect(screen.getByText('2 conversations')).toBeInTheDocument();
    // A room seat's conversation is not offered; each row says when it was last active.
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('ClickUp reports'),
      expect.stringContaining('Research'),
    ]);
    expect(options[0]).toHaveTextContent(/Last active/);
    await user.click(options[1]!);
    // Picking fills the id and takes the conversation's agent, so the two match.
    expect(view.node().conversation?.session_id).toBe(THEIRS);
    expect(view.node().agent_id).toBe(OTHER_AGENT);
    await waitFor(() =>
      expect(screen.getByTestId('workflow-conversation-result')).toHaveAttribute(
        'data-status',
        'ready',
      ),
    );
    expect(screen.getByTestId('workflow-conversation-result')).toHaveTextContent(
      '“Research” is ready. Its agent is Scholar',
    );
    expect(view.hub.checks.at(-1)).toEqual({
      profile: 'designer',
      body: { session_id: THEIRS, agent_id: OTHER_AGENT },
    });

    // Back to a new conversation per run keeps the choice, so turning it on again restores it.
    await user.click(screen.getByRole('radio', { name: /A new conversation for each run/ }));
    expect(view.node().conversation).toMatchObject({ mode: 'new', session_id: THEIRS });
  });

  it('a pasted id is shown by its title or the hub’s reason; a template waits for the run', async () => {
    const user = userEvent.setup();
    const view = mount(agentNode({ conversation: { mode: 'reuse', session_id: null } }));
    await user.click(screen.getByTestId('workflow-conversation-manual'));
    const field = screen.getByTestId('workflow-conversation-id');

    fireEvent.change(field, { target: { value: `\u200f${CHAT} ` } });
    await waitFor(() =>
      expect(screen.getByTestId('workflow-conversation-result')).toHaveTextContent(
        '“ClickUp reports” is ready.',
      ),
    );
    expect(view.hub.checks.at(-1)?.body).toEqual({ session_id: CHAT, agent_id: AGENT });

    fireEvent.change(field, { target: { value: GONE } });
    await waitFor(() =>
      expect(screen.getByTestId('workflow-conversation-result')).toHaveAttribute(
        'data-status',
        'not_found',
      ),
    );
    expect(screen.getByTestId('workflow-conversation-result')).toHaveTextContent(
      'No such conversation in this profile.',
    );

    fireEvent.change(field, { target: { value: THEIRS } });
    await waitFor(() =>
      expect(screen.getByTestId('workflow-conversation-result')).toHaveAttribute(
        'data-status',
        'agent_mismatch',
      ),
    );

    const before = view.hub.checks.length;
    fireEvent.change(field, { target: { value: '{{trigger.body.conversation}}' } });
    expect(screen.getByTestId('workflow-conversation-template')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-conversation-test')).toBeDisabled();
    fireEvent.change(field, { target: { value: 'abc' } });
    expect(screen.getByTestId('workflow-conversation-blocked')).toHaveTextContent(
      'This is not a conversation id.',
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(view.hub.checks.length).toBe(before);
    expect(view.node().conversation?.session_id).toBe('abc');
  });

  it('"Create if missing" is off by default and, on, takes a title', async () => {
    const user = userEvent.setup();
    const view = mount(agentNode({ conversation: { mode: 'reuse', session_id: CHAT } }), 'ar');
    const create = screen.getByTestId('workflow-conversation-create');
    expect(create).not.toBeChecked();
    expect(screen.getByText(/تفشل الخطوة وتذكر السبب/)).toBeInTheDocument();
    await user.click(create);
    expect(view.node().conversation?.create_if_missing).toBe(true);
    fireEvent.change(screen.getByTestId('workflow-conversation-title'), {
      target: { value: 'متابعة {{trigger.task_id}}' },
    });
    expect(view.node().conversation?.title).toBe('متابعة {{trigger.task_id}}');
    // "Test conversation" asks again on demand.
    const before = view.hub.checks.length;
    await user.click(screen.getByTestId('workflow-conversation-test'));
    await waitFor(() => expect(view.hub.checks.length).toBeGreaterThan(before));
  });

  it('round-trips the field to the contract, keeping a mode this client does not know', () => {
    const reuse = agentNode({
      conversation: { mode: 'reuse', session_id: CHAT, create_if_missing: true, title: 'T' },
    });
    const draft = { name: 'x', description: null, working_dir: null, nodes: [reuse], edges: [] };
    const write = toWrite(draft);
    expect(write.nodes[0]!.conversation).toEqual({
      mode: 'reuse',
      session_id: CHAT,
      create_if_missing: true,
      title: 'T',
    });
    expect(fromWorkflow(write).nodes[0]!.conversation).toEqual(write.nodes[0]!.conversation);
    // A new conversation per run is sent as `null`; a notice never carries one.
    expect(toWrite({ ...draft, nodes: [agentNode()] }).nodes[0]!.conversation).toBeNull();
    const future = fromWorkflow({
      name: 'x',
      nodes: [{ ...reuse, conversation: { mode: 'thread', session_id: CHAT, extra: 1 } }],
      edges: [],
    });
    expect(toWrite({ ...draft, nodes: future.nodes }).nodes[0]!.conversation).toMatchObject({
      mode: 'thread',
      extra: 1,
    });
    expect(lookupId(` ${CHAT}\u200e`)).toBe(CHAT);
    expect(lookupId('{{trigger.id}}')).toBeNull();
  });
});
