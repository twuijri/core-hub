/**
 * «ربط منصة» on the Channels page (the owner, 2026-09-25: «ودي ما يكونون لسته كذا تحت، يكون زر
 * "ربط قناة"، اذا ضغطت عليها يعلمك كل الخدمات الي يدعمها هرمز وتربط الي تبي»):
 *
 * - the page lists only what is linked — no catalog of every platform under it, no separate
 *   "Link WhatsApp" / "Link Telegram" buttons;
 * - with nothing linked it is an empty state with the same one button;
 * - the button opens a searchable picker of every platform Hermes has: the popular ones first,
 *   the rest alphabetically in the reader's language, each with its badges;
 * - picking a platform opens that platform's own form.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';
import { createTranslator } from '../src/i18n/index.js';
import { POPULAR_PLATFORMS, pickerGroups } from '../src/agents/ChannelPlatformPicker.js';
import { platformName } from '../src/agents/toolErrors.js';
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
  runtime: { state: 'running', url: null, error: null, gateways: [] },
  install: {
    source: 'bundled',
    version: '1.0.0',
    error: null,
    update_available: false,
    latest_version: null,
  },
} as unknown as Agent;

const CATALOG = catalogOf();

const NO_ACCOUNT = { account_id: null, account_name: null, account_phone: null };

/** What `agents.listChannels` returns for a profile. */
type Row = Record<string, unknown>;

const TELEGRAM: Row = {
  platform: 'telegram',
  label: 'telegram',
  enabled: true,
  configured: true,
  exclusive: true,
  status: 'online',
  error: null,
  login: 'token',
  link: {
    linked: true,
    account_id: '7012345678',
    account_name: 'مساعد المكتب',
    account_phone: null,
    account_username: 'office_helper_bot',
  },
  fields: [],
};

/** Unlinked, but its node stays in `config.yaml` (`enabled: false`): not listed. */
const SLACK_UNLINKED: Row = {
  platform: 'slack',
  label: 'slack',
  enabled: false,
  configured: false,
  exclusive: true,
  status: 'unknown',
  error: null,
  login: 'credentials',
  link: { linked: false, ...NO_ACCOUNT, account_username: null },
  fields: [],
};

/** A WhatsApp switch with no paired phone: not listed. */
const WHATSAPP_UNPAIRED: Row = {
  platform: 'whatsapp',
  label: 'whatsapp',
  enabled: true,
  configured: false,
  exclusive: true,
  status: 'unknown',
  error: null,
  login: 'qr',
  link: { linked: false, ...NO_ACCOUNT },
  fields: [],
};

/** Written into the file by hand, outside the catalog: listed, it is set up. */
const WEBHOOK_BY_HAND: Row = {
  platform: 'webhook',
  label: 'webhook',
  enabled: true,
  configured: true,
  exclusive: false,
  status: 'unknown',
  error: null,
  login: null,
  link: null,
  fields: [
    {
      key: 'port',
      label: { ar: 'port', en: 'port' },
      kind: 'text',
      target: 'configuration',
      value: '8644',
      hint: null,
    },
  ],
};

function hub(items: Row[]) {
  const posted: string[] = [];
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'POST') posted.push(path);
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
        items,
        gateway: { profile: 'manger', state: 'running', applies: 'now', error: null },
      });
    }
    if (path.endsWith('/channels/whatsapp/login')) {
      return json({ job_id: '01J8QK3ZR2W7M5N4P6T8V9X0J1' }, 202);
    }
    if (path.endsWith('/pairing') && method === 'GET') return json({ pending: [], approved: [] });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, posted };
}

function mount(fetchImpl: typeof fetch) {
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
      router={(children) => (
        <MemoryRouter initialEntries={[`/agents/${HERMES}/channels`]}>{children}</MemoryRouter>
      )}
    />,
  );
}

async function openPicker() {
  fireEvent.click(await screen.findByTestId('platform-picker-open'));
  return screen.findByTestId('platform-picker');
}

const optionsIn = (node: HTMLElement) =>
  [...node.querySelectorAll('[data-testid^="platform-option-"]')]
    .map((option) => option.getAttribute('data-testid')!)
    .filter((id) => !id.startsWith('platform-option-linked-'))
    .map((id) => id.replace('platform-option-', ''));

describe('The Channels page lists only what is linked', () => {
  it('shows the linked and the set-up ones, nothing else, and one button', async () => {
    const { fetchImpl } = hub([TELEGRAM, SLACK_UNLINKED, WHATSAPP_UNPAIRED, WEBHOOK_BY_HAND]);
    mount(fetchImpl);
    const list = await screen.findByTestId('channel-list');
    const rows = [...list.querySelectorAll('[data-testid^="channel-toggle-"]')].map((node) =>
      node.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['channel-toggle-telegram', 'channel-toggle-webhook']);
    expect(within(list).getByTestId('channel-account-telegram').textContent).toContain(
      '@office_helper_bot',
    );
    // No catalog under the list, and no per-platform link buttons over it.
    expect(screen.queryByTestId('platform-catalog')).toBeNull();
    expect(screen.queryByTestId('telegram-link-open')).toBeNull();
    expect(screen.queryByTestId('channel-pair-whatsapp')).toBeNull();
    expect(screen.queryByTestId('channels-empty')).toBeNull();
    expect(screen.getAllByTestId('platform-picker-open')).toHaveLength(1);
    expect(screen.getByTestId('platform-picker-open').textContent).toMatch(
      /^(ربط منصة|Link a platform)$/,
    );
    // Nobody approved on Telegram yet, and still its "how to start" waits behind «كيف تبدأ» (the
    // owner, 2026-09-26: it opened by itself on every visit); pressed, it opens in its own card.
    expect(screen.queryByTestId('telegram-how-to-use')).toBeNull();
    const button = within(list).getByTestId('channel-guide-telegram');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    const how = screen.getByTestId('telegram-how-to-use');
    expect(list.contains(how)).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // Approving is the Approvals button at the top now, and the hub restarts Hermes by itself.
    expect(how.textContent).toMatch(
      /«الموافقات» أعلى هذه الصفحة|“Approvals” at the top of this page/,
    );
    expect(how.textContent).not.toMatch(/restart|تشغيل|Waiting for approval|بانتظار الموافقة/i);
    fireEvent.click(button);
    expect(screen.queryByTestId('telegram-how-to-use')).toBeNull();
    // The hub runs Hermes here: no "restart it for a change to take effect" under the title.
    expect(screen.queryByText(/restart it for a change|أعد تشغيله ليسري/)).toBeNull();
  });

  it('with nothing linked, is a short explanation and the same button', async () => {
    const { fetchImpl } = hub([SLACK_UNLINKED, WHATSAPP_UNPAIRED]);
    mount(fetchImpl);
    const empty = await screen.findByTestId('channels-empty');
    expect(empty.textContent).toMatch(/لا منصة مربوطة بعد|No platform linked yet/);
    expect(within(empty).getByTestId('platform-picker-open')).toBeTruthy();
    expect(screen.getAllByTestId('platform-picker-open')).toHaveLength(1);
    expect(screen.queryByTestId('channel-list')).toBeNull();
    expect(screen.queryByTestId('pairing-section')).toBeNull();
    expect(screen.queryByTestId('channel-gateway-note')).toBeNull();
    fireEvent.click(within(empty).getByTestId('platform-picker-open'));
    expect(await screen.findByTestId('platform-picker')).toBeTruthy();
  });
});

describe('The platform picker', () => {
  it('offers every platform Hermes has, the popular ones first, with their badges', async () => {
    const { fetchImpl } = hub([TELEGRAM]);
    mount(fetchImpl);
    const picker = await openPicker();
    const popular = optionsIn(within(picker).getByTestId('platform-picker-popular'));
    const more = optionsIn(within(picker).getByTestId('platform-picker-more'));
    expect(popular).toEqual([...POPULAR_PLATFORMS]);
    expect([...popular, ...more].sort()).toEqual(CATALOG.map((spec) => spec.platform).sort());
    for (const platform of ['photon', 'wecom_callback', 'yuanbao', 'raft', 'buzz']) {
      expect(more, platform).toContain(platform);
    }
    // Telegram is linked here: marked, not offered twice.
    expect(within(picker).getByTestId('platform-option-linked-telegram')).toBeTruthy();
    expect(
      (within(picker).getByTestId('platform-option-telegram') as HTMLButtonElement).disabled,
    ).toBe(true);
    // What a platform needs is on its row.
    expect(within(picker).getByTestId('platform-option-raft').textContent).toMatch(/raft/);
    expect(within(picker).getByTestId('platform-option-sms').textContent).toMatch(
      /عنوانًا عامًّا|public address/,
    );
    expect(within(picker).getByTestId('platform-option-matrix').textContent).toMatch(
      /أول تشغيل|first start/,
    );
  });

  it('finds a platform by the name shown, its own name or Hermes’s key', async () => {
    const { fetchImpl } = hub([]);
    mount(fetchImpl);
    const picker = await openPicker();
    const search = within(picker).getByTestId('platform-picker-search');
    const shown = () => optionsIn(picker);

    fireEvent.change(search, { target: { value: 'تيليجرام' } });
    expect(shown()).toEqual(['telegram']);
    fireEvent.change(search, { target: { value: 'TELEGRAM' } });
    expect(shown()).toEqual(['telegram']);
    fireEvent.change(search, { target: { value: 'imessage' } });
    expect(shown().sort()).toEqual(['bluebubbles', 'photon']);
    fireEvent.change(search, { target: { value: 'wecom callback' } });
    expect(shown()).toEqual(['wecom_callback']);
    // «واتساب» finds both WhatsApps, the linked phone and the business one.
    fireEvent.change(search, { target: { value: 'واتساب' } });
    expect(shown().sort()).toEqual(['whatsapp', 'whatsapp_cloud']);

    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(shown()).toEqual([]);
    expect(within(picker).getByTestId('platform-picker-none').textContent).toContain('zzzz');
  });

  it('opens the platform’s own form', async () => {
    const { fetchImpl, posted } = hub([]);
    mount(fetchImpl);

    fireEvent.click(within(await openPicker()).getByTestId('platform-option-telegram'));
    expect(await screen.findByTestId('telegram-steps')).toBeTruthy();
    expect(screen.queryByTestId('platform-picker')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('telegram-link'), { key: 'Escape' });

    fireEvent.click(within(await openPicker()).getByTestId('platform-option-discord'));
    const discord = await screen.findByTestId('platform-link');
    expect(within(discord).getByTestId('platform-steps').textContent).toContain(
      'Message Content Intent',
    );
    expect(within(discord).getByTestId('platform-field-DISCORD_BOT_TOKEN')).toBeTruthy();
    fireEvent.keyDown(discord, { key: 'Escape' });

    // A generic one: the variables Hermes reads, and what it needs said up front.
    fireEvent.click(within(await openPicker()).getByTestId('platform-option-wecom_callback'));
    const wecom = await screen.findByTestId('platform-link');
    expect(within(wecom).getByTestId('platform-generic-note')).toBeTruthy();
    expect(within(wecom).getByTestId('platform-inbound')).toBeTruthy();
    expect(within(wecom).getByTestId('platform-first-use')).toBeTruthy();
    expect(
      within(wecom).getByTestId('platform-field-WECOM_CALLBACK_ENCODING_AES_KEY'),
    ).toBeTruthy();
    fireEvent.keyDown(wecom, { key: 'Escape' });

    fireEvent.click(within(await openPicker()).getByTestId('platform-option-buzz'));
    const buzz = await screen.findByTestId('platform-link');
    expect(within(buzz).getByTestId('platform-program').textContent).toContain('buzz');
    expect(within(buzz).getByTestId('platform-field-BUZZ_RELAY_URL')).toBeTruthy();
    fireEvent.keyDown(buzz, { key: 'Escape' });

    // WhatsApp pairs by QR: its own dialog asks first how the number is used, then starts
    // Hermes's pairing in that mode.
    fireEvent.click(within(await openPicker()).getByTestId('platform-option-whatsapp'));
    const pair = await screen.findByTestId('channel-pair');
    expect(within(pair).getByTestId('channel-pair-mode')).toBeTruthy();
    expect(posted.some((path) => path.endsWith('/channels/whatsapp/login'))).toBe(false);
    fireEvent.click(within(pair).getAllByRole('radio')[0]!);
    fireEvent.click(within(pair).getByTestId('channel-pair-continue'));
    await waitFor(() =>
      expect(posted.some((path) => path.endsWith('/channels/whatsapp/login'))).toBe(true),
    );
  });
});

describe('The picker’s order', () => {
  it('sorts the rest alphabetically in each language, by the name shown', () => {
    for (const language of ['ar', 'en'] as const) {
      const t = createTranslator(language);
      const { popular, more } = pickerGroups(CATALOG, '', t, language);
      expect(popular.map((spec) => spec.platform)).toEqual([...POPULAR_PLATFORMS]);
      const names = more.map((spec) => platformName(spec.platform, t, spec.label));
      const collator = new Intl.Collator(language, { sensitivity: 'base' });
      expect(names, language).toEqual([...names].sort(collator.compare));
    }
    // The Arabic names are shown in Arabic.
    const ar = createTranslator('ar');
    expect(platformName('whatsapp_cloud', ar)).toBe('واتساب للأعمال');
    expect(platformName('google_chat', ar)).toBe('قوقل شات');
    expect(platformName('teams', ar)).toBe('مايكروسوفت تيمز');
    const en = createTranslator('en');
    expect(platformName('teams', en)).toBe('Microsoft Teams');
  });
});
