/**
 * Telegram on the Channels page (the owner, 2026-09-24: «ابي تربط التليجرام … لانه ما سويت الا
 * واتساب وانا احتاج تليجرام»):
 *
 * - "Link Telegram" explains @BotFather in plain steps, takes the token (hidden) and optional
 *   user ids that skip approval, and sends them to the hub in the selected profile;
 * - a token the hub (Telegram) refuses is said in words, with Telegram's own reason;
 * - linked, the row names the bot (@username), the page says how to start (open t.me/<bot>, send
 *   a message, approve below), and Unlink asks first.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';
import ar from '../src/i18n/ar.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { TELEGRAM_OPTIONS } from '../../server/src/modules/agents/telegram-settings.js';

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
  profile: 'manger',
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
  capabilities: ['streaming', 'skills', 'memory', 'channels'],
  sections: [],
  default_model: null,
  runtime: {
    state: 'running',
    url: null,
    error: null,
    gateways: [
      {
        profile: 'default',
        state: 'running',
        pid: 10,
        restarts: 0,
        started_at: null,
        error: null,
        channels: [],
        scheduled_jobs: 0,
      },
      {
        profile: 'manger',
        state: 'running',
        pid: 11,
        restarts: 0,
        started_at: null,
        error: null,
        channels: ['whatsapp'],
        scheduled_jobs: 2,
      },
    ],
  },
  install: {
    source: 'bundled',
    version: '1.0.0',
    error: null,
    update_available: false,
    latest_version: null,
  },
} as unknown as Agent;

const option = (
  key: string,
  section: string,
  kind: string,
  fallback: unknown,
  extra: Record<string, unknown> = {},
) => ({
  key,
  section,
  kind,
  value: null as unknown,
  default: fallback,
  choices: null,
  min: null,
  max: null,
  shared: false,
  source: null,
  ...extra,
});
const SETTINGS = [
  option('allowed_users', 'access', 'list', []),
  option('show_reasoning', 'replies', 'toggle', false),
  option('tool_progress', 'replies', 'select', 'off', {
    choices: ['off', 'new', 'all', 'verbose'],
  }),
  option('require_mention', 'groups', 'toggle', false),
  option('allowed_chats', 'groups', 'list', []),
  option('stt_enabled', 'media', 'toggle', true, { shared: true }),
  option('command_menu_max', 'advanced', 'number', 60, { min: 1, max: 100 }),
];

interface Sent {
  path: string;
  method: string;
  profile: string | null;
  body: unknown;
}

function hub(options: { linked?: boolean; refuse?: boolean } = {}) {
  const sent: Sent[] = [];
  let linked = options.linked ?? false;
  let settings = SETTINGS.map((option) => ({ ...option }));
  const telegram = () => ({
    platform: 'telegram',
    label: 'telegram',
    enabled: linked,
    configured: linked,
    exclusive: true,
    status: linked ? 'online' : 'offline',
    error: null,
    login: 'token',
    link: linked
      ? {
          linked: true,
          account_id: '7012345678',
          account_name: 'مساعد المكتب',
          account_phone: null,
          account_username: 'office_helper_bot',
        }
      : {
          linked: false,
          account_id: null,
          account_name: null,
          account_phone: null,
          account_username: null,
        },
    fields: [],
  });
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const method = (init.method ?? 'GET').toUpperCase();
    sent.push({
      path,
      method,
      profile: new Headers(init.headers).get('X-Hub-Profile'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: [AGENT] });
    if (path.endsWith(`/agents/${HERMES}`)) return json(AGENT);
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'manger', name: 'Manger' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Majlis', server_version: '0.0.0' });
    if (path.endsWith('/channels') && method === 'GET') {
      return json({
        items: linked ? [telegram()] : [],
        gateway: { profile: 'manger', state: 'running', applies: 'now', error: null },
      });
    }
    if (path.endsWith('/channels/telegram/link')) {
      if (options.refuse) {
        return json(
          {
            error: 'The request did not match.',
            code: 'validation_failed',
            details: { field: 'token', reason: 'token_rejected', message: 'Unauthorized' },
          },
          400,
        );
      }
      linked = true;
      return json(telegram());
    }
    if (path.endsWith('/channels/telegram/unlink')) {
      linked = false;
      return json(telegram());
    }
    if (path.endsWith('/channels/telegram/settings')) {
      if (method === 'PATCH') {
        const values = (JSON.parse(String(init.body)) as { values: Record<string, unknown> })
          .values;
        settings = settings.map((option) =>
          option.key in values ? { ...option, value: values[option.key] } : option,
        );
      }
      return json({ platform: 'telegram', options: settings });
    }
    if (path.endsWith('/pairing') && method === 'GET') {
      return json({
        pending: [
          {
            platform: 'telegram',
            request_id: 'cccccccccccccccc',
            user_id: '555666777',
            user_name: 'Sara',
            requested_at: new Date().toISOString(),
          },
        ],
        approved: [],
      });
    }
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(path: string, fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'manger',
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
      router={(children) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>}
    />,
  );
}

const TOKEN = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

describe('Link Telegram', () => {
  it('explains BotFather, sends the token and the allowed ids in the profile, and names the bot', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('telegram-link-open'));
    const steps = await screen.findByTestId('telegram-steps');
    expect(steps.textContent).toContain('BotFather');
    expect(steps.textContent).toContain('/newbot');
    const token = screen.getByTestId('telegram-token') as HTMLInputElement;
    expect(token.type).toBe('password');
    const submit = screen.getByTestId('telegram-link-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(token, { target: { value: ` ${TOKEN} ` } });
    fireEvent.change(screen.getByTestId('telegram-allowed'), { target: { value: '12ab' } });
    expect((screen.getByTestId('telegram-link-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('telegram-allowed'), {
      target: { value: '111222333, 444555666' },
    });
    fireEvent.click(screen.getByTestId('telegram-link-submit'));

    const done = await screen.findByTestId('telegram-link-done');
    expect(done.textContent).toContain('@office_helper_bot');
    const call = sent.find((entry) => entry.path.endsWith('/channels/telegram/link'));
    expect(call).toMatchObject({
      method: 'POST',
      profile: 'manger',
      body: { token: TOKEN, allowed_users: ['111222333', '444555666'] },
    });
    fireEvent.click(screen.getByTestId('telegram-link-close'));

    // The row names the bot; the page says how to start, with the bot one click away.
    await waitFor(() =>
      expect(screen.getByTestId('channel-account-telegram').textContent).toContain(
        '@office_helper_bot',
      ),
    );
    const open = screen.getByTestId('telegram-bot-link') as HTMLAnchorElement;
    expect(open.href).toBe('https://t.me/office_helper_bot');
    expect(screen.queryByTestId('telegram-link-open')).toBeNull();
    // A Telegram stranger waiting for approval is listed like any other.
    expect((await screen.findByTestId('pairing-request-cccccccccccccccc')).textContent).toContain(
      'telegram',
    );
  });

  it('says in words why Telegram refused the token', async () => {
    const { fetchImpl } = hub({ refuse: true });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('telegram-link-open'));
    fireEvent.change(await screen.findByTestId('telegram-token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId('telegram-link-submit'));
    const error = await screen.findByTestId('telegram-link-error');
    expect(error.textContent).toContain('Unauthorized');
    expect(error.textContent).toMatch(/BotFather/);
  });

  it('unlinks after a confirm', async () => {
    const { fetchImpl, sent } = hub({ linked: true });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('channel-unlink-telegram'));
    expect(sent.some((entry) => entry.path.endsWith('/unlink'))).toBe(false);
    fireEvent.click(await screen.findByTestId('confirm-yes'));
    await screen.findByTestId('telegram-link-open');
    expect(sent.find((entry) => entry.path.endsWith('/channels/telegram/unlink'))).toMatchObject({
      method: 'POST',
      profile: 'manger',
    });
  });
});

interface Dictionary {
  channels: {
    settings: {
      option: Record<string, { label?: string; help?: string } | undefined>;
      choice: Record<string, Record<string, string> | undefined>;
    };
  };
}

describe('Telegram settings', () => {
  it('has words for every option the hub knows, in both languages', () => {
    for (const spec of TELEGRAM_OPTIONS) {
      for (const dictionary of [en, ar] as unknown as Dictionary[]) {
        const words = dictionary.channels.settings.option[spec.key];
        expect(words?.label, spec.key).toBeTruthy();
        expect(words?.help, spec.key).toBeTruthy();
        for (const value of spec.choices ?? []) {
          expect(
            dictionary.channels.settings.choice[spec.key]?.[value],
            `${spec.key}.${value}`,
          ).toBeTruthy();
        }
      }
    }
  });

  it('opens on the linked row, in sections, and saves several changes at once', async () => {
    const { fetchImpl, sent } = hub({ linked: true });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('channel-settings-telegram'));
    await screen.findByTestId('telegram-settings-replies');
    expect(screen.getByTestId('telegram-settings-groups')).toBeTruthy();
    expect(screen.getByTestId('telegram-settings-media').textContent).toMatch(/WhatsApp|واتساب/);
    // A profile-wide option says it is not Telegram's alone.
    expect(screen.getByTestId('telegram-setting-shared-stt_enabled')).toBeTruthy();
    expect(screen.queryByTestId('telegram-setting-shared-show_reasoning')).toBeNull();
    const save = screen.getByTestId('telegram-settings-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('telegram-setting-show_reasoning'));
    fireEvent.click(screen.getByTestId('telegram-setting-require_mention'));
    fireEvent.change(screen.getByTestId('telegram-setting-allowed_chats'), {
      target: { value: '-1001234567890, -42' },
    });
    fireEvent.click(screen.getByTestId('telegram-settings-save'));
    await screen.findByTestId('telegram-settings-saved');
    const patch = sent.filter((entry) => entry.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({
      path: expect.stringContaining('/channels/telegram/settings'),
      profile: 'manger',
      body: {
        values: {
          show_reasoning: true,
          require_mention: true,
          allowed_chats: ['-1001234567890', '-42'],
        },
      },
    });
    // Set now, so it can go back to Hermes's default.
    expect(screen.getByTestId('telegram-setting-reset-show_reasoning')).toBeTruthy();
  });
});
