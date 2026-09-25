/**
 * A coding agent's config files page (contract decision §77) and a person's messaging
 * accounts (§78), each mounted in the whole app on a scripted hub: what is asserted is what a
 * person meets and what the page asks the hub.
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

const CLAUDE = '01J8QK3ZR2W7M5N4P6T8V9X0CC';
const ME = '01J8QK3ZR2W7M5N4P6T8V9X0AA';

const AGENT = {
  id: CLAUDE,
  profile: 'default',
  owner_id: ME,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  kind: 'coding',
  adapter: 'acp',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['streaming', 'tools', 'mcp', 'skills', 'config_files'],
  sections: [],
  default_model: null,
  runtime: { error: null },
  install: {
    source: 'managed',
    version: '0.16.2',
    error: null,
    update_available: false,
    latest_version: null,
  },
} as unknown as Agent;

interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

function file(key: string, content: string | null, revision: string | null) {
  return {
    key,
    label:
      key === 'instructions'
        ? { ar: 'التعليمات', en: 'Instructions' }
        : { ar: 'الإعدادات', en: 'Settings' },
    path: key === 'instructions' ? '~/.claude/CLAUDE.md' : '~/.claude/settings.json',
    language: key === 'instructions' ? 'markdown' : 'json',
    exists: revision !== null,
    size_bytes: content?.length ?? 0,
    revision,
    updated_at: revision ? '2026-09-26T08:00:00Z' : null,
    content,
  };
}

function hub(options: { conflict?: boolean } = {}) {
  const sent: Sent[] = [];
  let instructions = { content: '# notes\n', revision: 'rev1' };
  let links: Array<Record<string, unknown>> = [];
  let codeAsked = 0;
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ path, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: [AGENT] });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/config-files'))
      return json({
        items: [file('instructions', null, instructions.revision), file('settings', null, null)],
      });
    if (path.endsWith('/config-files/instructions') && method === 'GET')
      return json(file('instructions', instructions.content, instructions.revision));
    if (path.endsWith('/config-files/settings') && method === 'GET')
      return json(file('settings', '', null));
    if (path.endsWith('/config-files/instructions') && method === 'PUT') {
      if (options.conflict)
        return json(
          { error: 'conflict', code: 'conflict', details: { reason: 'changed', revision: 'rev9' } },
          409,
        );
      instructions = { content: String(body?.content), revision: 'rev2' };
      return json(file('instructions', instructions.content, instructions.revision));
    }
    if (path.endsWith('/auth/me')) {
      return json({
        id: ME,
        username: 'owner',
        display_name: 'Tariq',
        role: 'owner',
        status: 'active',
        locale: 'en',
        profiles: ['default'],
        default_profile: 'default',
        last_login_at: null,
        created_at: '2026-09-01T00:00:00Z',
      });
    }
    if (path.endsWith('/auth/me/channel-identities/link-codes')) {
      codeAsked += 1;
      return json(
        {
          code: 'corehub_7K3M9QX2AB',
          command: '/start corehub_7K3M9QX2AB',
          expires_at: '2026-09-26T08:10:00Z',
        },
        201,
      );
    }
    if (path.endsWith('/auth/me/channel-identities')) {
      // The account shows up once the code was asked for and the list asked again.
      if (codeAsked > 0 && links.length === 0) {
        links = [
          {
            id: '01J9ZT1A2B3C4D5E6F7G8H9J0K',
            user_id: ME,
            platform: 'telegram',
            sender_id: '4242',
            linked_at: '2026-09-26T08:01:00Z',
            last_used_at: null,
          },
        ];
        return json({ items: [] });
      }
      return json({ items: links });
    }
    if (path.includes('/auth/me/channel-identities/') && method === 'DELETE') {
      links = [];
      return json(null, 204);
    }
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(path: string, fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: ME, username: 'owner', display_name: 'Tariq', role: 'owner' },
  });
  render(
    <App
      store={store}
      baseUrl="http://hub.test"
      fetchImpl={fetchImpl}
      router={(children) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>}
    />,
  );
}

describe("a coding agent's config files", () => {
  it('says the files are shared by every profile, edits CLAUDE.md, and saves with the revision read', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${CLAUDE}/config-files`, fetchImpl);
    const page = await screen.findByTestId('config-files');
    expect(within(page).getByTestId('config-files-shared').textContent).toContain(
      'shared by every profile',
    );
    // The page is in the agent's own list, before Settings.
    const nav = await screen.findByTestId('agent-sections');
    const rows = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('data-nav-id'));
    expect(rows.indexOf('agent_config_files')).toBeGreaterThan(-1);
    expect(rows.indexOf('agent_config_files')).toBe(rows.indexOf('agent_settings') - 1);

    const editor = (await screen.findByTestId('config-file-editor-input')) as HTMLTextAreaElement;
    expect(editor.value).toBe('# notes\n');
    expect(screen.getByTestId('config-file-path').textContent).toBe('~/.claude/CLAUDE.md');
    const save = screen.getByTestId('config-file-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(editor, { target: { value: '# notes\nملاحظة بالعربية\n' } });
    expect(save.disabled).toBe(false);
    // Revert throws the edit away.
    fireEvent.click(screen.getByTestId('config-file-revert'));
    expect(editor.value).toBe('# notes\n');

    fireEvent.change(editor, { target: { value: '# notes\nAlways run the tests.\n' } });
    fireEvent.click(screen.getByTestId('config-file-save'));
    await screen.findByTestId('config-file-saved');
    const put = sent.find((s) => s.method === 'PUT');
    expect(put?.path).toBe(`/api/v1/agents/${CLAUDE}/config-files/instructions`);
    expect(put?.body).toEqual({ content: '# notes\nAlways run the tests.\n', revision: 'rev1' });
  });

  it('says so when the file changed since it was read, and offers the current one', async () => {
    const { fetchImpl } = hub({ conflict: true });
    mount(`/agents/${CLAUDE}/config-files`, fetchImpl);
    const editor = (await screen.findByTestId('config-file-editor-input')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByTestId('config-file-save'));
    const error = await screen.findByTestId('config-file-error');
    expect(error.textContent).toContain('changed after you opened it');
    expect(within(error).getByTestId('config-file-reload')).toBeTruthy();
  });
});

describe('messaging accounts', () => {
  it('links an account with a one-time command, sees it appear, and unlinks it', async () => {
    const { fetchImpl, sent } = hub();
    mount('/settings/account', fetchImpl);
    const card = await screen.findByTestId('channel-accounts');
    await within(card).findByTestId('channel-accounts-empty');
    fireEvent.click(within(card).getByTestId('channel-link-start'));
    const command = await within(card).findByTestId('channel-link-command');
    expect(command.textContent).toBe('/start corehub_7K3M9QX2AB');
    expect(command.getAttribute('dir')).toBe('ltr');
    // The list is asked again until the account shows up.
    await within(card).findByTestId('channel-accounts-linked', undefined, { timeout: 8000 });
    const table = within(card).getByTestId('channel-accounts-table');
    expect(table.textContent).toContain('4242');
    expect(table.textContent).toContain('Telegram');

    fireEvent.click(within(card).getByTestId('unlink-01J9ZT1A2B3C4D5E6F7G8H9J0K'));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Unlink' }));
    await waitFor(() =>
      expect(
        sent.some(
          (s) =>
            s.method === 'DELETE' &&
            s.path === '/api/v1/auth/me/channel-identities/01J9ZT1A2B3C4D5E6F7G8H9J0K',
        ),
      ).toBe(true),
    );
  }, 15_000);
});
