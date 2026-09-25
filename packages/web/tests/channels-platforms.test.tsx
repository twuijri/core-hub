/**
 * More messaging platforms on the Channels page, linked like Telegram (the owner: «link more
 * messaging platforms from the Channels page, like Telegram»). They are reached through «ربط منصة»
 * (`channels-picker.test.tsx` covers the picker itself):
 *
 * - «ربط ديسكورد» explains the developer portal in plain steps, hides the token, warns that an
 *   empty allowlist means nobody is answered, sends the credentials and the people in the
 *   selected profile, and names the bot; a refusal is said in Discord's words;
 * - linked, the row names the account, keeps its "how to start" in its own card, and opens
 *   Discord's own settings; Unlink asks first;
 * - a generic platform (Signal) is a form of the variables Hermes reads, said to be unchecked.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';
import ar from '../src/i18n/ar.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { PLATFORMS } from '../../server/src/modules/agents/channel-platforms.js';
import { catalogOf } from './helpers/channel-catalog.js';

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

const CATALOG = catalogOf();

const TOKEN = 'fake-discord-token-for-tests-only-0000000000000000000000000000001';

interface Sent {
  path: string;
  method: string;
  profile: string | null;
  body: unknown;
}

function hub(options: { refuse?: boolean; linked?: string[] } = {}) {
  const sent: Sent[] = [];
  const linked = new Set(options.linked ?? []);
  const channel = (platform: string) => ({
    platform,
    label: platform,
    enabled: linked.has(platform),
    configured: linked.has(platform),
    exclusive: platform === 'discord',
    status: 'unknown',
    error: null,
    login: 'credentials',
    link: linked.has(platform)
      ? {
          linked: true,
          account_id: '1234567890123456789',
          account_name: platform === 'discord' ? 'Office helper' : null,
          account_phone: null,
          account_username: platform === 'discord' ? 'office_helper' : null,
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
        new Response(JSON.stringify(value), {
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
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/channel-platforms')) return json({ items: CATALOG });
    if (path.endsWith('/channels') && method === 'GET') {
      return json({
        items: [...linked].map(channel),
        gateway: { profile: 'manger', state: 'running', applies: 'now', error: null },
      });
    }
    const link = /\/channels\/([a-z_]+)\/link$/.exec(path);
    if (link) {
      if (options.refuse) {
        return json(
          {
            error: 'The request did not match.',
            code: 'validation_failed',
            details: {
              field: 'DISCORD_BOT_TOKEN',
              reason: 'credentials_rejected',
              platform: 'discord',
              message: '401: Unauthorized',
            },
          },
          400,
        );
      }
      linked.add(link[1]!);
      return json(channel(link[1]!));
    }
    const unlink = /\/channels\/([a-z_]+)\/unlink$/.exec(path);
    if (unlink) {
      linked.delete(unlink[1]!);
      return json(channel(unlink[1]!));
    }
    if (path.endsWith('/channels/discord/settings')) {
      return json({
        platform: 'discord',
        options: [
          {
            key: 'require_mention',
            section: 'groups',
            kind: 'toggle',
            value: null,
            default: true,
            choices: null,
            min: null,
            max: null,
            shared: false,
            source: null,
          },
          {
            key: 'allowed_channels',
            section: 'groups',
            kind: 'list',
            value: null,
            default: [],
            choices: null,
            min: null,
            max: null,
            shared: false,
            source: null,
          },
        ],
      });
    }
    if (path.endsWith('/pairing') && method === 'GET') return json({ pending: [], approved: [] });
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

/** «ربط منصة», then the platform. */
async function openForm(platform: string) {
  fireEvent.click(await screen.findByTestId('platform-picker-open'));
  fireEvent.click(await screen.findByTestId(`platform-option-${platform}`));
}

describe('More platforms', () => {
  it('links Discord: the steps, the hidden token, the people, and the bot named', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    await openForm('discord');
    const steps = await screen.findByTestId('platform-steps');
    expect(steps.textContent).toContain('Message Content Intent');
    expect(steps.textContent).toContain('applications.commands');
    const token = screen.getByTestId('platform-field-DISCORD_BOT_TOKEN') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect((screen.getByTestId('platform-link-submit') as HTMLButtonElement).disabled).toBe(true);
    // Discord sends strangers no code: an empty allowlist is said to answer nobody.
    expect(screen.getByTestId('platform-allowlist-empty')).toBeTruthy();

    fireEvent.change(token, { target: { value: ` ${TOKEN} ` } });
    fireEvent.change(screen.getByTestId('platform-allowed'), {
      target: { value: '111222333444555666، 777888999' },
    });
    expect(screen.queryByTestId('platform-allowlist-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('platform-link-submit'));

    const done = await screen.findByTestId('platform-link-done');
    expect(done.textContent).toContain('@office_helper');
    expect(sent.find((entry) => entry.path.endsWith('/channels/discord/link'))).toMatchObject({
      method: 'POST',
      profile: 'manger',
      body: {
        credentials: { DISCORD_BOT_TOKEN: TOKEN },
        allowed_users: ['111222333444555666', '777888999'],
      },
    });
    fireEvent.click(screen.getByTestId('platform-link-close'));

    await waitFor(() =>
      expect(screen.getByTestId('channel-account-discord').textContent).toContain('@office_helper'),
    );
    // Discord answers only its allowlist, so nobody waits for approval: its "how to start" stays
    // behind the card's own button.
    expect(screen.queryByTestId('platform-how-discord')).toBeNull();
    fireEvent.click(screen.getByTestId('channel-guide-discord'));
    const how = screen.getByTestId('platform-how-discord');
    expect(how.textContent).toMatch(/قائمة المسموح|allowed list/);
    expect(screen.getByTestId('channel-list').contains(how)).toBe(true);
    // Linked, the picker marks it instead of offering it again.
    fireEvent.click(screen.getByTestId('platform-picker-open'));
    expect(screen.getByTestId('platform-option-linked-discord')).toBeTruthy();
  });

  it('says in Discord’s words why it refused the token', async () => {
    const { fetchImpl } = hub({ refuse: true });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    await openForm('discord');
    fireEvent.change(await screen.findByTestId('platform-field-DISCORD_BOT_TOKEN'), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByTestId('platform-link-submit'));
    const error = await screen.findByTestId('platform-link-error');
    expect(error.textContent).toContain('401: Unauthorized');
    expect(error.textContent).toMatch(/ديسكورد|Discord/);
  });

  it('opens Discord’s own settings on its row, and unlinks after a confirm', async () => {
    const { fetchImpl, sent } = hub({ linked: ['discord'] });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('channel-settings-discord'));
    expect((await screen.findByTestId('discord-settings')).textContent).toMatch(
      /إعدادات ديسكورد|Discord settings/,
    );
    expect((await screen.findByTestId('discord-settings-groups')).textContent).toMatch(
      /في القنوات: الرد عند الإشارة فقط|In channels: answer only when mentioned/,
    );
    expect(screen.getByTestId('discord-setting-allowed_channels')).toBeTruthy();

    fireEvent.click(screen.getByTestId('channel-unlink-discord'));
    expect(sent.some((entry) => entry.path.endsWith('/unlink'))).toBe(false);
    expect((await screen.findByTestId('confirm-dialog')).textContent).toMatch(/ديسكورد|Discord/);
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await screen.findByTestId('channels-empty');
    expect(screen.getByTestId('channel-unlinked').textContent).toMatch(/ديسكورد|Discord/);
    expect(sent.find((entry) => entry.path.endsWith('/channels/discord/unlink'))).toMatchObject({
      method: 'POST',
      profile: 'manger',
    });
  });

  it('links a generic platform with the variables Hermes reads, said to be unchecked', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    await openForm('signal');
    expect((await screen.findByTestId('platform-generic-note')).textContent).toMatch(
      /لا يتحقق|does not check/,
    );
    expect(screen.queryByTestId('platform-steps')).toBeNull();
    fireEvent.change(screen.getByTestId('platform-field-SIGNAL_HTTP_URL'), {
      target: { value: 'http://signal:8080' },
    });
    fireEvent.change(screen.getByTestId('platform-field-SIGNAL_ACCOUNT'), {
      target: { value: '+966500000000' },
    });
    expect((screen.getByTestId('platform-link-submit') as HTMLButtonElement).textContent).toMatch(
      /^(ربط|Link)$/,
    );
    fireEvent.click(screen.getByTestId('platform-link-submit'));
    await screen.findByTestId('platform-link-done');
    expect(sent.find((entry) => entry.path.endsWith('/channels/signal/link'))).toMatchObject({
      body: {
        credentials: { SIGNAL_HTTP_URL: 'http://signal:8080', SIGNAL_ACCOUNT: '+966500000000' },
      },
    });
  });
});

interface Words {
  channels: {
    platform: Record<string, unknown> & {
      name: Record<string, string>;
      field: Record<string, string>;
    };
    settings: {
      option: Record<string, { label?: string; help?: string } | undefined>;
      choice: Record<string, Record<string, string> | undefined>;
      platform: Record<
        string,
        { option?: Record<string, { label?: string; help?: string } | undefined> } | undefined
      >;
    };
  };
}

describe('Words for every platform the hub checks', () => {
  it('has a name, the steps, every field and every option, in both languages', () => {
    for (const spec of PLATFORMS.filter(
      (entry) => entry.support === 'full' && entry.login === 'credentials',
    )) {
      for (const dictionary of [ar, en] as unknown as Words[]) {
        const words = dictionary.channels.platform;
        const own = words[spec.platform] as Record<string, string> | undefined;
        expect(words.name[spec.platform], spec.platform).toBeTruthy();
        for (const key of ['intro', 'step1', 'how']) {
          expect(own?.[key], `${spec.platform}.${key}`).toBeTruthy();
        }
        for (const credential of spec.credentials) {
          expect(words.field[credential.key], credential.key).toBeTruthy();
        }
        for (const option of spec.settings ?? []) {
          const settings = dictionary.channels.settings;
          const text =
            settings.platform[spec.platform]?.option?.[option.key] ?? settings.option[option.key];
          expect(text?.label, `${spec.platform}.${option.key}`).toBeTruthy();
          expect(text?.help, `${spec.platform}.${option.key}`).toBeTruthy();
          for (const value of option.choices ?? []) {
            expect(settings.choice[option.key]?.[value], `${option.key}.${value}`).toBeTruthy();
          }
        }
      }
    }
  });
});
