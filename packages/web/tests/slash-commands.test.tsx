// The composer's `/` commands (decision §57): which are offered for which agent, how the
// menu filters and is walked with the keyboard, and what a finished `/text` becomes.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Composer } from '../src/chat/Composer.js';
import {
  SLASH_COMMANDS,
  availableCommands,
  filterCommands,
  moveActive,
  parseCommand,
  skillQuery,
  slashQuery,
} from '../src/chat/slashCommands.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';

const HERMES = ['streaming', 'compress', 'steer', 'goals', 'plans', 'learn', 'skill_commands'];

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

type Props = Partial<Parameters<typeof Composer>[0]>;

function renderComposer(props: Props = {}, language: 'ar' | 'en' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  return render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <Composer
                  busy={false}
                  disabled={false}
                  onSend={async () => {}}
                  onCancel={async () => {}}
                  {...props}
                />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;
const options = () =>
  screen.queryAllByRole('option').map((option) => option.getAttribute('data-testid'));
const selected = () =>
  screen
    .queryAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true')
    ?.getAttribute('data-testid');

afterEach(cleanup);

describe('the commands (pure)', () => {
  it('offers the agent’s commands only when it has their capability; the hub’s to everyone', () => {
    const hubOnly = availableCommands(['streaming', 'tools']).map((c) => c.id);
    expect(hubOnly).toEqual(['new', 'fork', 'archive', 'model', 'clear-screen']);
    expect(availableCommands(HERMES).map((c) => c.id)).toEqual(SLASH_COMMANDS.map((c) => c.id));
    expect(availableCommands(['compress']).map((c) => c.id)).toContain('compress');
    expect(availableCommands(['compress']).map((c) => c.id)).not.toContain('steer');
  });

  it('reads the word being typed, and a finished command with its words', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/comp')).toBe('comp');
    expect(slashQuery('/compress now')).toBeNull();
    expect(slashQuery('hello /x')).toBeNull();
    expect(skillQuery('/skill ')).toBe('');
    expect(skillQuery('/skill rev')).toBe('rev');
    expect(skillQuery('/skill review the diff')).toBeNull();
    const offered = availableCommands(HERMES);
    expect(parseCommand('/compress the API', offered)).toMatchObject({
      command: { id: 'compress' },
      arg: 'the API',
    });
    expect(parseCommand('/steer', offered)).toMatchObject({ command: { id: 'steer' }, arg: '' });
    expect(parseCommand('/etc/hosts', offered)).toBeNull();
    expect(parseCommand('/steer x', availableCommands([]))).toBeNull();
  });

  it('filters by the start of the name first, then by name or description', () => {
    const offered = availableCommands(HERMES);
    // `archive` has a `c` in it: after the names that start with one.
    expect(filterCommands(offered, 'c').map((c) => c.id)).toEqual([
      'compress',
      'clear-screen',
      'archive',
    ]);
    const byWords = filterCommands(offered, 'screen', () => '').map((c) => c.id);
    expect(byWords).toEqual(['clear-screen']);
    const described = filterCommands(offered, 'window', (c) =>
      c.id === 'compress' ? 'make room in the window' : '',
    );
    expect(described.map((c) => c.id)).toEqual(['compress']);
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, 1, 0)).toBe(0);
  });
});

describe('the / menu in the composer', () => {
  it('opens on /, filters as one types, and walks with the arrow keys', async () => {
    const user = userEvent.setup();
    renderComposer({ commands: availableCommands(HERMES), onCommand: vi.fn() });
    await user.type(input(), '/');
    expect(screen.getByTestId('slash-menu')).toBeInTheDocument();
    expect(options()).toHaveLength(SLASH_COMMANDS.length);
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    expect(selected()).toBe('slash-option-compress');
    // Each command says what it does.
    expect(screen.getByTestId('slash-option-compress')).toHaveTextContent(/Compress this/);

    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe('slash-option-steer');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(selected()).toBe('slash-option-clear-screen');

    await user.type(input(), 'pl');
    expect(options()).toEqual(['slash-option-plan']);
    expect(selected()).toBe('slash-option-plan');
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy();
  });

  it('Enter on a command that needs no words carries it out and empties the composer', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onCommand = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const onSend = vi.fn(async () => {});
    renderComposer({ commands: availableCommands(HERMES), onCommand, onSend });
    await user.type(input(), '/comp');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('compress', ''));
    // The menu and the typed word leave at once, while the command is still carried out.
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument();
    expect(input().value).toBe('');
    finish();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input().value).toBe(''));
  });

  it('a command that needs words waits for them; Escape closes the menu', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => undefined);
    renderComposer({ commands: availableCommands(HERMES), onCommand });
    await user.type(input(), '/ste');
    await user.keyboard('{Tab}');
    expect(input().value).toBe('/steer ');
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();

    // Sent without the words it needs: kept, and said why.
    await user.clear(input());
    await user.type(input(), '/steer');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('/steer needs words after it.')).toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();

    await user.type(input(), ' use staging');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('steer', 'use staging'));
  });

  it('sends what the command hands back as an ordinary message (nothing running to steer)', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => {});
    renderComposer({
      commands: availableCommands(HERMES),
      onCommand: async () => 'use staging',
      onSend,
    });
    await user.type(input(), '/steer use staging');
    await user.keyboard('{Escape}{Enter}');
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith([{ type: 'text', text: 'use staging' }]),
    );
  });

  it('the agent’s own commands, and any unknown /word, are sent as typed', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => {});
    const onCommand = vi.fn();
    renderComposer({ commands: availableCommands(HERMES), onCommand, onSend });
    await user.type(input(), '/plan a login page');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith([{ type: 'text', text: '/plan a login page' }]),
    );
    await waitFor(() => expect(input().value).toBe(''));
    await user.type(input(), '/zzz');
    expect(screen.getByText(/No command matches/)).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith([{ type: 'text', text: '/zzz' }]));
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('/skill lists the agent’s skills, filtered, and a pick names it in the message', async () => {
    const user = userEvent.setup();
    renderComposer({
      commands: availableCommands(HERMES),
      onCommand: vi.fn(),
      skills: [
        { key: 'code-review', name: 'Code review', description: 'Review a diff' },
        { key: 'release-notes', name: 'Release notes', description: 'Write the notes' },
      ],
    });
    await user.type(input(), '/sk');
    await user.keyboard('{Enter}');
    expect(input().value).toBe('/skill ');
    expect(options()).toEqual([
      'slash-option-skill:code-review',
      'slash-option-skill:release-notes',
    ]);
    await user.type(input(), 'notes');
    expect(options()).toEqual(['slash-option-skill:release-notes']);
    await user.keyboard('{Enter}');
    expect(input().value).toBe('/skill release-notes ');
  });

  it('an agent without commands has no menu, and in Arabic the menu speaks Arabic', async () => {
    const user = userEvent.setup();
    renderComposer({ commands: [] });
    await user.type(input(), '/');
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument();
    cleanup();
    renderComposer({ commands: availableCommands(HERMES), onCommand: vi.fn() }, 'ar');
    await user.type(input(), '/');
    expect(screen.getByText('الأوامر')).toBeInTheDocument();
    expect(screen.getByTestId('slash-option-compress')).toHaveTextContent('اضغط سياق هذه المحادثة');
  });
});
