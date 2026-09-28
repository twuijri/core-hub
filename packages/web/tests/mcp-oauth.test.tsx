/**
 * Connecting a remote MCP server by OAuth from its row (DECISIONS §122): the chip says whether
 * this profile is signed in, Connect opens the provider's page in the tab it opened on the
 * click and waits for Hermes, a failed test that wants a sign-in offers Connect where it is
 * read, and Disconnect forgets the sign-in after asking. The whole app is mounted on a scripted
 * hub, so what is asserted is what a person meets and what the page asks the hub.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';

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
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, connectNamespace: () => new FakeSocket() };
});

const { App } = await import('../src/app.js');
const { SessionStore } = await import('../src/auth/store.js');

afterEach(cleanup);

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

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

const AGENT = {
  id: HERMES,
  profile: 'default',
  owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
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
  capabilities: ['streaming', 'skills', 'memory', 'mcp'],
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
} as unknown as Agent;

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

type OAuthStatus = 'connected' | 'expired' | 'not_connected' | 'error';

function server(
  name: string,
  config: Record<string, unknown>,
  oauth?: { required: boolean; status: OAuthStatus },
) {
  return {
    name,
    transport: typeof config.url === 'string' ? 'http' : 'stdio',
    enabled: true,
    connected: false,
    tools: [],
    error: null,
    config,
    updated_at: '2026-09-27T08:00:00Z',
    ...(oauth ? { oauth: { ...oauth, expires_at: null } } : {}),
  };
}

const AUTHORIZE = 'https://auth.example/authorize?client_id=c1&state=s1';
const FLOW = '01J8QK3ZR2W7M5N4P6T8V9X0F1';

function hub(options: { status?: OAuthStatus; testError?: string | null } = {}) {
  const sent: Sent[] = [];
  const statuses: Record<string, OAuthStatus> = { clickup: options.status ?? 'not_connected' };
  const added: Record<string, Record<string, unknown>> = {};
  let polls = 0;
  const flow = (state: string, tools: unknown[] = [], name = 'clickup') => ({
    id: FLOW,
    server_name: name,
    status: state,
    authorization_url: AUTHORIZE,
    redirect_uri: 'https://hub.example/cb',
    error: null,
    tools,
    expires_at: '2026-09-27T09:00:00Z',
  });
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ url: `${path}${url.search}`, method, body });
    const json = (value: unknown, code = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: code,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: [AGENT] });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/hub-tools'))
      return json({
        enabled: false,
        available: false,
        unavailable_reason: 'runtime_absent',
        server_name: 'corehub',
        url: null,
        groups: [],
        recent_calls: [],
        updated_at: null,
      });
    const named = /\/mcp-servers\/([^/]+)(\/.*)?$/.exec(path);
    const target = named?.[1] ?? '';
    const rest = named?.[2] ?? '';
    const row = (name: string) =>
      server(name, added[name] ?? { url: 'https://mcp.clickup.example/mcp', auth: 'oauth' }, {
        required: true,
        status: statuses[name] ?? 'not_connected',
      });
    if (path.endsWith('/mcp-servers') && method === 'POST') {
      const input = body as { name: string; config: Record<string, unknown> };
      if (input.name === 'clickup' || added[input.name]) {
        return json(
          { error: 'taken', code: 'conflict', details: { reason: 'mcp_name_taken' } },
          409,
        );
      }
      added[input.name] = input.config;
      return json(row(input.name), 201);
    }
    if (rest === '/oauth' && method === 'POST') {
      polls = 0;
      return json(flow('pending', [], target));
    }
    if (rest === '/oauth' && method === 'DELETE') {
      statuses[target] = 'not_connected';
      return json(row(target));
    }
    if (rest === `/oauth/${FLOW}`) {
      polls += 1;
      if (polls < 2) return json(flow('pending', [], target));
      statuses[target] = 'connected';
      return json(
        flow(
          'approved',
          [
            { name: 'get_tasks', description: null },
            { name: 'create_task', description: null },
          ],
          target,
        ),
      );
    }
    if (rest === '/test') {
      const error = statuses[target] === 'connected' ? null : (options.testError ?? null);
      return json({
        ok: error === null,
        tools: error === null ? [{ name: 'get_tasks', description: null }] : [],
        error,
        duration_ms: 700,
      });
    }
    if (path.endsWith('/mcp-servers')) {
      return json({
        items: [
          row('clickup'),
          server(
            'github',
            { url: 'https://mcp.example/github', headers: { Authorization: '[stored]' } },
            { required: false, status: 'not_connected' },
          ),
          server('legacy', { url: 'https://old-hub.example/mcp' }),
          server('files', { command: 'npx' }),
          ...Object.keys(added).map(row),
        ],
      });
    }
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: '01J8QK3ZR2W7M5N4P6T8V9X0AA', username: 'u', display_name: 'U', role: 'owner' },
  });
  render(
    <App
      store={store}
      baseUrl="http://hub.test"
      fetchImpl={fetchImpl}
      router={(children) => (
        <MemoryRouter initialEntries={[`/agents/${HERMES}/mcp`]}>{children}</MemoryRouter>
      )}
    />,
  );
}

/** The tab `window.open` hands back on the click, before the hub has named the page. */
function fakeTab() {
  const tab = {
    closed: false,
    opener: {} as unknown,
    location: { href: 'about:blank' },
    close: vi.fn(),
  };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  return { tab, open };
}

afterEach(() => vi.restoreAllMocks());

describe('connecting an MCP server by OAuth', () => {
  it('offers it only where Hermes can sign in, and says each profile connects separately', async () => {
    const { fetchImpl } = hub();
    mount(fetchImpl);
    const chip = await screen.findByTestId('mcp-oauth-status-clickup');
    expect(chip.textContent).toContain('Not connected');
    expect(screen.getByTestId('mcp-oauth-connect-clickup').textContent).toBe('Connect OAuth');
    expect(
      within(screen.getByTestId('mcp-oauth-clickup')).getByText(
        'Each profile connects separately.',
      ),
    ).toBeTruthy();
    // A server that signs in by its own header, an older hub, a process: nothing to offer.
    expect(screen.queryByTestId('mcp-oauth-github')).toBeNull();
    expect(screen.queryByTestId('mcp-oauth-legacy')).toBeNull();
    expect(screen.queryByTestId('mcp-oauth-files')).toBeNull();
  });

  it('opens the provider in the tab opened on the click, waits for Hermes, then says connected with the tools and tests', async () => {
    const { fetchImpl, sent } = hub();
    const { tab, open } = fakeTab();
    mount(fetchImpl);
    fireEvent.click(await screen.findByTestId('mcp-oauth-connect-clickup'));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(tab.location.href).toBe(AUTHORIZE));
    expect(tab.opener).toBeNull();
    const start = sent.find(
      (s) => s.method === 'POST' && s.url.endsWith('/mcp-servers/clickup/oauth'),
    );
    expect(start?.body).toEqual({ hub_url: window.location.origin });
    expect((await screen.findByTestId('mcp-oauth-link-clickup')).getAttribute('href')).toBe(
      AUTHORIZE,
    );

    const done = await screen.findByTestId('mcp-oauth-result-clickup', undefined, {
      timeout: 5000,
    });
    expect(done.getAttribute('data-status')).toBe('approved');
    expect(done.textContent).toContain('2 tools');
    await waitFor(() =>
      expect(screen.getByTestId('mcp-oauth-status-clickup').textContent).toContain('Connected'),
    );
    // Signed in: the test runs by itself and shows the count; the button offers a new sign-in.
    const result = await screen.findByTestId('mcp-test-result-clickup');
    expect(result.getAttribute('data-ok')).toBe('true');
    expect(
      sent.filter((s) => s.method === 'POST' && s.url.endsWith('/mcp-servers/clickup/test')),
    ).toHaveLength(1);
    expect(screen.getByTestId('mcp-oauth-connect-clickup').textContent).toBe('Reconnect OAuth');
  });

  it('adds a server by its address and signs it in: the name from the host, the smallest block, the tab to the provider', async () => {
    const { fetchImpl, sent } = hub();
    const { tab } = fakeTab();
    mount(fetchImpl);
    fireEvent.click(await screen.findByTestId('new-mcp'));
    fireEvent.click(await screen.findByRole('radio', { name: 'Sign in (OAuth)' }));
    expect(
      screen.getByRole('radio', { name: 'Sign in (OAuth)' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('radio', { name: 'JSON' }).getAttribute('aria-checked')).toBe('false');
    // Only the sign-in form: the JSON editor is the other way.
    expect(screen.queryByTestId('mcp-config')).toBeNull();
    const url = await screen.findByTestId('mcp-signin-url');
    fireEvent.change(url, { target: { value: 'http://mcp.clickup.com/mcp' } });
    expect(screen.getByText('An https:// address (http:// only for this computer).')).toBeTruthy();
    expect((screen.getByTestId('mcp-signin-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(url, { target: { value: 'https://mcp.clickup.com/mcp' } });
    // `clickup` is taken on this page: the name offered is the next free one, and editable.
    const name = screen.getByTestId('mcp-signin-name') as HTMLInputElement;
    expect(name.value).toBe('clickup-2');
    fireEvent.change(name, { target: { value: 'clickup' } });
    expect(
      screen.getByText('A server named clickup already exists; choose another name.'),
    ).toBeTruthy();
    fireEvent.change(name, { target: { value: 'work-clickup' } });
    fireEvent.click(screen.getByTestId('mcp-signin-submit'));

    await waitFor(() => expect(tab.location.href).toBe(AUTHORIZE));
    const created = sent.find((s) => s.method === 'POST' && s.url.endsWith('/mcp-servers'));
    expect(created?.body).toEqual({
      name: 'work-clickup',
      transport: 'http',
      enabled: true,
      config: { url: 'https://mcp.clickup.com/mcp', auth: 'oauth' },
    });
    expect(
      sent.some((s) => s.method === 'POST' && s.url.endsWith('/mcp-servers/work-clickup/oauth')),
    ).toBe(true);
    // The dialog closed; the new row follows the sign-in to Connected and tests itself.
    await waitFor(() => expect(screen.queryByTestId('mcp-signin-add')).toBeNull());
    const result = await screen.findByTestId('mcp-test-result-work-clickup', undefined, {
      timeout: 5000,
    });
    expect(result.getAttribute('data-ok')).toBe('true');
    expect(screen.getByTestId('mcp-oauth-status-work-clickup').textContent).toContain('Connected');
  });

  it("offers Connect under a test that failed for want of a sign-in, in Hermes's words", async () => {
    const { fetchImpl } = hub({ testError: 'OAuth authentication required — no token found.' });
    fakeTab();
    mount(fetchImpl);
    fireEvent.click(await screen.findByTestId('mcp-test-clickup'));
    const result = await screen.findByTestId('mcp-test-result-clickup');
    expect(result.textContent).toContain('no token found');
    expect(within(result).getByText('This server needs a sign-in.')).toBeTruthy();
    fireEvent.click(within(result).getByTestId('mcp-test-connect-clickup'));
    await screen.findByTestId('mcp-oauth-waiting-clickup');
  });

  it('offers Reconnect when the sign-in ran out, and forgets it on Disconnect after asking', async () => {
    const { fetchImpl, sent } = hub({ status: 'expired' });
    mount(fetchImpl);
    expect((await screen.findByTestId('mcp-oauth-status-clickup')).textContent).toContain(
      'Expired',
    );
    expect(screen.getByTestId('mcp-oauth-connect-clickup').textContent).toBe('Reconnect OAuth');
    fireEvent.click(screen.getByTestId('mcp-oauth-disconnect-clickup'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(
        sent.some((s) => s.method === 'DELETE' && s.url.endsWith('/mcp-servers/clickup/oauth')),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId('mcp-oauth-status-clickup').textContent).toContain('Not connected'),
    );
  });
});

describe('a server row folds', () => {
  const expand = (name: string) => screen.getByTestId(`mcp-expand-${name}`);
  const details = (name: string) => screen.getByTestId(`mcp-details-${name}`);

  it('starts closed, but open where the person is needed (a sign-in never made)', async () => {
    localStorage.clear();
    mount(hub().fetchImpl);
    await screen.findByTestId('mcp-expand-files');
    // clickup requires a sign-in and has none: open, with its Connect in reach.
    expect(expand('clickup').getAttribute('aria-expanded')).toBe('true');
    expect(details('clickup').hidden).toBe(false);
    // A process, a header-signed server, an older hub's row: closed.
    for (const name of ['files', 'github', 'legacy']) {
      expect(expand(name).getAttribute('aria-expanded')).toBe('false');
      expect(details(name).hidden).toBe(true);
    }
    // The header is a button that names what it opens.
    expect(expand('files').tagName).toBe('BUTTON');
    expect(expand('files').getAttribute('aria-controls')).toBe(details('files').id);
  });

  it('opens and folds on a press of its header, never opens the editor, and remembers it', async () => {
    localStorage.clear();
    mount(hub().fetchImpl);
    await screen.findByTestId('mcp-expand-files');
    fireEvent.click(expand('files'));
    expect(expand('files').getAttribute('aria-expanded')).toBe('true');
    expect(details('files').hidden).toBe(false);
    expect(within(details('files')).getByText('Command')).toBeTruthy();
    expect(within(details('files')).getByText('npx')).toBeTruthy();
    expect(screen.queryByTestId('mcp-editor')).toBeNull();

    // The switch and Delete are beside the header, not in it: they change nothing here.
    fireEvent.click(screen.getByTestId('mcp-toggle-files'));
    expect(expand('files').getAttribute('aria-expanded')).toBe('true');

    // Kept on this device: the next visit finds it open.
    cleanup();
    mount(hub().fetchImpl);
    await screen.findByTestId('mcp-expand-files');
    expect(expand('files').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(expand('files'));
    expect(expand('files').getAttribute('aria-expanded')).toBe('false');
    expect(details('files').hidden).toBe(true);
    localStorage.clear();
  });

  it('edits from its own Edit button', async () => {
    localStorage.clear();
    mount(hub().fetchImpl);
    fireEvent.click(await screen.findByTestId('mcp-edit-files'));
    const editor = await screen.findByTestId('mcp-editor');
    expect(within(editor).getByText('files')).toBeTruthy();
    expect(expand('files').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps Reconnect and Disconnect inside the folded part, and Test opens it', async () => {
    localStorage.clear();
    mount(hub({ status: 'connected' }).fetchImpl);
    await screen.findByTestId('mcp-expand-clickup');
    // Signed in: nothing needs the person, so the row starts closed…
    expect(expand('clickup').getAttribute('aria-expanded')).toBe('false');
    // …with the sign-in's buttons under it, out of reach of a stray press.
    expect(details('clickup').hidden).toBe(true);
    expect(details('clickup').contains(screen.getByTestId('mcp-oauth-connect-clickup'))).toBe(true);
    expect(details('clickup').contains(screen.getByTestId('mcp-oauth-disconnect-clickup'))).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId('mcp-test-clickup'));
    expect(expand('clickup').getAttribute('aria-expanded')).toBe('true');
    const result = await screen.findByTestId('mcp-test-result-clickup');
    expect(details('clickup').contains(result)).toBe(true);
    localStorage.clear();
  });
});
