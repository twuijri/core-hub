// Local models on the Models screen (ADR 0032): Ollama installed by the hub, found already on
// the computer, or absent — and its models, downloaded, followed and deleted from the card.
// Only an owner or admin on the desktop app's hub sees any of it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { LocalRuntimeCard } = await import('../src/models/LocalRuntimeCard.js');

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

function runtime(over: Record<string, unknown> = {}) {
  return {
    available: true,
    mode: 'managed',
    state: 'running',
    error: null,
    version: '0.40.13',
    latest_version: '0.40.13',
    update_available: false,
    base_url: 'http://127.0.0.1:11434',
    platform: 'win32-x64',
    gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', cuda: 'cuda_v13' },
    download_bytes: null,
    job_id: null,
    ...over,
  };
}

const GB = 1024 ** 3;

function models(over: Record<string, unknown> = {}) {
  return {
    installed: [
      {
        name: 'qwen3:8b',
        size: 5 * GB,
        modified_at: '2026-10-30T10:00:00Z',
        family: 'qwen3',
        parameter_size: '8.2B',
        quantization: 'Q4_K_M',
      },
    ],
    loaded: [
      { name: 'qwen3:8b', size: 5 * GB, size_vram: 5 * GB, expires_at: '2026-10-30T10:05:00Z' },
    ],
    suggested: [
      {
        name: 'qwen3:8b',
        size_bytes: 5 * GB,
        memory_bytes: 16 * GB,
        tools: true,
        installed: true,
        fits: true,
      },
      {
        name: 'gpt-oss:120b',
        size_bytes: 65 * GB,
        memory_bytes: 96 * GB,
        tools: true,
        installed: false,
        fits: false,
      },
      {
        name: 'llama3.2:3b',
        size_bytes: 2 * GB,
        memory_bytes: 8 * GB,
        tools: true,
        installed: false,
        fits: true,
      },
    ],
    memory_bytes: 32 * GB,
    disk_free_bytes: 200 * GB,
    pulls: [],
    ...over,
  };
}

function job(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    profile: 'default',
    owner_id: 'u',
    created_at: '2026-10-30T10:00:00Z',
    updated_at: '2026-10-30T10:00:01Z',
    kind: 'install',
    status: 'running',
    progress: { percent: 40, message: null },
    resource: null,
    result: null,
    error: null,
    started_at: '2026-10-30T10:00:00Z',
    finished_at: null,
    ...over,
  };
}

interface Sent {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

function hub(
  state: {
    runtime?: Record<string, unknown> | 'forbidden';
    models?: Record<string, unknown>;
    jobs?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({ method, path, search: url.search, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const none = () => Promise.resolve(new Response(null, { status: 204 }));
    if (path.startsWith('/jobs/')) {
      const id = path.slice('/jobs/'.length);
      return json(state.jobs?.[id] ?? job(id));
    }
    if (path === '/models/local-runtime/models') {
      if (method === 'POST') return json({ job_id: 'JOB-PULL' }, 202);
      if (method === 'DELETE') return none();
      return json(state.models ?? models());
    }
    if (path === '/models/local-runtime/install') return json({ job_id: 'JOB-INSTALL' }, 202);
    if (path === '/models/local-runtime/update') return json({ job_id: 'JOB-UPDATE' }, 202);
    if (path === '/models/local-runtime') {
      if (method === 'DELETE') return none();
      if (state.runtime === 'forbidden') {
        return json({ error: 'Admins only.', code: 'forbidden' }, 403);
      }
      return json(state.runtime ?? runtime());
    }
    return json({ items: [] });
  };
  return { sent, fetchImpl };
}

function show(fetchImpl: typeof fetch, role: 'owner' | 'admin' | 'member' = 'owner') {
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
                <div data-testid="host">
                  <LocalRuntimeCard />
                </div>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const asked = (sent: Sent[], method: string, path: string) =>
  sent.filter((each) => each.method === method && each.path === path);

describe('local models card', () => {
  it('is not there for a member, and the hub is not even asked', async () => {
    const { sent, fetchImpl } = hub();
    show(fetchImpl, 'member');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('local-runtime-card')).toBeNull();
    expect(asked(sent, 'GET', '/models/local-runtime')).toHaveLength(0);
  });

  it('is not there when the hub is not the desktop app’s, nor when it refuses', async () => {
    const off = hub({ runtime: runtime({ available: false, mode: 'none', state: 'stopped' }) });
    show(off.fetchImpl, 'admin');
    await waitFor(() => expect(asked(off.sent, 'GET', '/models/local-runtime')).toHaveLength(1));
    expect(screen.queryByTestId('local-runtime-card')).toBeNull();
    cleanup();

    const refused = hub({ runtime: 'forbidden' });
    show(refused.fetchImpl, 'admin');
    await waitFor(() =>
      expect(asked(refused.sent, 'GET', '/models/local-runtime')).toHaveLength(1),
    );
    expect(screen.getByTestId('host').textContent).toBe('');
  });

  it('with no Ollama: the card, the graphics card and the size, and Install starts a job', async () => {
    const { sent, fetchImpl } = hub({
      runtime: runtime({
        mode: 'none',
        state: 'stopped',
        version: null,
        latest_version: '0.40.13',
        base_url: null,
        download_bytes: 1.5 * GB,
      }),
      jobs: { 'JOB-INSTALL': job('JOB-INSTALL', { progress: { percent: 45, message: null } }) },
    });
    show(fetchImpl);
    const card = await screen.findByTestId('local-runtime-card');
    expect(card.getAttribute('data-mode')).toBe('none');
    expect(screen.getByTestId('local-gpu').textContent).toContain('NVIDIA GeForce RTX 4070');
    expect(screen.getByTestId('local-download-size').textContent).toContain('1.5 GB');
    expect(screen.queryByTestId('local-mode-badge')).toBeNull();
    expect(screen.queryByTestId('local-models')).toBeNull();

    await userEvent.click(screen.getByTestId('local-install'));
    await waitFor(() =>
      expect(asked(sent, 'POST', '/models/local-runtime/install')).toHaveLength(1),
    );
    const progress = await screen.findByTestId('local-job-progress');
    await waitFor(() => expect(progress.textContent).toContain('45%'));
  });

  it('installed by the hub: its badge, Remove keeping the models, and an update with its size', async () => {
    const { sent, fetchImpl } = hub({
      runtime: runtime({
        state: 'stopped',
        base_url: null,
        latest_version: '0.41.0',
        update_available: true,
        download_bytes: 1.2 * GB,
      }),
    });
    show(fetchImpl);
    expect((await screen.findByTestId('local-mode-badge')).textContent).toBe(
      'Installed by the hub',
    );
    expect(screen.getByTestId('local-update').textContent).toContain('Update to');
    expect(screen.getByTestId('local-update').textContent).toContain('0.41.0');
    expect(screen.getByTestId('local-update-notice').textContent).toContain('1.2 GB');
    expect(screen.getByTestId('local-start')).toBeTruthy();
    expect(screen.queryByTestId('local-stop')).toBeNull();
    // Stopped: there is no Ollama to list models from.
    expect(screen.queryByTestId('local-models')).toBeNull();

    await userEvent.click(screen.getByTestId('local-remove'));
    const dialog = await screen.findByTestId('local-remove-dialog');
    await userEvent.click(within(dialog).getByTestId('local-remove-confirm'));
    await waitFor(() => expect(asked(sent, 'DELETE', '/models/local-runtime')).toHaveLength(1));
    expect(asked(sent, 'DELETE', '/models/local-runtime')[0]?.search).toBe('?keep_models=true');

    // While the update runs, nothing else is started beside it.
    await userEvent.click(screen.getByTestId('local-update'));
    await waitFor(() =>
      expect(asked(sent, 'POST', '/models/local-runtime/update')).toHaveLength(1),
    );
    await waitFor(() =>
      expect((screen.getByTestId('local-remove') as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('already on the computer: its badge, a note about updates, and no install, update or remove', async () => {
    const { fetchImpl } = hub({
      runtime: runtime({ mode: 'external', latest_version: '0.41.0', update_available: true }),
    });
    show(fetchImpl);
    expect((await screen.findByTestId('local-mode-badge')).textContent).toBe(
      'Already on this computer',
    );
    expect(screen.getByTestId('local-update-notice').textContent).toContain(
      'Update it from Ollama itself',
    );
    for (const id of ['local-install', 'local-update', 'local-remove', 'local-start', 'local-stop'])
      expect(screen.queryByTestId(id)).toBeNull();
    // Its models are still the hub's to manage.
    expect(await screen.findByTestId('local-models')).toBeTruthy();
  });

  it('lists the models, marks the loaded one, and downloads a suggestion or a typed name', async () => {
    const { sent, fetchImpl } = hub();
    show(fetchImpl);
    const panel = await screen.findByTestId('local-models');
    await waitFor(() =>
      expect(within(panel).getAllByTestId('local-installed-model')).toHaveLength(1),
    );
    const row = within(panel).getByTestId('local-installed-model');
    expect(row.textContent).toContain('qwen3:8b');
    expect(row.textContent).toContain('8.2B · Q4_K_M');
    expect(within(row).getByTestId('local-loaded').textContent).toBe('Loaded now');
    expect(screen.getByTestId('local-resources').textContent).toContain('32 GB');
    expect(screen.getByTestId('local-resources').textContent).toContain('200 GB');

    const suggestions = within(panel).getAllByTestId('local-suggestion');
    const big = suggestions.find((each) => each.getAttribute('data-model') === 'gpt-oss:120b');
    expect(big?.textContent).toContain('Needs');
    const installed = suggestions.find((each) => each.getAttribute('data-model') === 'qwen3:8b');
    expect(installed?.textContent).toContain('Installed');
    expect(within(installed as HTMLElement).queryByTestId('local-download')).toBeNull();

    const small = suggestions.find((each) => each.getAttribute('data-model') === 'llama3.2:3b');
    expect(small?.textContent).toContain('Fits this computer');
    await userEvent.click(within(small as HTMLElement).getByTestId('local-download'));
    await waitFor(() =>
      expect(asked(sent, 'POST', '/models/local-runtime/models')).toHaveLength(1),
    );
    expect(asked(sent, 'POST', '/models/local-runtime/models')[0]?.body).toEqual({
      name: 'llama3.2:3b',
    });

    await userEvent.type(screen.getByTestId('local-pull-name'), 'hf.co/org/model:Q4_K_M');
    await userEvent.click(screen.getByTestId('local-pull-submit'));
    await waitFor(() =>
      expect(asked(sent, 'POST', '/models/local-runtime/models')).toHaveLength(2),
    );
    expect(asked(sent, 'POST', '/models/local-runtime/models')[1]?.body).toEqual({
      name: 'hf.co/org/model:Q4_K_M',
    });
  });

  it('follows a download a screen opened earlier started, and deletes a model after asking', async () => {
    const { sent, fetchImpl } = hub({
      models: models({ pulls: [{ name: 'gemma3:4b', job_id: 'JOB-GEMMA' }] }),
      jobs: {
        'JOB-GEMMA': job('JOB-GEMMA', {
          progress: { percent: 50, message: 'pulling' },
          result: { model: 'gemma3:4b', completed: 1.5 * GB, total: 3 * GB },
        }),
      },
    });
    show(fetchImpl);
    const pull = await screen.findByTestId('local-pull');
    expect(pull.getAttribute('data-model')).toBe('gemma3:4b');
    await waitFor(() =>
      expect(within(pull).getByTestId('local-pull-progress').textContent).toContain('50%'),
    );
    expect(within(pull).getByTestId('local-pull-progress').textContent).toContain('3 GB');

    await userEvent.click(within(pull).getByTestId('local-pull-cancel'));
    await waitFor(() => expect(asked(sent, 'POST', '/jobs/JOB-GEMMA/cancel')).toHaveLength(1));

    await userEvent.click(screen.getByTestId('local-delete-model'));
    await userEvent.click(await screen.findByTestId('confirm-yes'));
    await waitFor(() =>
      expect(asked(sent, 'DELETE', '/models/local-runtime/models')).toHaveLength(1),
    );
    expect(asked(sent, 'DELETE', '/models/local-runtime/models')[0]?.search).toBe(
      '?name=qwen3%3A8b',
    );
  });
});
