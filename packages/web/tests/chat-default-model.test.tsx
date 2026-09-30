/**
 * The composer of an open chat names the default model the way the new-chat screen does
 * (owner, 2026-09-30: a Claude Code chat on the hub's models said only «Default model»): a coding
 * agent on the hub's models runs on the profile's default, «Default · <model>».
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  once() {
    return this;
  }
  connect() {
    this.connected = true;
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {
    this.connected = false;
  }
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
const { ChatScreen } = await import('../src/chat/ChatScreen.js');

const SESSION = '01M3DDZQMF3ZYF19CFCSY692SS';
const GENERATED = '01M3DDZQMF3ZYF19CFCSY692NF';
const ROOT = '/data/workspaces/default';
const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const CLAUDE = '01J8QK3ZR2W7M5N4P6T8V9X0CC';
const PROVIDER = '01J8QK3ZR2W7M5N4P6T8V9X0PV';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

const session = {
  id: SESSION,
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
  agent_id: CLAUDE,
  title: 'Launch plan',
  source: 'chat',
  origin: null,
  channel: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  working_dir: `${ROOT}/${GENERATED}`,
  preview: null,
  pinned: false,
  archived: false,
  category_id: null,
  status: 'idle',
  active_run_id: null,
  parent_session_id: null,
  notify: true,
  message_count: 1,
  usage: null,
  context: null,
  last_message_at: '2026-09-26T00:00:00Z',
  match: null,
};

const message = {
  id: '01M3DDZQMF3ZYF19CFCSY692M1',
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
  session_id: SESSION,
  room_id: null,
  seq: 1,
  author: { kind: 'user', id: 'u', name: 'Admin', avatar: null },
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
  reasoning: null,
  tool_calls: [],
  run_id: null,
  status: 'complete',
  mentions: [],
  handoff: null,
  usage: null,
  reply_to_message_id: null,
};

const hermes = {
  id: HERMES,
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'hermes',
  name: 'Hermes',
  vendor: null,
  kind: 'hermes',
  adapter: 'hermes',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['streaming'],
  sections: [],
  default_model: null,
  runtime: { error: null },
  install: {
    source: 'bundled',
    version: '1.0.0',
    error: null,
    update_available: false,
    latest_version: null,
  },
};

const claude = {
  ...hermes,
  id: CLAUDE,
  slug: 'claude-code',
  name: 'Claude Code',
  kind: 'acp',
  adapter: 'acp',
  model_source: 'hub',
  default_model: { provider_id: PROVIDER, model: 'gemini-3.8-flash-high' },
};
const gemini = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0MD',
  key: 'cli-proxy/gemini-3.8-flash-high',
  provider: 'CLI Proxy',
  provider_id: PROVIDER,
  model: 'gemini-3.8-flash-high',
  alias: null,
  kind: 'chat',
  visible: true,
  disabled: false,
  agent_gateway: true,
  context_window: 1000000,
  capabilities: ['streaming', 'tools'],
};
/** What the agent's row says its default is; null as an older hub, or before it says. */
let agentDefault: unknown = null;
const PROFILES = [
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'designer', name: 'Designer' },
];

const fetchImpl: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  if (path === '/profiles') return json({ items: PROFILES });
  // The Trajectory view itself is `trajectory.test.tsx`'s; here it only has to be switched to.
  if (path.endsWith('/trajectory'))
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'unavailable', code: 'service_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  if (path === '/agents')
    return json({ items: [hermes, { ...claude, default_model: agentDefault }] });
  if (path === '/models/defaults')
    return json({
      default: null,
      fallbacks: [],
      auxiliary: {
        tasks: [],
        assignments: { coding: { provider_id: PROVIDER, model: 'gemini-3.8-flash-high' } },
      },
    });
  if (path === '/models') return json({ items: [gemini], next_cursor: null });
  if (path === '/sessions/working-dirs') return json({ root: ROOT, items: [] });
  if (path === `/sessions/${SESSION}/messages`) return json({ items: [message], has_more: false });
  if (path === `/sessions/${SESSION}/files`)
    return json({ working_dir: session.working_dir, truncated: false, items: [] });
  if (path === `/sessions/${SESSION}` && method === 'GET')
    return json({ ...session, runs: [], pending_approvals: [] });
  return json({ items: [], next_cursor: null });
};

function mount() {
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
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={[`/chat/${SESSION}`]}>
                <Routes>
                  <Route path="/chat/:sessionId?" element={<ChatScreen />} />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('an open coding-agent chat names its default model', () => {
  it("on the hub's models: «Default · <model>», as the new-chat screen says", async () => {
    agentDefault = { provider_id: PROVIDER, model: 'gemini-3.8-flash-high' };
    mount();
    const trigger = await screen.findByTestId('composer-model');
    await waitFor(() => expect(trigger).toHaveTextContent('Default · gemini-3.8-flash-high'));
  });

  it("when the agent's row names none, the profile's coding default", async () => {
    agentDefault = null;
    mount();
    const trigger = await screen.findByTestId('composer-model');
    await waitFor(() => expect(trigger).toHaveTextContent('Default · gemini-3.8-flash-high'));
  });
});
