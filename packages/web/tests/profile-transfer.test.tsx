// Export and import of a profile (ADR 0014 stage 2) on Settings → Profiles: what the person
// is told before anything starts (keys stay behind), the job followed to its end, the file
// saved when it is done, the slug an archive suggests, and the hub's own sentences when it
// refuses — a hub without its own Hermes, and Hermes saying no.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { slugFromArchive } from '../src/people/ProfileTransfer.js';
import { WorkspacesTab } from '../src/people/WorkspacesTab.js';

const ME = '01J8QK3ZR2W7M5N4P6T8V9X0HM';
const JOB = '01J8QK3ZR2W7M5N4P6T8V9X0JC';
const FILE = '01J8QK3ZR2W7M5N4P6T8V9X0AX';

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

function workspace(over: Record<string, unknown> = {}) {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0W1',
    slug: 'default',
    name: 'Default',
    avatar: null,
    default_model: null,
    agent_count: 1,
    session_count: 2,
    owner_id: ME,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

function job(over: Record<string, unknown>) {
  return {
    id: JOB,
    profile: 'default',
    owner_id: ME,
    created_at: '2026-09-24T10:00:00Z',
    updated_at: '2026-09-24T10:00:01Z',
    kind: 'export',
    status: 'succeeded',
    progress: { percent: 100, message: null },
    resource: null,
    result: null,
    error: null,
    started_at: '2026-09-24T10:00:00Z',
    finished_at: '2026-09-24T10:00:01Z',
    ...over,
  };
}

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

function hub(answers: {
  exportAnswer?: [number, unknown];
  job?: Record<string, unknown>;
  workspaces?: unknown[];
}) {
  const sent: Sent[] = [];
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
    if (path.endsWith('/profiles') && method === 'GET')
      return json({ items: answers.workspaces ?? [workspace()] });
    if (path.endsWith('/export')) {
      const [status, value] = answers.exportAnswer ?? [202, { job_id: JOB }];
      return json(value, status);
    }
    if (path.endsWith('/profile-imports')) return json({ job_id: JOB }, 202);
    if (path.endsWith(`/jobs/${JOB}`)) return json(answers.job ?? job({}));
    if (path.endsWith(`/attachments/${FILE}/content`))
      return Promise.resolve(
        new Response(new Uint8Array([0x1f, 0x8b, 8]), {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        }),
      );
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
            <RealtimeProvider>
              <MemoryRouter>
                <WorkspacesTab />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const saved: string[] = [];
beforeEach(() => {
  saved.length = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('export', () => {
  it('says keys stay behind, follows the job, and saves the archive when it is done', async () => {
    const { fetchImpl, sent } = hub({
      job: job({
        result: {
          attachment_id: FILE,
          profile: 'default',
          name: 'default-20260924-100001.tar.gz',
          size_bytes: 48_213,
          expires_at: '2026-09-25T10:00:01Z',
          removed: ['default/.env'],
          masked: [],
        },
      }),
    });
    mount(fetchImpl);
    await userEvent.click(await screen.findByTestId('export-workspace'));
    const dialog = await screen.findByTestId('export-workspace-dialog');
    expect(within(dialog).getByText(/Keys stay behind/)).toBeTruthy();
    // Nothing starts until the person asks.
    expect(sent.some((s) => s.path.endsWith('/export'))).toBe(false);

    await userEvent.click(within(dialog).getByTestId('start-export'));
    expect(await within(dialog).findByTestId('export-ready')).toBeTruthy();
    expect(within(dialog).getByTestId('export-ready').textContent).toContain(
      'default-20260924-100001.tar.gz (47 KB)',
    );
    expect(within(dialog).getByText('Left out: default/.env')).toBeTruthy();
    await waitFor(() => expect(saved).toEqual(['default-20260924-100001.tar.gz']));
    expect(sent.some((s) => s.path.endsWith(`/attachments/${FILE}/content`))).toBe(true);
    // Saved once; the button saves it again on request.
    await userEvent.click(within(dialog).getByTestId('download-export'));
    await waitFor(() => expect(saved).toHaveLength(2));
  });

  it("shows the hub's sentence when it does not run Hermes itself", async () => {
    const { fetchImpl } = hub({
      exportAnswer: [
        409,
        {
          error: 'Exporting and importing a profile needs the Hermes this hub runs itself.',
          code: 'state_invalid',
          details: { reason: 'hermes_not_supervised' },
        },
      ],
    });
    mount(fetchImpl);
    await userEvent.click(await screen.findByTestId('export-workspace'));
    await userEvent.click(await screen.findByTestId('start-export'));
    expect(await screen.findByText(/needs the Hermes this hub runs itself/)).toBeTruthy();
    expect(saved).toEqual([]);
  });
});

describe('import', () => {
  it('suggests a free slug from the archive name', () => {
    expect(slugFromArchive('design-20260924-101500.tar.gz')).toBe('design');
    expect(slugFromArchive('My Profile.tgz')).toBe('my-profile');
  });

  it('refuses a taken slug before anything is sent, and shows Hermes refusing the archive', async () => {
    class Stub {
      status = 201;
      responseText = JSON.stringify({ id: FILE, name: 'design.tar.gz' });
      upload = { addEventListener: () => {} };
      private readonly listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, fn: () => void) {
        this.listeners.set(event, fn);
      }
      send() {
        queueMicrotask(() => this.listeners.get('load')?.());
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', Stub);
    const { fetchImpl, sent } = hub({
      workspaces: [workspace(), workspace({ id: 'w2', slug: 'design', name: 'Design' })],
      job: job({
        kind: 'import',
        status: 'failed',
        error: {
          code: 'conflict',
          error: "Hermes refused to import the archive: Profile 'design-2' already exists",
        },
      }),
    });
    mount(fetchImpl);
    await userEvent.click(await screen.findByTestId('import-workspace'));
    const dialog = await screen.findByTestId('import-workspace-dialog');
    expect(within(dialog).getByTestId('start-import').hasAttribute('disabled')).toBe(true);

    await userEvent.upload(
      within(dialog).getByTestId('import-file'),
      new File([new Uint8Array([0x1f, 0x8b])], 'design-20260924-101500.tar.gz', {
        type: 'application/gzip',
      }),
    );
    // `design` is taken here, so the suggestion is the next free one.
    const slug = within(dialog).getByLabelText('Slug') as HTMLInputElement;
    expect(slug.value).toBe('design-2');
    await userEvent.clear(slug);
    await userEvent.type(slug, 'design');
    expect(within(dialog).getByText('That slug is taken')).toBeTruthy();
    expect(within(dialog).getByTestId('start-import').hasAttribute('disabled')).toBe(true);
    await userEvent.clear(slug);
    await userEvent.type(slug, 'design-2');

    await userEvent.click(within(dialog).getByTestId('start-import'));
    expect(await within(dialog).findByTestId('import-failure')).toBeTruthy();
    expect(within(dialog).getByTestId('import-failure').textContent).toBe(
      "Hermes refused to import the archive: Profile 'design-2' already exists",
    );
    const post = sent.find((s) => s.path.endsWith('/profile-imports'));
    expect(post?.body).toEqual({ attachment_id: FILE, slug: 'design-2', name: 'design-2' });
  });
});
