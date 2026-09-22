// The agent chips above the composer: a fresh hub shows Hermes alone, installing an agent
// adds a chip, the order a person drags into survives a reload, and picking a chip decides
// which agent the next session uses.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { AgentChips, selectableAgents } from '../src/chat/AgentChips.js';
import {
  agentOrderKey,
  arrangeAgents,
  moveAgent,
  nextOrder,
  readAgentOrder,
  writeAgentOrder,
} from '../src/chat/agentOrder.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import type { Agent } from '../src/types.js';

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

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    slug: name.toLowerCase(),
    name,
    kind: 'coding',
    adapter: 'hermes',
    status: 'available',
    enabled: true,
    capabilities: [],
    install: { source: 'bundled', version: '1.0.0', updated_at: null, auto_update: false },
    ...(over as Record<string, unknown>),
  } as unknown as Agent;
}

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const CODEX = '01J8QK3ZR2W7M5N4P6T8V9X0CX';
const GEMINI = '01J8QK3ZR2W7M5N4P6T8V9X0GM';

describe('agent order (pure)', () => {
  it('keeps the server order until somebody drags', () => {
    const agents = [agent(HERMES, 'Hermes'), agent(CODEX, 'Codex')];
    expect(arrangeAgents(agents, []).map((a) => a.id)).toEqual([HERMES, CODEX]);
  });

  it('applies the remembered order and leaves a newly installed agent at the end', () => {
    const agents = [agent(HERMES, 'Hermes'), agent(CODEX, 'Codex'), agent(GEMINI, 'Gemini')];
    // Remembered: Codex before Hermes. Gemini has just been installed and is unknown.
    expect(arrangeAgents(agents, [CODEX, HERMES]).map((a) => a.id)).toEqual([
      CODEX,
      HERMES,
      GEMINI,
    ]);
  });

  it('moves one chip and leaves the rest alone, ignoring an impossible move', () => {
    expect(moveAgent(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveAgent(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveAgent(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c']);
  });

  it('remembers ids that are off screen instead of forgetting the arrangement', () => {
    expect(nextOrder([CODEX, HERMES], [HERMES, CODEX, GEMINI])).toEqual([CODEX, HERMES, GEMINI]);
  });

  it('round-trips through storage, per workspace, and survives junk', () => {
    const storage = memoryStorage();
    writeAgentOrder(storage, 'work', [CODEX, HERMES]);
    expect(readAgentOrder(storage, 'work')).toEqual([CODEX, HERMES]);
    // Another workspace has its own arrangement.
    expect(readAgentOrder(storage, 'home')).toEqual([]);
    storage.setItem(agentOrderKey('work'), 'not json');
    expect(readAgentOrder(storage, 'work')).toEqual([]);
    // A storage that throws (private mode) must not take the row down.
    const hostile = {
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => writeAgentOrder(hostile, 'work', [HERMES])).not.toThrow();
  });

  it('hides only what cannot be chosen', () => {
    const agents = [
      agent(HERMES, 'Hermes'),
      agent(CODEX, 'Codex', { enabled: false }),
      agent(GEMINI, 'Gemini', { status: 'disabled' }),
    ];
    expect(selectableAgents(agents).map((a) => a.id)).toEqual([HERMES]);
  });
});

function renderChips(agents: Agent[], onSelect = vi.fn(), selectedId: string | null = null) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = (input) => {
    const body = String(input).includes('/agents') ? { items: agents } : { items: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <AgentChips selectedId={selectedId} onSelect={onSelect} />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return onSelect;
}

const chipNames = () =>
  screen.getAllByTestId('agent-chip').map((el) => el.getAttribute('data-agent-id'));

afterEach(cleanup);

describe('agent chips', () => {
  it('a fresh hub shows one chip; installing another adds one', async () => {
    renderChips([agent(HERMES, 'Hermes')]);
    await waitFor(() => expect(chipNames()).toEqual([HERMES]));
    cleanup();
    renderChips([agent(HERMES, 'Hermes'), agent(CODEX, 'Codex')]);
    await waitFor(() => expect(chipNames()).toEqual([HERMES, CODEX]));
  });

  it('selecting a chip reports the agent, and the current one is marked', async () => {
    const user = userEvent.setup();
    const onSelect = renderChips([agent(HERMES, 'Hermes'), agent(CODEX, 'Codex')], vi.fn(), HERMES);
    await waitFor(() => expect(chipNames()).toHaveLength(2));
    const chips = screen.getAllByTestId('agent-chip');
    // The row is the shared segmented control: Radix marks the chosen option as the
    // checked radio, which is what `.mj-segment[aria-checked='true']` paints. (`data-state`
    // cannot be used here: the tooltip trigger composed onto the same button owns it.)
    expect(chips[0]).toHaveAttribute('aria-checked', 'true');
    expect(chips[1]).toHaveAttribute('aria-checked', 'false');
    await user.click(chips[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: CODEX }));
  });

  it('an agent that is not installed is visible but cannot be chosen, and says why', async () => {
    renderChips([agent(HERMES, 'Hermes'), agent(CODEX, 'Codex', { status: 'not_installed' })]);
    await waitFor(() => expect(chipNames()).toHaveLength(2));
    const [, codex] = screen.getAllByTestId('agent-chip');
    expect(codex).toBeDisabled();
    // The reason is the accessible name now; `title=` (the browser tooltip) is banned
    // from screens by the UI policy, and our tooltip carries the same words.
    expect(codex).toHaveAttribute('aria-label', 'Codex is not ready yet');
  });

  it('with nothing to pick it says so instead of rendering an empty row', async () => {
    renderChips([]);
    await waitFor(() => expect(screen.getByTestId('agent-chips-empty')).toBeTruthy());
  });
});
