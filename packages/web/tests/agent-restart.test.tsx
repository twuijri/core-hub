/**
 * Restarting Hermes from where the person is (owner, 2026-09-25): «خل جنب كلمة هرمز والايقونه
 * زر ريستارت … اذا ضغطته يدور واذا اكتمل يوقف ويطلع تنبيه انه دن». One hook behind two
 * buttons — the icon beside the agent's name in its side list, and «إعادة التشغيل الآن» on the
 * Models screen's Runtime card, whose pending-restart check is now a warning, not a red ✕.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentNav } from '../src/agents/AgentNav.js';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { I18nProvider } from '../src/i18n/context.js';
import { translate, type Language } from '../src/i18n/index.js';
import { useRuntimeReport } from '../src/models/queries.js';
import { RuntimeCard } from '../src/models/RuntimeChecks.js';
import type { RuntimeReport } from '../src/types.js';
import { ToastProvider } from '../src/ui/index.js';

afterEach(cleanup);

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const JOB = '01J8QK3ZR2W7M5N4P6T8V9X0JJ';

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

const hermes = (over: Record<string, unknown> = {}) => ({
  id: HERMES,
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'hermes',
  name: 'Hermes',
  vendor: null,
  kind: 'hermes',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['memory'],
  sections: [],
  default_model: null,
  runtime: { state: 'running', url: null, error: null },
  install: { source: 'managed', version: '1.0.0', error: null, update_available: false },
  ...over,
});

const job = (status: string, error: string | null = null) => ({
  id: JOB,
  kind: 'agents.restart',
  status,
  progress: { percent: status === 'running' ? 10 : 100, message: null },
  resource: null,
  result: null,
  error: error ? { code: 'internal', error } : null,
  started_at: null,
  finished_at: null,
});

interface Script {
  agents: unknown[];
  /** The job as `GET /jobs/{id}` answers it. */
  job: unknown;
  /** Held until the test lets the restart request answer. */
  restart: Promise<void>;
  runtime: () => RuntimeReport;
  calls: string[];
}

function fetchFor(script: Script): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    script.calls.push(`${method} ${new URL(url).pathname}`);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'POST' && url.endsWith(`/agents/${HERMES}/restart`)) {
      await script.restart;
      return json({ job_id: JOB }, 202);
    }
    if (url.includes(`/jobs/${JOB}`)) return json(script.job);
    if (url.includes('/models/runtime')) return json(script.runtime());
    if (url.endsWith('/agents')) return json({ items: script.agents });
    return json({ items: [] });
  }) as typeof fetch;
}

function mount(
  script: Script,
  view: ReactNode,
  role: 'owner' | 'admin' | 'member' = 'admin',
  language: Language = 'en',
) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'u', display_name: 'U', role },
  });
  render(
    <I18nProvider language={language}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchFor(script)}>
          <ToastProvider closeLabel="Close">
            <MemoryRouter>{view}</MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function held() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const report = (reloaded: boolean): RuntimeReport =>
  ({
    agent: 'hermes',
    mode: 'managed',
    ready: reloaded,
    reloaded_at: '2026-09-25T09:00:00Z',
    checks: [
      { id: 'runtime_writable', ok: true, detail: 'managed' },
      { id: 'provider_keys', ok: true, detail: '1' },
      { id: 'model_selected', ok: true, detail: 'anthropic/claude-sonnet-4-5' },
      { id: 'gateway_reloaded', ok: reloaded, detail: null },
    ],
  }) as unknown as RuntimeReport;

describe('the restart beside the agent’s name', () => {
  it('spins while the restart runs, stops when it is done, and says so', async () => {
    const gate = held();
    const script: Script = {
      agents: [hermes()],
      job: job('succeeded'),
      restart: gate.promise,
      runtime: () => report(true),
      calls: [],
    };
    mount(script, <AgentNav agentId={HERMES} current="agent_memory" />);
    // Re-read each time: a disabled button is re-wrapped so its tooltip stays reachable.
    const button = () => screen.getByTestId('agent-restart') as HTMLButtonElement;
    await screen.findByTestId('agent-restart');
    expect(button().getAttribute('aria-label')).toBe('Restart Hermes');
    expect(within(screen.getByTestId('agent-nav-head')).getByText('Hermes')).toBeTruthy();

    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-busy')).toBe('true'));
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId('agent-restart-icon').getAttribute('class')).toContain(
      'animate-spin',
    );
    // A second click while it spins asks for nothing more.
    fireEvent.click(button());

    gate.release();
    expect(await screen.findByText('Restarted')).toBeTruthy();
    await waitFor(() => expect(button().getAttribute('aria-busy')).toBe('false'));
    expect(button().disabled).toBe(false);
    expect(screen.getByTestId('agent-restart-icon').getAttribute('class') ?? '').not.toContain(
      'animate-spin',
    );
    expect(script.calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
  });

  it('stops spinning on a failure and shows the error in the agent’s own words', async () => {
    const script: Script = {
      agents: [hermes()],
      job: job('failed', 'hermes gateway exited (code 1)'),
      restart: Promise.resolve(),
      runtime: () => report(false),
      calls: [],
    };
    mount(script, <AgentNav agentId={HERMES} current="agent_memory" />, 'owner', 'ar');
    fireEvent.click(await screen.findByTestId('agent-restart'));
    expect(await screen.findByText(translate('ar', 'agents.restart_failed'))).toBeTruthy();
    expect(screen.getByText('hermes gateway exited (code 1)')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('agent-restart').getAttribute('aria-busy')).toBe('false'),
    );
    expect(screen.getByTestId('agent-restart').getAttribute('aria-label')).toBe(
      'إعادة تشغيل Hermes',
    );
  });

  it('is not offered to a member, nor for an agent with no runtime to restart', async () => {
    const script: Script = {
      agents: [hermes()],
      job: job('succeeded'),
      restart: Promise.resolve(),
      runtime: () => report(true),
      calls: [],
    };
    mount(script, <AgentNav agentId={HERMES} current="agent_memory" />, 'member');
    await screen.findByTestId('agent-nav-head');
    expect(screen.queryByTestId('agent-restart')).toBeNull();
    cleanup();
    mount(
      {
        ...script,
        agents: [hermes({ runtime: { state: 'not_applicable', url: null, error: null } })],
      },
      <AgentNav agentId={HERMES} current="agent_memory" />,
    );
    await screen.findByTestId('agent-nav-head');
    expect(screen.queryByTestId('agent-restart')).toBeNull();
  });
});

describe('the Runtime card: settings changed after Hermes last started', () => {
  it('is a warning with plain words, and «Restart now» clears it', async () => {
    const script: Script = {
      agents: [hermes()],
      job: job('succeeded'),
      restart: Promise.resolve(),
      // Hermes has started again once the restart was asked for.
      runtime: () => report(script.calls.some((call) => call.startsWith('POST'))),
      calls: [],
    };
    mount(script, <RuntimeCardFromHub />);
    const row = await screen.findByText(translate('en', 'models.runtime.gateway_reloaded.missing'));
    const item = row.closest('li')!;
    expect(item.getAttribute('data-tone')).toBe('warning');
    expect(item.textContent).toContain('⚠');
    expect(item.textContent).not.toContain('✕');
    expect(row.textContent).toBe(
      'Settings changed after Hermes last started — restart it to apply them.',
    );

    fireEvent.click(await screen.findByTestId('runtime-restart-now'));
    expect(await screen.findByText('Restarted')).toBeTruthy();
    // The checks are read again after the restart, and the warning is gone.
    expect(await screen.findByTestId('runtime-all-ok')).toBeTruthy();
    expect(screen.queryByTestId('runtime-restart-now')).toBeNull();
  });

  it('says it in Arabic too, and offers no restart to a member', async () => {
    const script: Script = {
      agents: [hermes()],
      job: job('succeeded'),
      restart: Promise.resolve(),
      runtime: () => report(false),
      calls: [],
    };
    mount(script, <RuntimeCardFromHub />, 'member', 'ar');
    expect(
      await screen.findByText('غيّرت الإعدادات بعد آخر تشغيل لـ Hermes — أعد تشغيله لتطبيقها.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('runtime-restart-now')).toBeNull();
  });
});

/** The card as the Models screen draws it: from `models.getRuntime`, read fresh. */
function RuntimeCardFromHub() {
  const runtime = useRuntimeReport();
  return runtime.data ? <RuntimeCard report={runtime.data} /> : null;
}
