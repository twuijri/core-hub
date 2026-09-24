// Renaming a profile (contract decision §44) on Settings → Profiles: every profile, the default
// one included, takes any name; the dialog says the id stays; the name reaches the top profile
// chip; Hermes refusing the name is said in the dialog; and the places that named a profile by
// its Hermes id (a Telegram bot already linked elsewhere, an export's file) use its name.
import { HubApiError } from '@corehub/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { describeToolError } from '../src/agents/toolErrors.js';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { createTranslator } from '../src/i18n/index.js';
import { nameFromArchive, slugFromArchive } from '../src/people/ProfileTransfer.js';
import { WorkspacesTab } from '../src/people/WorkspacesTab.js';
import { WorkspaceSwitcher } from '../src/shell/WorkspaceSwitcher.js';

const ME = '01J8QK3ZR2W7M5N4P6T8V9X0HM';
const MAIN = '01J8QK3ZR2W7M5N4P6T8V9X0W1';
const DESIGN = '01J8QK3ZR2W7M5N4P6T8V9X0W2';

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

function profile(id: string, slug: string, name: string) {
  return {
    id,
    slug,
    name,
    avatar: null,
    default_model: null,
    agent_count: 1,
    session_count: 2,
    owner_id: ME,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

/** A hub whose profile list follows the renames it accepts. */
function hub(options: { refuse?: string } = {}) {
  const sent: Sent[] = [];
  const rows = [profile(MAIN, 'default', 'Default'), profile(DESIGN, 'design', 'Design')];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ path, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/profiles') && method === 'GET') return json({ items: rows });
    const patched = rows.find((row) => path.endsWith(`/profiles/${row.id}`));
    if (patched && method === 'PATCH') {
      if (options.refuse) {
        return json(
          {
            code: 'conflict',
            error: "Hermes refused the profile's new name.",
            details: { reason: 'hermes_refused', message: options.refuse },
          },
          409,
        );
      }
      Object.assign(patched, body);
      return json(patched);
    }
    return json({ error: 'not here', code: 'not_found' }, 404);
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
    user: { id: ME, username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter>
              <WorkspaceSwitcher />
              <WorkspacesTab />
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

const cardOf = async (slug: string) =>
  (await screen.findAllByTestId('rename-workspace'))
    .map((button) => button.closest('li')!)
    .find((item) => within(item).queryByText(slug) !== null)!;

describe('renaming a profile', () => {
  it('renames the default profile, keeps its id, and the top chip shows the new name', async () => {
    const { fetchImpl, sent } = hub();
    mount(fetchImpl);
    const card = await cardOf('default');
    await userEvent.click(within(card).getByTestId('rename-workspace'));

    const dialog = await screen.findByTestId('rename-workspace-dialog');
    // What changes, and what does not: the id stays, and Hermes shows the name too.
    expect(dialog.textContent).toContain('The id default does not change');
    expect(dialog.textContent).toContain('Hermes shows it too');
    const input = within(dialog).getByTestId('workspace-name-input') as HTMLInputElement;
    expect(input.maxLength).toBe(64);
    await userEvent.clear(input);
    await userEvent.type(input, 'الرئيسي');
    await userEvent.click(within(dialog).getByTestId('save-workspace-name'));

    await waitFor(() => expect(screen.queryByTestId('rename-workspace-dialog')).toBeNull());
    const patch = sent.find((s) => s.method === 'PATCH')!;
    expect(patch.path).toBe(`/api/v1/profiles/${MAIN}`);
    // Only the name is sent: never a slug.
    expect(patch.body).toEqual({ name: 'الرئيسي' });
    await waitFor(() =>
      expect(screen.getByTestId('workspace-switcher').textContent).toContain('الرئيسي'),
    );
  });

  it('offers a rename on a named profile too, and says the id that stays', async () => {
    const { fetchImpl } = hub();
    mount(fetchImpl);
    const card = await cardOf('design');
    await userEvent.click(within(card).getByTestId('rename-workspace'));
    const dialog = await screen.findByTestId('rename-workspace-dialog');
    expect(dialog.textContent).toContain('Rename Design');
    expect(dialog.textContent).toContain('The id design does not change');
  });

  it("says Hermes's words in the dialog when Hermes refuses the name", async () => {
    const { fetchImpl } = hub({ refuse: 'Display name too long (70 chars, max 64).' });
    mount(fetchImpl);
    const card = await cardOf('default');
    await userEvent.click(within(card).getByTestId('rename-workspace'));
    const dialog = await screen.findByTestId('rename-workspace-dialog');
    await userEvent.type(within(dialog).getByTestId('workspace-name-input'), '!');
    await userEvent.click(within(dialog).getByTestId('save-workspace-name'));
    expect(
      await within(dialog).findByText('Hermes refused: Display name too long (70 chars, max 64).'),
    ).toBeTruthy();
  });
});

describe('where a profile was named by its Hermes id', () => {
  it('a Telegram bot linked in another profile names that profile', () => {
    const inUse = new HubApiError(409, 'conflict', 'Conflict.', {
      code: 'conflict',
      details: { reason: 'token_in_use', profile: 'default' },
    });
    const names: Record<string, string> = { default: 'الرئيسي' };
    const nameOf = (slug: string) => names[slug] ?? slug;
    expect(describeToolError(inUse, createTranslator('en'), nameOf)).toContain('“الرئيسي”');
    expect(describeToolError(inUse, createTranslator('ar'), nameOf)).toContain('الرئيسي');
    // Without the lookup, the id as before.
    expect(describeToolError(inUse, createTranslator('en'))).toContain('“default”');
  });

  it("an export's file carries the name back into the import: the name, and an id to use", () => {
    expect(nameFromArchive('الرئيسي-20260925-101500.tar.gz')).toBe('الرئيسي');
    expect(slugFromArchive('الرئيسي-20260925-101500.tar.gz')).toBe('');
    expect(nameFromArchive('Design Team-20260925-101500.tar.gz')).toBe('Design Team');
    expect(slugFromArchive('Design Team-20260925-101500.tar.gz')).toBe('design-team');
    expect(nameFromArchive('design.tgz')).toBe('design');
  });
});
