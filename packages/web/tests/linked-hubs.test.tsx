/**
 * «المراكز المرتبطة» / "Linked hubs" (ADR 0026): invite, use an invite, approve, unlink after a
 * confirmation, share an agent, list a peer's shared agents and ask one a question — and a
 * refusal said in the page's own words.
 *
 * The whole app is mounted on a scripted hub, so what is asserted is what a person meets and
 * what the page asks the hub.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

const PENDING = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0PA',
  name: 'Home hub',
  hub_name: 'Core Hub',
  url: 'https://home.example',
  direction: 'inbound',
  status: 'pending',
  enabled: true,
  fingerprint: '3F9A-1C0B-77DE-5A21-90C4-E2B8-4D17-6A3E',
  version: '1.1.1',
  asks_per_hour: 30,
  last_seen_at: null,
  approved_at: null,
  created_at: '2026-09-27T00:30:00Z',
};
const LINKED = {
  ...PENDING,
  id: '01J8QK3ZR2W7M5N4P6T8V9X0PB',
  name: 'Office hub',
  url: 'https://office.example',
  direction: 'outbound',
  status: 'linked',
  approved_at: '2026-09-27T00:40:00Z',
};
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const SHARE_ID = '01J8QK3ZR2W7M5N4P6T8V9X0SH';

function hub(options: { refuseRequest?: string } = {}) {
  const sent: Sent[] = [];
  let peers: Array<Record<string, unknown>> = [PENDING, LINKED];
  let shared = false;
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ path, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/peer-invites')) {
      return json(
        {
          url: 'https://hub.example/peer-invite/K7QX2M9WTR4V8B3N6P5C1H0JYD?fp=3F9A1C0B77DE5A2190C4E2B84D176A3E',
          expires_at: '2026-09-27T00:40:00Z',
          fingerprint: '3F9A-1C0B-77DE-5A21-90C4-E2B8-4D17-6A3E',
        },
        201,
      );
    }
    if (path.endsWith('/peer-shares') && method === 'PUT') {
      shared = body?.shared === true;
      return json({
        profile: 'default',
        agent_id: AGENT_ID,
        name: 'Hermes',
        shared,
        description: null,
      });
    }
    if (path.endsWith('/peer-shares')) {
      return json({
        items: [
          { profile: 'default', agent_id: AGENT_ID, name: 'Hermes', shared, description: null },
        ],
      });
    }
    if (path.endsWith('/ask')) return json({ answer: 'The meeting is at ten.' });
    if (path.endsWith('/agents') && path.includes('/peers/')) {
      return json({ items: [{ id: SHARE_ID, name: 'Office agent', description: 'Front desk' }] });
    }
    if (path.endsWith('/events')) {
      return json({
        items: [
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0E1',
            peer_id: LINKED.id,
            kind: 'ask_out',
            ok: true,
            detail: null,
            actor_id: null,
            created_at: '2026-09-27T01:00:00Z',
          },
        ],
      });
    }
    if (path.endsWith('/peers') && method === 'POST') {
      if (options.refuseRequest) {
        return json(
          {
            error: 'refused',
            code: 'state_invalid',
            details: { reason: options.refuseRequest },
          },
          409,
        );
      }
      return json({ ...LINKED, id: '01J8QK3ZR2W7M5N4P6T8V9X0PC', status: 'waiting' }, 201);
    }
    if (path.endsWith('/peers')) return json({ items: peers });
    if (path.includes('/peers/') && method === 'PATCH') {
      const id = path.split('/').pop();
      peers = peers.map((p) => (p.id === id ? { ...p, status: 'linked' } : p));
      return json(peers.find((p) => p.id === id));
    }
    if (path.includes('/peers/') && method === 'DELETE') {
      const id = path.split('/').pop();
      peers = peers.filter((p) => p.id !== id);
      return json(null, 204);
    }
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(path: string, fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
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

const PAGE = '/settings/linked-hubs';

describe('the Linked hubs page', () => {
  it('says what a link allows, makes an invite and uses one', async () => {
    const { fetchImpl, sent } = hub();
    mount(PAGE, fetchImpl);
    expect((await screen.findByTestId('linked-hubs-intro')).textContent).toMatch(/tools|أدوات/);
    fireEvent.click(screen.getByTestId('peer-invite-create'));
    const result = await screen.findByTestId('peer-invite-result');
    expect(result.textContent).toContain('/peer-invite/K7QX2M9WTR4V8B3N6P5C1H0JYD');
    expect(within(result).getByTestId('fingerprint').textContent).toBe(
      '3F9A-1C0B-77DE-5A21-90C4-E2B8-4D17-6A3E',
    );

    const invite = 'https://other.example/peer-invite/K7QX2M9WTR4V8B3N6P5C1H0JYD?fp=00';
    fireEvent.change(screen.getByTestId('peer-redeem-url'), { target: { value: invite } });
    fireEvent.click(screen.getByTestId('peer-redeem-submit'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'POST' && s.path.endsWith('/peers'))?.body).toEqual({
        url: invite,
      }),
    );
  });

  it("says a refusal in the page's own words", async () => {
    const { fetchImpl } = hub({ refuseRequest: 'fingerprint_mismatch' });
    mount(PAGE, fetchImpl);
    fireEvent.change(await screen.findByTestId('peer-redeem-url'), {
      target: { value: 'https://other.example/peer-invite/K7QX2M9WTR4V8B3N6P5C1H0JYD?fp=00' },
    });
    fireEvent.click(screen.getByTestId('peer-redeem-submit'));
    expect(await screen.findByText(/different key|بمفتاح غير/)).toBeTruthy();
  });

  it('approves a waiting hub, and unlinks only after a confirmation', async () => {
    const { fetchImpl, sent } = hub();
    mount(PAGE, fetchImpl);
    const pending = await screen.findByTestId(`peer-${PENDING.id}`);
    expect(pending.getAttribute('data-status')).toBe('pending');
    fireEvent.click(within(pending).getByTestId('peer-approve'));
    await waitFor(() =>
      expect(
        sent.find((s) => s.method === 'PATCH' && s.path.endsWith(`/peers/${PENDING.id}`))?.body,
      ).toEqual({ approve: true }),
    );

    const linked = screen.getByTestId(`peer-${LINKED.id}`);
    fireEvent.click(within(linked).getByTestId('peer-delete'));
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    const confirm = await screen.findByRole('alertdialog');
    const buttons = within(confirm).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(
        sent.some((s) => s.method === 'DELETE' && s.path.endsWith(`/peers/${LINKED.id}`)),
      ).toBe(true),
    );
  });

  it("shares an agent, lists a linked hub's agents, asks one and reads the log", async () => {
    const { fetchImpl, sent } = hub();
    mount(PAGE, fetchImpl);
    fireEvent.click(await screen.findByTestId(`peer-share-default-${AGENT_ID}`));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PUT' && s.path.endsWith('/peer-shares'))?.body).toEqual(
        { profile: 'default', agent_id: AGENT_ID, shared: true },
      ),
    );

    const linked = screen.getByTestId(`peer-${LINKED.id}`);
    // A hub still waiting for this owner cannot be asked anything.
    const pending = screen.getByTestId(`peer-${PENDING.id}`);
    expect((within(pending).getByTestId('peer-open-agents') as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(within(linked).getByTestId('peer-open-agents'));
    const agents = await within(linked).findByTestId('peer-agents');
    expect(within(agents).getByTestId('peer-agent').textContent).toContain('Office agent');
    fireEvent.change(within(agents).getByTestId('peer-ask-question'), {
      target: { value: 'When is the meeting?' },
    });
    fireEvent.click(within(agents).getByTestId('peer-ask-send'));
    expect((await within(agents).findByTestId('peer-ask-answer')).textContent).toBe(
      'The meeting is at ten.',
    );
    expect(
      sent.find((s) => s.path.endsWith(`/peers/${LINKED.id}/agents/${SHARE_ID}/ask`))?.body,
    ).toEqual({ prompt: 'When is the meeting?' });

    fireEvent.click(within(linked).getByTestId('peer-open-log'));
    expect((await within(linked).findAllByTestId('peer-log-line')).length).toBe(1);
  });
});
