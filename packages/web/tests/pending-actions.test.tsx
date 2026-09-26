/**
 * The pending-actions bar (NAVIGATION §4, contract COVERAGE "Pending-actions bar") and the
 * global agent's page (contract decision §46).
 *
 * - What waits is gathered from every profile the person may enter, oldest first, each asked
 *   in its own profile; the top bar says how many, and the sheet lists them with a way to
 *   where each one is handled — and a way into the global agent.
 * - Senders waiting to pair are an admin's; a member's bar never asks for them.
 * - The global agent's page asks the hub for the person's own conversation, with the first
 *   agent they could chat with, and says so plainly when there is none.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../src/types.js';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  connect() {
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, connectNamespace: () => new FakeSocket() };
});

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { PaneProvider } = await import('../src/shell/pane.js');
const { TopBar } = await import('../src/shell/TopBar.js');
const { GlobalAgentScreen } = await import('../src/screens/GlobalAgentScreen.js');
const { mergePending, pendingHref } = await import('../src/pending/pending.js');

afterEach(cleanup);

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const GLOBAL = '01J8QK3ZR2W7M5N4P6T8V9X0YG';
const RUN = '01J8QK3ZR2W7M5N4P6T8V9X0WR';
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

function approval(over: Partial<Approval> & { id: string; created_at: string }): Approval {
  return {
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    updated_at: over.created_at,
    kind: 'tool_call',
    status: 'pending',
    session_id: SESSION,
    run_id: null,
    message_id: null,
    room_id: null,
    workflow_run_id: null,
    node_id: null,
    agent: { id: AGENT_ID, name: 'Hermes' },
    title: 'تنفيذ أمر',
    description: null,
    command: 'pnpm test',
    choices: [],
    allow_always: false,
    answer_mode: 'choice',
    response: null,
    expires_at: null,
    ...over,
  } as Approval;
}

const AGENT = {
  id: AGENT_ID,
  profile: 'default',
  owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'hermes',
  name: 'Hermes',
  vendor: null,
  kind: 'hermes',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['streaming', 'channels'],
  sections: [],
  default_model: null,
};

describe('what the bar lists, and where each thing leads', () => {
  const inLink = (profile: string) => profile;

  it('keeps the pending ones, oldest first, once each', () => {
    const newer = approval({ id: 'a2', created_at: '2026-09-25T10:05:00Z' });
    const older = approval({ id: 'a1', created_at: '2026-09-25T10:00:00Z', profile: 'work' });
    const done = approval({ id: 'a3', created_at: '2026-09-25T09:00:00Z', status: 'approved' });
    const items = mergePending(
      [
        { profile: 'default', items: [newer, done, newer] },
        { profile: 'work', items: [older] },
      ],
      [
        {
          profile: 'default',
          agentId: AGENT_ID,
          items: [
            {
              platform: 'whatsapp',
              request_id: 'r1',
              user_id: '966500000001',
              user_name: 'سارة',
              requested_at: '2026-09-25T10:02:00Z',
            },
          ],
        },
      ],
    );
    expect(items.map((i) => i.key)).toEqual([
      'approval:a1',
      'pairing:default:whatsapp:r1',
      'approval:a2',
    ]);
    expect(items[0]?.profile).toBe('work');
  });

  it('opens a conversation, the global agent, a workflow run or the channels page', () => {
    const [chat, inGlobal, gate] = mergePending(
      [
        {
          profile: 'work',
          items: [
            approval({ id: 'a1', created_at: '2026-09-25T10:00:00Z' }),
            approval({ id: 'a2', created_at: '2026-09-25T10:01:00Z', session_id: GLOBAL }),
            approval({
              id: 'a3',
              created_at: '2026-09-25T10:02:00Z',
              session_id: null,
              workflow_run_id: RUN,
            }),
          ],
        },
      ],
      [],
    );
    const globalAgent = (profile: string) => (profile === 'work' ? GLOBAL : null);
    expect(pendingHref(chat!, inLink, globalAgent)).toBe(`/chat/${SESSION}?profile=work`);
    expect(pendingHref(inGlobal!, inLink, globalAgent)).toBe('/global-agent?profile=work');
    expect(pendingHref(gate!, inLink, globalAgent)).toBe(
      `/schedules?workflow_run=${RUN}&profile=work`,
    );
    // Someone with one profile gets the addresses they always had.
    expect(pendingHref(chat!, () => null)).toBe(`/chat/${SESSION}`);

    const [pairing] = mergePending(
      [],
      [
        {
          profile: 'default',
          agentId: AGENT_ID,
          items: [
            {
              platform: 'telegram',
              request_id: 'r1',
              user_id: '42',
              user_name: null,
              requested_at: '2026-09-25T10:00:00Z',
            },
          ],
        },
      ],
    );
    expect(pendingHref(pairing!, inLink)).toBe(`/agents/${AGENT_ID}/channels`);

    const [room] = mergePending(
      [
        {
          profile: 'default',
          items: [
            approval({
              id: 'a4',
              created_at: '2026-09-25T10:00:00Z',
              session_id: null,
              room_id: RUN,
            }),
          ],
        },
      ],
      [],
    );
    // A room's question opens its room, in the profile it was asked in (decision §102).
    expect(pendingHref(room!, inLink)).toBe(`/rooms/${RUN}?profile=default`);
    expect(pendingHref(room!, () => null)).toBe(`/rooms/${RUN}`);
  });

  it('counts the writes an agent staged for review, and opens its settings (§102)', () => {
    const write = {
      id: 'w1',
      kind: 'memory' as const,
      action: 'add',
      summary: 'Remember: the deploy runs on Fridays',
      origin: 'foreground',
      created_at: '2026-09-25T10:01:00Z',
      target: 'memory',
      name: null,
      content: 'The deploy runs on Fridays.',
      old_text: null,
    };
    const items = mergePending(
      [{ profile: 'default', items: [approval({ id: 'a1', created_at: '2026-09-25T10:00:00Z' })] }],
      [],
      [{ profile: 'default', agentId: AGENT_ID, items: [write, write] }],
    );
    expect(items.map((i) => i.key)).toEqual(['approval:a1', 'write:default:memory:w1']);
    expect(pendingHref(items[1]!, inLink)).toBe(`/agents/${AGENT_ID}/settings`);
  });
});

// ------------------------------------------------------------------ mounted

interface Seen {
  method: string;
  path: string;
  profile: string | null;
  body: unknown;
}

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

function hub(options: {
  profiles: string[];
  approvals: Record<string, Approval[]>;
  agents?: unknown[];
  pairing?: unknown[];
  writes?: unknown[];
}) {
  const seen: Seen[] = [];
  let pairing = [...((options.pairing ?? []) as Array<{ request_id: string }>)];
  let writes = [...((options.writes ?? []) as Array<{ id: string }>)];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(String(url));
    // Everything after the version segment: the operation's own path.
    const path = pathname.slice(pathname.indexOf('/v1') + 3);
    const headers = new Headers(init.headers);
    const profile = headers.get('X-Hub-Profile');
    const method = (init.method ?? 'GET').toUpperCase();
    seen.push({
      method,
      path,
      profile,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    let status = 200;
    let body: unknown = { items: [], next_cursor: null };
    if (path === '/meta') body = { name: 'Core Hub', setup_required: false };
    else if (path === '/profiles')
      body = {
        items: options.profiles.map((slug) => ({ slug, name: slug, is_default: false })),
        next_cursor: null,
      };
    else if (path === '/approvals')
      body = { items: options.approvals[profile ?? ''] ?? [], next_cursor: null };
    else if (path === '/agents') body = { items: options.agents ?? [], next_cursor: null };
    else if (path.endsWith('/pairing')) body = { pending: pairing, approved: [] };
    else if (path.endsWith('/pending-writes')) body = { items: writes };
    else if (/\/pending-writes\/[a-z]+\/[^/]+(\/approve)?$/.test(path)) {
      const id = path
        .split('/')
        .filter((part) => part !== 'approve')
        .at(-1);
      writes = writes.filter((row) => row.id !== id);
      body = null;
    } else if (/\/pairing\/whatsapp\/requests\/[^/]+(\/approve)?$/.test(path)) {
      // Approved or denied: either way it no longer waits.
      const id = path.split('/requests/')[1]!.replace('/approve', '');
      body = pairing.find((row) => row.request_id === id) ?? null;
      pairing = pairing.filter((row) => row.request_id !== id);
    } else if (path === '/sessions/global-agent') {
      status = 404;
      body = { error: 'x', code: 'not_found' };
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function mount(fetchImpl: typeof fetch, role: string, children: React.ReactNode) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <PaneProvider>{children}</PaneProvider>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('the bar in the top bar', () => {
  it('counts what waits in every profile, asked in each, and opens it as a list', async () => {
    const { fetchImpl, seen } = hub({
      profiles: ['default', 'work'],
      approvals: {
        default: [approval({ id: 'a1', created_at: '2026-09-25T10:00:00Z' })],
        work: [
          approval({
            id: 'a2',
            profile: 'work',
            created_at: '2026-09-25T10:01:00Z',
            kind: 'question',
            title: 'Which branch?',
            answer_mode: 'both',
          }),
        ],
      },
    });
    mount(fetchImpl, 'member', <TopBar title="x" onMenu={() => undefined} />);
    const bar = await screen.findByTestId('pending-actions');
    await waitFor(() => expect(bar.getAttribute('data-count')).toBe('2'));
    expect(bar.getAttribute('aria-label')).toBe('Waiting for you: 2');
    expect(screen.getByTestId('pending-actions-count').textContent).toBe('2');
    const asked = seen.filter((s) => s.path === '/approvals').map((s) => s.profile);
    expect(new Set(asked)).toEqual(new Set(['default', 'work']));
    // A member never asks for pairing requests.
    expect(seen.some((s) => s.path.endsWith('/pairing'))).toBe(false);

    fireEvent.click(bar);
    const sheet = await screen.findByTestId('pending-actions-sheet');
    const items = within(sheet).getAllByTestId('pending-item');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId('approval-card').textContent).toContain('تنفيذ أمر');
    expect(within(items[1]!).getByTestId('approval-card').textContent).toContain('Which branch?');
    expect(within(items[0]!).getByTestId('pending-item-open').getAttribute('href')).toBe(
      `/chat/${SESSION}?profile=default`,
    );
    expect(within(sheet).getByTestId('pending-global-agent').getAttribute('href')).toBe(
      '/global-agent',
    );
  });

  it('says nothing waits, and still leads to the global agent', async () => {
    const { fetchImpl } = hub({ profiles: ['default'], approvals: {} });
    mount(fetchImpl, 'member', <TopBar title="x" onMenu={() => undefined} />);
    const bar = await screen.findByTestId('pending-actions');
    await waitFor(() => expect(bar.getAttribute('aria-label')).toBe('Waiting for you'));
    expect(screen.queryByTestId('pending-actions-count')).toBeNull();
    fireEvent.click(bar);
    expect(await screen.findByTestId('pending-actions-none')).toBeTruthy();
    expect(screen.getByTestId('pending-global-agent')).toBeTruthy();
  });

  it('shows an admin the senders waiting to pair with a channel', async () => {
    const { fetchImpl, seen } = hub({
      profiles: ['default'],
      approvals: {},
      agents: [AGENT],
      pairing: [
        {
          platform: 'whatsapp',
          request_id: 'r1',
          user_id: '966500000001',
          user_name: 'Sara',
          requested_at: '2026-09-25T10:02:00Z',
        },
      ],
    });
    mount(fetchImpl, 'owner', <TopBar title="x" onMenu={() => undefined} />);
    const bar = await screen.findByTestId('pending-actions');
    await waitFor(() => expect(bar.getAttribute('data-count')).toBe('1'));
    expect(seen.some((s) => s.path === `/agents/${AGENT_ID}/pairing`)).toBe(true);
    fireEvent.click(bar);
    const item = await screen.findByTestId('pending-item');
    expect(item.textContent).toContain('Sara wants to message the agent on whatsapp');
    expect(within(item).getByTestId('pending-item-open').getAttribute('href')).toBe(
      `/agents/${AGENT_ID}/channels`,
    );
  });

  it('approves or denies a sender waiting to pair right there, in the profile', async () => {
    const request = (id: string, name: string) => ({
      platform: 'whatsapp',
      request_id: id,
      user_id: `9665000000${id.length}`,
      user_name: name,
      requested_at: '2026-09-25T10:02:00Z',
    });
    const { fetchImpl, seen } = hub({
      profiles: ['default'],
      approvals: {},
      agents: [AGENT],
      pairing: [request('r1', 'Sara'), request('r22', 'Omar')],
    });
    mount(fetchImpl, 'owner', <TopBar title="x" onMenu={() => undefined} />);
    const bar = await screen.findByTestId('pending-actions');
    await waitFor(() => expect(bar.getAttribute('data-count')).toBe('2'));
    fireEvent.click(bar);
    await screen.findAllByTestId('pending-item');

    fireEvent.click(screen.getByTestId('pairing-approve-r1'));
    await waitFor(() => expect(screen.queryByTestId('pairing-approve-r1')).toBeNull());
    expect(
      seen.find((s) => s.method === 'POST' && s.path.endsWith('/requests/r1/approve')),
    ).toMatchObject({ path: `/agents/${AGENT_ID}/pairing/whatsapp/requests/r1/approve` });

    fireEvent.click(screen.getByTestId('pairing-deny-r22'));
    expect(await screen.findByTestId('pending-actions-none')).toBeTruthy();
    expect(
      seen.find((s) => s.method === 'DELETE' && s.path.endsWith('/requests/r22')),
    ).toBeTruthy();
  });
});

describe('writes the agent staged for review (decision §102)', () => {
  const write = {
    id: 'w1',
    kind: 'memory',
    action: 'add',
    summary: 'Remember: the deploy runs on Fridays',
    origin: 'background_review',
    created_at: '2026-09-25T10:01:00Z',
    target: 'user',
    name: null,
    content: 'The deploy runs on Fridays.',
    old_text: null,
  };

  it('counts them for an admin, and approves one right there', async () => {
    const { fetchImpl, seen } = hub({
      profiles: ['default'],
      approvals: {},
      agents: [AGENT],
      writes: [write],
    });
    mount(fetchImpl, 'owner', <TopBar title="x" onMenu={() => undefined} />);
    const bar = await screen.findByTestId('pending-actions');
    await waitFor(() => expect(bar.getAttribute('data-count')).toBe('1'));
    fireEvent.click(bar);
    const item = await screen.findByTestId('pending-item');
    expect(item.getAttribute('data-kind')).toBe('write');
    expect(item.textContent).toContain('Remember: the deploy runs on Fridays');
    expect(within(item).getByTestId('pending-item-open').getAttribute('href')).toBe(
      `/agents/${AGENT_ID}/settings`,
    );
    fireEvent.click(within(item).getByTestId('pending-write-approve'));
    expect(await screen.findByTestId('pending-actions-none')).toBeTruthy();
    expect(seen.find((s) => s.method === 'POST' && s.path.endsWith('/approve'))).toMatchObject({
      path: `/agents/${AGENT_ID}/pending-writes/memory/w1/approve`,
    });
  });

  it('never asks for them for a member', async () => {
    const { fetchImpl, seen } = hub({
      profiles: ['default'],
      approvals: {},
      agents: [AGENT],
      writes: [write],
    });
    mount(fetchImpl, 'member', <TopBar title="x" onMenu={() => undefined} />);
    const bar = await screen.findByTestId('pending-actions');
    await waitFor(() => expect(bar.getAttribute('aria-label')).toBe('Waiting for you'));
    expect(seen.some((s) => s.path.endsWith('/pending-writes'))).toBe(false);
  });
});

describe('the global agent page', () => {
  it('asks the hub for the conversation with the first agent the person could chat with', async () => {
    const { fetchImpl, seen } = hub({ profiles: ['default'], approvals: {}, agents: [AGENT] });
    mount(fetchImpl, 'member', <GlobalAgentScreen />);
    await waitFor(() =>
      expect(seen.find((s) => s.path === '/sessions/global-agent')).toMatchObject({
        method: 'POST',
        profile: 'default',
        body: { agent_id: AGENT_ID },
      }),
    );
  });

  it('says there is no one to talk to when no agent is installed, and asks nothing', async () => {
    const { fetchImpl, seen } = hub({ profiles: ['default'], approvals: {}, agents: [] });
    mount(fetchImpl, 'member', <GlobalAgentScreen />);
    expect(await screen.findByTestId('global-agent-no-agent')).toBeTruthy();
    expect(seen.some((s) => s.path === '/sessions/global-agent')).toBe(false);
  });
});
