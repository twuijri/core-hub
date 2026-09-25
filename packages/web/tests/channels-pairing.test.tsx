/**
 * The Channels page after the owner's report of 2026-09-24 («سويت رستارت وراسلته ولا رد»):
 *
 * - a WhatsApp Hermes paired reads as linked, names the account, offers Unlink (behind a
 *   confirm) instead of Pair by QR, and says in plain words in its own card how to use it —
 *   message the number from another account, approve the first request here — with the
 *   personal-number warning;
 * - in a named profile the page says a change takes effect at once, and how the gateway is;
 * - «الموافقات» (the owner, 2026-09-26): one button in the header with the count waiting, opening
 *   a panel grouped by platform — each waiting sender with its platform, id, name and age,
 *   approved or denied there, and the approved senders, each removable; a card with somebody
 *   waiting links to it;
 * - WhatsApp's mode (the owner's report of 2026-09-26): linking asks «بوت» or «أنا» and guesses
 *   neither; the linked card says which and changes it; «أنا» explains "Message yourself";
 * - a channel the running gateway does not serve says Hermes needs a restart, with the button.
 *
 * The whole app is mounted on a scripted hub; what is asserted is what a person meets and what
 * the page asks the hub.
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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Sent {
  path: string;
  method: string;
  profile: string | null;
  body: unknown;
}

function hub(
  options: {
    linked?: boolean;
    applies?: 'now' | 'on_restart';
    mode?: 'bot' | 'self-chat';
    restartNeeded?: boolean;
  } = {},
) {
  const sent: Sent[] = [];
  let linked = options.linked ?? true;
  let mode = options.mode ?? 'bot';
  let pending = [
    {
      platform: 'whatsapp',
      request_id: 'aaaaaaaaaaaaaaaa',
      user_id: '966500000001@s.whatsapp.net',
      user_name: 'سارة',
      requested_at: minutesAgo(5),
    },
    {
      platform: 'whatsapp',
      request_id: 'bbbbbbbbbbbbbbbb',
      user_id: '966500000002@s.whatsapp.net',
      user_name: null,
      requested_at: minutesAgo(0),
    },
  ];
  let approved = [
    {
      platform: 'whatsapp',
      user_id: '966500000009@s.whatsapp.net',
      user_name: 'خالد',
      approved_at: '2026-09-23T18:40:00Z',
    },
  ];
  const whatsapp = () => ({
    platform: 'whatsapp',
    label: 'whatsapp',
    enabled: linked,
    configured: linked,
    exclusive: true,
    status: linked && !options.restartNeeded ? 'online' : 'offline',
    error: null,
    restart_needed: linked && (options.restartNeeded ?? false),
    login: 'qr',
    link: linked
      ? {
          linked: true,
          account_id: '966500000000:3@s.whatsapp.net',
          account_name: 'مكتب المدير',
          account_phone: '966500000000',
          account_username: null,
          mode,
        }
      : {
          linked: false,
          account_id: null,
          account_name: null,
          account_phone: null,
          account_username: null,
          mode: null,
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
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/channels') && method === 'GET') {
      return json({
        items: [whatsapp()],
        gateway: {
          profile: 'manger',
          state: linked ? 'running' : 'stopped',
          applies: options.applies ?? 'now',
          error: null,
        },
      });
    }
    if (path.endsWith('/channels/whatsapp/unlink')) {
      linked = false;
      return json(whatsapp());
    }
    if (path.endsWith('/channels/whatsapp/mode') && method === 'PUT') {
      mode = (JSON.parse(String(init.body)) as { mode: 'bot' | 'self-chat' }).mode;
      return json(whatsapp());
    }
    if (path.endsWith('/channels/whatsapp/login') && method === 'POST') {
      const body = init.body ? (JSON.parse(String(init.body)) as { mode?: typeof mode }) : {};
      mode = body.mode ?? 'bot';
      linked = true;
      return json({ job_id: 'JOBLOGIN' }, 202);
    }
    if (path.endsWith(`/agents/${HERMES}/restart`) && method === 'POST') {
      return json({ job_id: 'JOBRESTART' }, 202);
    }
    const job = /\/jobs\/(JOB[A-Z]+)$/.exec(path);
    if (job) {
      return json({
        id: job[1],
        kind: job[1] === 'JOBLOGIN' ? 'agents.channel_login' : 'agents.restart',
        status: 'succeeded',
        progress: { percent: 100, message: null },
        result:
          job[1] === 'JOBLOGIN'
            ? {
                status: 'connected',
                account_name: 'مكتب المدير',
                account_phone: '966500000000',
                mode,
                applies: 'now',
              }
            : {},
        error: null,
        created_at: '2026-09-26T00:00:00Z',
        updated_at: '2026-09-26T00:00:01Z',
      });
    }
    if (path.endsWith('/pairing') && method === 'GET') return json({ pending, approved });
    const approve = /\/pairing\/whatsapp\/requests\/([0-9a-f]+)\/approve$/.exec(path);
    if (approve) {
      const row = pending.find((entry) => entry.request_id === approve[1]);
      pending = pending.filter((entry) => entry !== row);
      approved = [
        ...approved,
        {
          platform: row!.platform,
          user_id: row!.user_id,
          user_name: row!.user_name ?? '',
          approved_at: new Date().toISOString(),
        },
      ];
      return json({ ...row, approved_at: new Date().toISOString() });
    }
    const deny = /\/pairing\/whatsapp\/requests\/([0-9a-f]+)$/.exec(path);
    if (deny && method === 'DELETE') {
      pending = pending.filter((entry) => entry.request_id !== deny[1]);
      return json(null, 204);
    }
    const revoke = /\/pairing\/whatsapp\/approved\/(.+)$/.exec(path);
    if (revoke && method === 'DELETE') {
      approved = approved.filter((entry) => entry.user_id !== revoke[1]);
      return json(null, 204);
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

describe('a linked WhatsApp on the Channels page', () => {
  it('reads as linked with its account, offers Unlink, and says how to use it', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    const badge = await screen.findByTestId('channel-link-whatsapp');
    expect(badge.textContent).toMatch(/linked|مربوط/);
    expect(screen.getByTestId('channel-account-whatsapp').textContent).toContain('+966500000000');
    expect(screen.getByTestId('channel-account-whatsapp').textContent).toContain('مكتب المدير');
    expect(screen.queryByTestId('channel-login-whatsapp')).toBeNull();
    expect(screen.queryByTestId('channel-pair-whatsapp')).toBeNull();
    expect(screen.getByTestId('channel-unlink-whatsapp')).toBeTruthy();
    // Plain words: message the number from another account, approve the first request here.
    const how = screen.getByTestId('channel-how-to-use');
    expect(how.textContent).toContain('+966500000000');
    // In WhatsApp's own card, not over the page.
    expect(screen.getByTestId('channel-list').contains(how)).toBe(true);
    expect(screen.getByTestId('channel-personal-warning')).toBeTruthy();
    // A named profile: the change is live, and the gateway says how it is.
    expect(screen.getByTestId('channel-gateway-state').getAttribute('data-state')).toBe('running');
  });

  it('unlinks after a confirm; with senders still waiting, the row stays with Pair by QR', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('channel-unlink-whatsapp'));
    // Nothing is sent before the person confirms.
    expect(sent.some((call) => call.path.endsWith('/unlink'))).toBe(false);
    fireEvent.click(await screen.findByTestId('confirm-yes'));
    await screen.findByTestId('channel-login-whatsapp');
    const unlink = sent.find((call) => call.path.endsWith('/channels/whatsapp/unlink'));
    expect(unlink).toMatchObject({ method: 'POST', profile: 'manger' });
    expect(screen.getByTestId('channel-link-whatsapp').textContent).toMatch(/not linked|غير مربوط/);
    expect(screen.getByTestId('channel-unlinked')).toBeTruthy();
    expect(screen.getByTestId('platform-picker-open')).toBeTruthy();
  });

  it('in the default profile, says a change waits for the Restart', async () => {
    const { fetchImpl } = hub({ applies: 'on_restart' });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    await screen.findByTestId('channel-how-to-use');
    expect(screen.queryByTestId('channel-gateway-state')).toBeNull();
    expect(screen.getByTestId('channel-gateway-note')).toBeTruthy();
  });
});

describe('senders waiting for approval', () => {
  it('wait behind one Approvals button with their count, not in a list under the cards', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    const open = await screen.findByTestId('approvals-open');
    await waitFor(() => expect(open.getAttribute('data-count')).toBe('2'));
    expect(screen.getByTestId('approvals-count').textContent).toBe('2');
    expect(screen.queryByTestId('pairing-section')).toBeNull();
    // The card with somebody waiting links to the same panel.
    fireEvent.click(screen.getByTestId('channel-waiting-whatsapp'));
    const sheet = await screen.findByTestId('approvals-sheet');
    expect(within(sheet).getByTestId('pairing-pending-whatsapp')).toBeTruthy();
    expect(within(sheet).getByTestId('pairing-approved-whatsapp')).toBeTruthy();
  });

  it('are listed with platform, id, name and age; approved or turned down in the profile', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('approvals-open'));
    const first = await screen.findByTestId('pairing-request-aaaaaaaaaaaaaaaa');
    expect(first.textContent).toMatch(/واتساب|WhatsApp/);
    expect(first.textContent).toContain('966500000001@s.whatsapp.net');
    expect(first.textContent).toContain('سارة');
    expect(first.textContent).toMatch(/5/);
    const listed = sent.find((call) => call.path.endsWith('/pairing') && call.method === 'GET');
    expect(listed?.profile).toBe('manger');

    fireEvent.click(screen.getByTestId('pairing-approve-aaaaaaaaaaaaaaaa'));
    await waitFor(() =>
      expect(screen.queryByTestId('pairing-request-aaaaaaaaaaaaaaaa')).toBeNull(),
    );
    expect(
      within(screen.getByTestId('pairing-approved')).getByTestId(
        'pairing-sender-966500000001@s.whatsapp.net',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('pairing-deny-bbbbbbbbbbbbbbbb'));
    await screen.findByTestId('pairing-none');
    expect(
      sent.find(
        (call) =>
          call.method === 'DELETE' &&
          call.path.endsWith('/pairing/whatsapp/requests/bbbbbbbbbbbbbbbb'),
      )?.profile,
    ).toBe('manger');
  });

  it('removes an approved sender after a confirm', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('approvals-open'));
    const remove = await screen.findByTestId('pairing-revoke-966500000009@s.whatsapp.net');
    expect(remove.textContent).toMatch(/Remove|إزالة/);
    fireEvent.click(remove);
    fireEvent.click(await screen.findByTestId('confirm-yes'));
    await screen.findByTestId('pairing-approved-none');
    expect(
      sent.find(
        (call) =>
          call.method === 'DELETE' &&
          call.path.endsWith('/pairing/whatsapp/approved/966500000009@s.whatsapp.net'),
      ),
    ).toBeTruthy();
  });
});

describe("WhatsApp's mode: «بوت» or «أنا»", () => {
  it('asks how the number is used before drawing a code, and links in the mode chosen', async () => {
    const { fetchImpl, sent } = hub({ linked: false });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    fireEvent.click(await screen.findByTestId('channel-login-whatsapp'));
    const pair = await screen.findByTestId('channel-pair');
    const choice = within(pair).getByTestId('channel-pair-mode-choice');
    // Two plain options, neither picked for the person.
    const radios = within(choice).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(choice.textContent).toMatch(/بوت \(رقم مخصص للوكيل\)|Bot \(a number for the agent\)/);
    expect(choice.textContent).toMatch(/أنا \(مراسلة نفسي\)|Me \(Message yourself\)/);
    expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    expect((within(pair).getByTestId('channel-pair-continue') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(sent.some((call) => call.path.endsWith('/login'))).toBe(false);

    fireEvent.click(radios[1]!);
    fireEvent.click(within(pair).getByTestId('channel-pair-continue'));
    await waitFor(() =>
      expect(sent.find((call) => call.path.endsWith('/channels/whatsapp/login'))).toMatchObject({
        method: 'POST',
        profile: 'manger',
        body: { mode: 'self-chat' },
      }),
    );
    // «أنا»: no warning about strangers getting the pairing reply; done says where to write.
    const done = await within(pair).findByTestId('channel-pair-done');
    expect(done.textContent).toMatch(/مراسلة نفسي|Message yourself/);
    expect(within(pair).queryByTestId('channel-pair-warning')).toBeNull();
  });

  it('shows the mode on the linked card, explains "Message yourself", and changes it', async () => {
    const { fetchImpl, sent } = hub({ mode: 'self-chat' });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    const badge = await screen.findByTestId('channel-mode-whatsapp');
    expect(badge.getAttribute('data-mode')).toBe('self-chat');
    const how = await screen.findByTestId('channel-how-to-use');
    expect(how.getAttribute('data-mode')).toBe('self-chat');
    expect(how.textContent).toMatch(/مراسلة نفسي|Message yourself/);
    // Nobody else reaches the agent in this mode: no pairing-reply warning.
    expect(screen.queryByTestId('channel-personal-warning')).toBeNull();

    fireEvent.click(screen.getByTestId('channel-mode-change-whatsapp'));
    const dialog = await screen.findByTestId('channel-mode-dialog');
    const save = within(dialog).getByTestId('channel-mode-save') as HTMLButtonElement;
    // The current mode is chosen; saving the same mode is not a change.
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dialog).getAllByRole('radio')[0]!);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByTestId('channel-mode-dialog')).toBeNull());
    expect(sent.find((call) => call.path.endsWith('/channels/whatsapp/mode'))).toMatchObject({
      method: 'PUT',
      profile: 'manger',
      body: { mode: 'bot' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('channel-mode-whatsapp').getAttribute('data-mode')).toBe('bot'),
    );
    expect(screen.getByTestId('channel-personal-warning')).toBeTruthy();
  });
});

describe('a channel the running gateway does not serve yet', () => {
  it('says Hermes needs a restart, and restarts it from the card', async () => {
    const { fetchImpl, sent } = hub({ restartNeeded: true });
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    const notice = await screen.findByTestId('channel-restart-needed-whatsapp');
    expect(notice.textContent).toMatch(/restart|إعادة تشغيل/);
    fireEvent.click(within(notice).getByTestId('channel-restart-now-whatsapp'));
    await waitFor(() =>
      expect(sent.find((call) => call.path.endsWith(`/agents/${HERMES}/restart`))).toMatchObject({
        method: 'POST',
      }),
    );
  });

  it('says nothing of the kind when the gateway serves it', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/channels`, fetchImpl);
    await screen.findByTestId('channel-link-whatsapp');
    expect(screen.queryByTestId('channel-restart-needed-whatsapp')).toBeNull();
  });
});

describe("Hermes's card", () => {
  it('shows every messaging gateway and its state', async () => {
    const { fetchImpl } = hub();
    mount('/agents', fetchImpl);
    const gateways = await screen.findByTestId('agent-gateways');
    expect(within(gateways).getByTestId('agent-gateway-manger').getAttribute('data-state')).toBe(
      'running',
    );
    expect(within(gateways).getByTestId('agent-gateway-manger').textContent).toContain('whatsapp');
    expect(within(gateways).getByTestId('agent-gateway-default')).toBeTruthy();
    // A profile's gateway also fires its scheduled jobs; the card says how many.
    expect(within(gateways).getByTestId('agent-gateway-jobs-manger').textContent).toMatch(/2/);
    expect(within(gateways).queryByTestId('agent-gateway-jobs-default')).toBeNull();
  });
});
