// The last two Settings pages: Webhooks (admin, `notify`) and Privacy (`auth`). What is
// worth testing in each is that it says what the hub does and nothing more — a secret is on
// screen once, a refusal is in words, a test shows what the endpoint answered, and Privacy
// offers no switch the hub would ignore.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { WebhooksTab } from '../src/notify/WebhooksTab.js';
import { canRedeliver, clampRetries, newSigningSecret } from '../src/notify/webhooks.js';
import { PrivacyTab } from '../src/settings/PrivacyTab.js';

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

const HOOK_ID = '01J8QK3ZR2W7M5N4P6T8V9X0WH';
const JOB_ID = '01J8QK3ZR2W7M5N4P6T8V9X0K5';

function webhook(over: Record<string, unknown> = {}) {
  return {
    id: HOOK_ID,
    name: 'n8n',
    url: 'https://n8n.example/webhook/corehub',
    events: ['run.completed'],
    profiles: [],
    enabled: true,
    secret: '[stored]',
    include_content: false,
    allow_private_network: false,
    max_retries: 3,
    stats: { delivered: 0, failed: 0, last_delivery_at: null, last_error: null },
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    ...over,
  };
}

function token(over: Record<string, unknown> = {}) {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
    name: 'Tariq’s phone',
    scopes: ['read', 'write', 'device'],
    device_id: '01J8QK3ZR2W7M5N4P6T8V9X0DV',
    last_used_at: '2026-09-21T10:00:00Z',
    expires_at: null,
    created_at: '2026-09-21T10:00:00Z',
    ...over,
  };
}

interface State {
  hooks: Array<ReturnType<typeof webhook>>;
  deliveries: unknown[];
  tokens: Array<ReturnType<typeof token>>;
  /** What `POST /notify/webhooks` answers instead of creating, e.g. a refused address. */
  refuse?: { status: number; body: unknown };
  job?: Record<string, unknown>;
}

function hub(initial: Partial<State> = {}) {
  const state: State = { hooks: [], deliveries: [], tokens: [], ...initial };
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
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
    if (path.endsWith('/notify/webhook-events'))
      return json({
        items: [
          {
            name: 'run.completed',
            description: { ar: 'انتهى تشغيل وكيل', en: 'An agent run finished' },
          },
          { name: 'task.moved', description: { ar: 'انتقلت مهمة', en: 'A task changed column' } },
          {
            name: 'notice.created',
            description: { ar: 'وصل إشعار', en: 'A notification was created' },
          },
        ],
      });
    if (path.endsWith('/profiles'))
      return json({
        items: [
          { slug: 'default', name: 'Default' },
          { slug: 'work', name: 'Work' },
        ],
      });
    if (path.endsWith('/redeliver') && method === 'POST')
      return json(
        {
          id: '01J8QK3ZR2W7M5N4P6T8V9X0WR',
          webhook_id: HOOK_ID,
          event: 'run.completed',
          status: 'queued',
          attempts: 0,
          response_status: null,
          error: null,
          created_at: '2026-09-25T10:00:00Z',
          delivered_at: null,
          next_attempt_at: '2026-09-25T10:00:00Z',
        },
        202,
      );
    if (path.endsWith('/notify/webhooks') && method === 'POST') {
      if (state.refuse) return json(state.refuse.body, state.refuse.status);
      const created = webhook({
        id: '01J8QK3ZR2W7M5N4P6T8V9X0WN',
        name: body?.name,
        url: body?.url,
        events: body?.events ?? [],
        secret: body?.secret ? '[stored]' : null,
      });
      state.hooks = [created, ...state.hooks];
      return json(created, 201);
    }
    if (path.endsWith('/notify/webhooks')) return json({ items: state.hooks });
    if (path.endsWith('/deliveries')) return json({ items: state.deliveries });
    if (path.endsWith('/test')) return json({ job_id: JOB_ID }, 202);
    if (path.includes('/notify/webhooks/') && method === 'PATCH') {
      state.hooks = state.hooks.map((h) =>
        h.id === path.split('/').pop()
          ? {
              ...h,
              ...body,
              secret:
                body && 'secret' in body ? (body.secret ? '[stored]' : null) : (h.secret ?? null),
            }
          : h,
      ) as State['hooks'];
      return json(state.hooks[0]);
    }
    if (path.includes('/notify/webhooks/') && method === 'DELETE') {
      state.hooks = state.hooks.filter((h) => h.id !== path.split('/').pop());
      return json(null, 204);
    }
    if (path.includes('/jobs/'))
      return json(
        state.job ?? {
          id: JOB_ID,
          profile: 'default',
          owner_id: 'u',
          created_at: '2026-09-24T10:00:00Z',
          updated_at: '2026-09-24T10:00:01Z',
          kind: 'notify.webhook_test',
          status: 'succeeded',
          progress: { percent: 100, message: null },
          resource: { kind: 'webhook', id: HOOK_ID },
          result: { delivered: true, status: 200, error: null },
          error: null,
          started_at: '2026-09-24T10:00:00Z',
          finished_at: '2026-09-24T10:00:01Z',
        },
      );
    if (path.endsWith('/auth/app-tokens')) return json({ items: state.tokens });
    if (path.includes('/auth/app-tokens/') && method === 'DELETE') {
      state.tokens = state.tokens.filter((t) => t.id !== path.split('/').pop());
      return json(null, 204);
    }
    return json({ error: path, code: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, state };
}

function mount(node: React.ReactElement, fetchImpl: typeof fetch, language: 'en' | 'ar' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>{node}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('Webhooks', () => {
  it('says an empty list is empty, and how events are sent', async () => {
    const { fetchImpl } = hub();
    mount(<WebhooksTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('webhooks-empty')).toBeTruthy());
    // Events are forwarded now (decision §52), with retries: the page says what happens.
    const note = screen.getByTestId('webhooks-forwarding-note').textContent;
    expect(note).toContain('as it happens');
    expect(note).not.toContain('only the test delivery');
  });

  it('makes the signing secret here, sends it once, and shows it once', async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('add-webhook'));
    const dialog = await screen.findByTestId('webhook-dialog');
    await user.type(within(dialog).getByTestId('webhook-name'), 'CI');
    await user.type(within(dialog).getByTestId('webhook-url-input'), 'https://ci.example/hook');
    // Each event reads as a sentence, with its name beside it.
    await user.click(
      await within(dialog).findByRole('checkbox', { name: /A task changed column/ }),
    );
    await user.click(within(dialog).getByTestId('save-webhook'));

    const secretDialog = await screen.findByTestId('webhook-secret-dialog');
    const shown = (within(secretDialog).getByTestId('webhook-secret-value') as HTMLInputElement)
      .value;
    expect(shown).toMatch(/^whsec_[0-9a-f]{64}$/);

    const post = sent.find((s) => s.method === 'POST' && s.path.endsWith('/notify/webhooks'));
    expect(post?.body).toMatchObject({
      name: 'CI',
      url: 'https://ci.example/hook',
      events: ['task.moved'],
      // Every profile, no message text, five retries: the defaults a new webhook starts with.
      profiles: [],
      include_content: false,
      max_retries: 5,
      enabled: true,
      allow_private_network: false,
      secret: shown,
    });

    // Once: closing it is the last time the value is anywhere on the page.
    await user.click(within(secretDialog).getByTestId('webhook-secret-done'));
    await waitFor(() => expect(screen.queryByTestId('webhook-secret-dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(shown);
    expect(await screen.findByText('Signed')).toBeTruthy();
  });

  it('leaves the stored secret alone when an edit keeps it', async () => {
    const { fetchImpl, sent } = hub({ hooks: [webhook()] });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('webhook-edit'));
    const dialog = await screen.findByTestId('webhook-dialog');
    const name = within(dialog).getByTestId('webhook-name');
    await user.clear(name);
    await user.type(name, 'n8n prod');
    await user.click(within(dialog).getByTestId('save-webhook'));
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true));
    const patch = sent.find((s) => s.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ name: 'n8n prod' });
    // Not sent at all: `[stored]` must never be echoed back as if it were the value.
    expect(patch.body).not.toHaveProperty('secret');
    expect(screen.queryByTestId('webhook-secret-dialog')).toBeNull();
  });

  it('stops signing when asked, by sending null', async () => {
    const { fetchImpl, sent } = hub({ hooks: [webhook()] });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('webhook-edit'));
    const dialog = await screen.findByTestId('webhook-dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Stop signing' }));
    await user.click(within(dialog).getByTestId('save-webhook'));
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true));
    expect(sent.find((s) => s.method === 'PATCH')!.body).toMatchObject({ secret: null });
  });

  it('says why the hub refused an address, beside the address', async () => {
    const { fetchImpl } = hub({
      refuse: {
        status: 400,
        body: {
          error: 'The request could not be understood.',
          code: 'bad_request',
          details: { reason: 'url_private', detail: '10.0.0.5' },
        },
      },
    });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('add-webhook'));
    const dialog = await screen.findByTestId('webhook-dialog');
    await user.type(within(dialog).getByTestId('webhook-name'), 'inside');
    await user.type(within(dialog).getByTestId('webhook-url-input'), 'https://inside.example/h');
    await user.click(within(dialog).getByTestId('save-webhook'));
    expect(await within(dialog).findByText(/points inside a private network/)).toBeTruthy();
    // Nothing was stored, so nothing was shown as a secret either.
    expect(screen.queryByTestId('webhook-secret-dialog')).toBeNull();
  });

  it('refuses an address that is not http(s) before asking the hub', async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('add-webhook'));
    const dialog = await screen.findByTestId('webhook-dialog');
    await user.type(within(dialog).getByTestId('webhook-name'), 'x');
    await user.type(within(dialog).getByTestId('webhook-url-input'), 'ftp://files.example');
    expect(within(dialog).getByText(/starts with http:\/\/ or https:\/\//)).toBeTruthy();
    expect((within(dialog).getByTestId('save-webhook') as HTMLButtonElement).disabled).toBe(true);
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });

  it('sends a test and shows what the endpoint answered, then the delivery', async () => {
    const { fetchImpl, sent, state } = hub({ hooks: [webhook()] });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('webhook-test'));
    state.deliveries = [
      {
        id: '01J8QK3ZR2W7M5N4P6T8V9X0WD',
        webhook_id: HOOK_ID,
        event: 'webhook.test',
        status: 'delivered',
        attempts: 1,
        response_status: 200,
        error: null,
        created_at: '2026-09-24T10:00:00Z',
        delivered_at: '2026-09-24T10:00:01Z',
        next_attempt_at: null,
      },
    ];
    expect((await screen.findByTestId('webhook-test-outcome')).textContent).toBe(
      'Delivered — the endpoint answered 200.',
    );
    expect(sent.some((s) => s.method === 'POST' && s.path.endsWith(`/${HOOK_ID}/test`))).toBe(true);
    expect(sent.some((s) => s.path.endsWith(`/jobs/${JOB_ID}`))).toBe(true);

    await user.click(screen.getByTestId('webhook-deliveries-toggle'));
    const table = await screen.findByTestId('webhook-deliveries');
    expect(within(table).getByText('webhook.test')).toBeTruthy();
    expect(within(table).getByText('Delivered')).toBeTruthy();
    expect(within(table).getByText('200')).toBeTruthy();
  });

  it('says a failed test failed, in the endpoint’s terms', async () => {
    const { fetchImpl } = hub({
      hooks: [webhook()],
      job: {
        id: JOB_ID,
        status: 'succeeded',
        result: { delivered: false, status: 500, error: 'the endpoint answered 500' },
        error: null,
      },
    });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('webhook-test'));
    expect((await screen.findByTestId('webhook-test-outcome')).textContent).toBe(
      'Not delivered — the endpoint answered 500.',
    );
  });

  it('turns a webhook off and deletes one only after asking', async () => {
    const { fetchImpl, sent } = hub({ hooks: [webhook()] });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByRole('switch', { name: 'Enabled' }));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH')?.body).toEqual({ enabled: false }),
    );

    await user.click(screen.getByTestId('webhook-delete'));
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('webhooks-empty')).toBeTruthy());
  });

  it('renders in Arabic', async () => {
    const { fetchImpl } = hub({ hooks: [webhook()] });
    mount(<WebhooksTab />, fetchImpl, 'ar');
    expect(await screen.findByText('إرسال تجريبي')).toBeTruthy();
    expect(screen.getByText('موقَّع')).toBeTruthy();
  });
});

describe('Webhooks: which profiles, what content, how many retries', () => {
  it('sends the profiles chosen, the content switch and the retries', async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('add-webhook'));
    const dialog = await screen.findByTestId('webhook-dialog');
    await user.type(within(dialog).getByTestId('webhook-name'), 'Work only');
    await user.type(within(dialog).getByTestId('webhook-url-input'), 'https://ci.example/hook');
    await user.click(within(dialog).getByRole('radio', { name: 'Only these profiles' }));
    // None chosen yet: nothing to save.
    expect(within(dialog).getByText('Choose at least one profile.')).toBeTruthy();
    expect((within(dialog).getByTestId('save-webhook') as HTMLButtonElement).disabled).toBe(true);
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Work' }));
    await user.click(within(dialog).getByRole('switch', { name: /Include message text/ }));
    const retries = within(dialog).getByTestId('webhook-max-retries');
    await user.clear(retries);
    await user.type(retries, '2');
    await user.click(within(dialog).getByTestId('save-webhook'));
    await waitFor(() =>
      expect(sent.some((s) => s.method === 'POST' && s.path.endsWith('/notify/webhooks'))).toBe(
        true,
      ),
    );
    const post = sent.find((s) => s.method === 'POST' && s.path.endsWith('/notify/webhooks'))!;
    expect(post.body).toMatchObject({ profiles: ['work'], include_content: true, max_retries: 2 });
  });

  it('shows what an existing webhook listens to, and drops an event the hub no longer has', async () => {
    const { fetchImpl, sent } = hub({
      hooks: [
        webhook({
          profiles: ['work'],
          include_content: true,
          events: ['run.completed', 'message.delta'],
        }),
      ],
    });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    expect((await screen.findByTestId('webhook-profiles')).textContent).toBe('Profiles: 1');
    expect(screen.getByTestId('webhook-content').textContent).toBe('Includes message text');
    await user.click(screen.getByTestId('webhook-edit'));
    const dialog = await screen.findByTestId('webhook-dialog');
    const isOn = (el: HTMLElement) =>
      (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true';
    expect(isOn(within(dialog).getByRole('radio', { name: 'Only these profiles' }))).toBe(true);
    expect(isOn(await within(dialog).findByRole('checkbox', { name: 'Work' }))).toBe(true);
    await within(dialog).findByRole('checkbox', { name: /An agent run finished/ });
    await user.click(within(dialog).getByTestId('save-webhook'));
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true));
    expect(sent.find((s) => s.method === 'PATCH')!.body).toMatchObject({
      events: ['run.completed'],
      profiles: ['work'],
      include_content: true,
      max_retries: 3,
    });
  });

  it('lists each delivery’s attempts, answer and next try, and redelivers a failed one', async () => {
    const delivery = (over: Record<string, unknown>) => ({
      webhook_id: HOOK_ID,
      event: 'run.completed',
      error: null,
      created_at: '2026-09-25T10:00:00Z',
      delivered_at: null,
      next_attempt_at: null,
      ...over,
    });
    const { fetchImpl, sent } = hub({
      hooks: [webhook()],
      deliveries: [
        delivery({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0W1',
          status: 'failed',
          attempts: 2,
          response_status: 502,
          error: 'the endpoint answered 502',
          next_attempt_at: '2026-09-25T10:05:00Z',
        }),
        delivery({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0W2',
          event: 'task.moved',
          status: 'dead',
          attempts: 6,
          response_status: 500,
          error: 'the endpoint answered 500',
        }),
        delivery({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0W3',
          status: 'delivered',
          attempts: 1,
          response_status: 200,
          delivered_at: '2026-09-25T10:00:01Z',
        }),
      ],
    });
    const user = userEvent.setup();
    mount(<WebhooksTab />, fetchImpl);
    await user.click(await screen.findByTestId('webhook-deliveries-toggle'));
    const table = await screen.findByTestId('webhook-deliveries');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    // Still retrying: its next try is shown, and there is nothing to redeliver yet.
    expect(within(rows[0]!).getByText('Failed')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('delivery-attempts').textContent).toBe('2');
    expect(within(rows[0]!).getByTestId('delivery-code').textContent).toBe('502');
    expect(within(rows[0]!).getByTestId('delivery-next')).toBeTruthy();
    expect(within(rows[0]!).queryByTestId('delivery-redeliver')).toBeNull();
    // Given up: redeliverable.
    expect(within(rows[1]!).getByText('Gave up')).toBeTruthy();
    expect(within(rows[1]!).getByText('task.moved')).toBeTruthy();
    expect(within(rows[1]!).getByTestId('delivery-attempts').textContent).toBe('6');
    expect(within(rows[2]!).queryByTestId('delivery-redeliver')).toBeNull();
    await user.click(within(rows[1]!).getByTestId('delivery-redeliver'));
    expect((await screen.findByTestId('delivery-requeued')).textContent).toContain('Queued again');
    expect(
      sent.some(
        (s) =>
          s.method === 'POST' &&
          s.path.endsWith(`/${HOOK_ID}/deliveries/01J8QK3ZR2W7M5N4P6T8V9X0W2/redeliver`),
      ),
    ).toBe(true);
  });
});

describe('canRedeliver and clampRetries', () => {
  const base = {
    id: 'd',
    webhook_id: 'w',
    event: 'run.completed',
    attempts: 1,
    response_status: null,
    error: null,
    created_at: '',
    delivered_at: null,
  };
  it('offers a redelivery only for one that is over and did not arrive', () => {
    expect(canRedeliver({ ...base, status: 'dead', next_attempt_at: null })).toBe(true);
    expect(canRedeliver({ ...base, status: 'failed', next_attempt_at: null })).toBe(true);
    expect(
      canRedeliver({ ...base, status: 'failed', next_attempt_at: '2026-09-25T10:00:00Z' }),
    ).toBe(false);
    expect(canRedeliver({ ...base, status: 'delivered', next_attempt_at: null })).toBe(false);
    expect(
      canRedeliver({ ...base, status: 'queued', next_attempt_at: '2026-09-25T10:00:00Z' }),
    ).toBe(false);
  });
  it('keeps retries within the contract’s 0–10', () => {
    expect(clampRetries(-3)).toBe(0);
    expect(clampRetries(42)).toBe(10);
    expect(clampRetries(2.6)).toBe(3);
    expect(clampRetries(Number.NaN)).toBe(5);
  });
});

describe('newSigningSecret', () => {
  it('is 32 random bytes in hex behind a prefix that says what it is', () => {
    const fixed = newSigningSecret((bytes) => bytes.fill(0xab));
    expect(fixed).toBe(`whsec_${'ab'.repeat(32)}`);
    expect(newSigningSecret()).not.toBe(newSigningSecret());
  });
});

describe('Privacy', () => {
  it('lists what holds a token to the account, and revokes one after asking', async () => {
    const { fetchImpl, sent } = hub({
      tokens: [
        token(),
        token({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0AL',
          name: 'backup script',
          device_id: null,
          last_used_at: null,
        }),
      ],
    });
    const user = userEvent.setup();
    mount(<PrivacyTab />, fetchImpl);
    const table = await screen.findByTestId('app-token-table');
    expect(within(table).getByText('Tariq’s phone')).toBeTruthy();
    expect(within(table).getByText('Paired device')).toBeTruthy();
    expect(within(table).getByText('backup script')).toBeTruthy();
    expect(within(table).getByText('App token')).toBeTruthy();

    await user.click(within(table).getAllByTestId('revoke-token')[0]!);
    // Asked first, and a device is told it will be unlinked.
    expect(await screen.findByText(/pairing it again gives it a new token/)).toBeTruthy();
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    await user.click(screen.getByTestId('confirm-yes'));
    await waitFor(() =>
      expect(
        sent.some(
          (s) =>
            s.method === 'DELETE' && s.path.endsWith('/auth/app-tokens/01J8QK3ZR2W7M5N4P6T8V9X0AK'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Tariq’s phone')).toBeNull());
  });

  it('says so when nothing but your own sign-ins can reach the account', async () => {
    const { fetchImpl } = hub();
    mount(<PrivacyTab />, fetchImpl);
    expect(await screen.findByTestId('app-tokens-empty')).toBeTruthy();
  });

  it('offers no switch the hub would ignore', async () => {
    // `privacy.redact_pii` is stored by the hub and read by nothing, so it is not here.
    const { fetchImpl, sent } = hub({ tokens: [token()] });
    mount(<PrivacyTab />, fetchImpl);
    await screen.findByTestId('app-token-table');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(sent.some((s) => s.path.includes('/settings'))).toBe(false);
  });
});
