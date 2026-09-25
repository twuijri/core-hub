// Setting up a push sender from its file (the owner, 2026-09-26): APNs takes the
// AuthKey_<KEY ID>.p8 Apple hands out (the Key ID comes from its name, the bundle id from the
// hub), FCM takes the service-account JSON and says plainly when it was handed the app's
// google-services.json instead. What is stored is named without a secret, and a save says
// whether the key looked valid.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { PushSendersSection } from '../src/devices/PushSendersCard.js';
import {
  ending,
  inspectP8,
  inspectServiceAccount,
  keyIdFromFileName,
} from '../src/devices/senderFiles.js';

afterEach(cleanup);

const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n';
const ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'core-hub-66772',
  client_email: 'push@core-hub-66772.iam.gserviceaccount.com',
  private_key: PEM,
});
const GOOGLE_SERVICES = JSON.stringify({
  project_info: { project_id: 'core-hub-66772', project_number: '1' },
  client: [{ client_info: { android_client_info: { package_name: 'com.twuijri.corehub' } } }],
});

describe('reading a sender file', () => {
  it('knows a service account, the app file, and what is missing', () => {
    expect(inspectServiceAccount(ACCOUNT)).toEqual({
      ok: true,
      projectId: 'core-hub-66772',
      clientEmail: 'push@core-hub-66772.iam.gserviceaccount.com',
    });
    expect(inspectServiceAccount(GOOGLE_SERVICES)).toEqual({
      ok: false,
      reason: 'google_services',
    });
    expect(inspectServiceAccount('{')).toEqual({ ok: false, reason: 'not_json' });
    expect(inspectServiceAccount('[]')).toEqual({ ok: false, reason: 'not_json' });
    expect(inspectServiceAccount('{"type":"authorized_user"}')).toEqual({
      ok: false,
      reason: 'not_service_account',
    });
    expect(inspectServiceAccount('{"type":"service_account","project_id":"p"}')).toEqual({
      ok: false,
      reason: 'missing',
      fields: ['client_email', 'private_key'],
    });
  });

  it('takes the Key ID from the file name Apple gives the key', () => {
    expect(keyIdFromFileName('AuthKey_ABC123DEFG.p8')).toBe('ABC123DEFG');
    expect(keyIdFromFileName('AuthKey_abc123defg (1).p8')).toBe('ABC123DEFG');
    expect(keyIdFromFileName('key.p8')).toBeNull();
    expect(keyIdFromFileName('AuthKey_SHORT.p8')).toBeNull();
    expect(inspectP8('AuthKey_ABC123DEFG.p8', PEM)).toEqual({ ok: true, keyId: 'ABC123DEFG' });
    expect(inspectP8(null, PEM)).toEqual({ ok: true, keyId: null });
    expect(inspectP8('AuthKey_ABC123DEFG.p8', 'hello')).toEqual({ ok: false, reason: 'not_a_key' });
    expect(inspectP8('google-services.json', GOOGLE_SERVICES)).toEqual({
      ok: false,
      reason: 'not_p8',
    });
    expect(ending('ABC123DEFG')).toBe('DEFG');
  });
});

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

const sender = (over: Record<string, unknown>) => ({
  state: 'not_configured',
  source: 'none',
  missing: [],
  details: {},
  devices: 0,
  last_error: null,
  last_sent_at: null,
  ...over,
});

function fakeHub(saved: Record<string, unknown> = {}) {
  const sent: Array<{ path: string; method: string; body: unknown }> = [];
  const items = [
    sender({ provider: 'webpush', state: 'ready', source: 'generated' }),
    sender({ provider: 'fcm', missing: ['service_account'] }),
    sender({
      provider: 'apns',
      missing: ['key_id', 'team_id', 'private_key'],
      details: { bundle_id: 'com.twuijri.corehub', environment: 'production' },
    }),
  ];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ path, method, body });
    const reply = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path === '/push/senders') return reply({ items });
    if (path.startsWith('/push/senders/') && method === 'PUT') {
      const provider = path.split('/').pop();
      return reply(sender({ provider, state: 'ready', source: 'settings', ...saved }));
    }
    return reply({});
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(fetchImpl: typeof fetch) {
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
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <PushSendersSection open onOpenChange={() => undefined} />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('the sender dialogs', () => {
  it('sets APNs up from the .p8: Key ID from its name, bundle id from the hub', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = fakeHub({
      details: { key_id: 'ABC123DEFG', team_id: '58QWJ228ZE', private_key: '[stored]' },
    });
    mount(fetchImpl);
    await user.click(await screen.findByTestId('push-sender-edit-apns'));
    const dialog = await screen.findByTestId('push-sender-dialog');
    expect((within(dialog).getByTestId('push-sender-bundle_id') as HTMLInputElement).value).toBe(
      'com.twuijri.corehub',
    );
    expect(
      within(dialog).getByRole('radio', { name: 'Production' }).getAttribute('aria-checked'),
    ).toBe('true');

    // The wrong file first, dropped on the zone (a drop is not filtered by the picker's
    // `accept`): said plainly, nothing filled in.
    fireEvent.drop(within(dialog).getByTestId('push-sender-file-drop'), {
      dataTransfer: {
        files: [new File([GOOGLE_SERVICES], 'google-services.json', { type: 'application/json' })],
      },
    });
    expect((await within(dialog).findByTestId('push-sender-file-problem')).textContent).toContain(
      'not the .p8 file',
    );
    expect(within(dialog).getByTestId('push-sender-save').hasAttribute('disabled')).toBe(true);

    await user.upload(
      within(dialog).getByTestId('push-sender-file'),
      new File([PEM], 'AuthKey_ABC123DEFG.p8'),
    );
    await waitFor(() =>
      expect((within(dialog).getByTestId('push-sender-key_id') as HTMLInputElement).value).toBe(
        'ABC123DEFG',
      ),
    );
    expect(within(dialog).queryByTestId('push-sender-file-problem')).toBeNull();
    await user.type(within(dialog).getByTestId('push-sender-team_id'), '58QWJ228ZE');
    await user.click(within(dialog).getByTestId('push-sender-save'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({
        enabled: true,
        key_id: 'ABC123DEFG',
        team_id: '58QWJ228ZE',
        bundle_id: 'com.twuijri.corehub',
        environment: 'production',
        private_key: PEM.trim(),
      }),
    );
    expect((await screen.findByTestId('push-sender-saved')).textContent).toContain(
      'The key looks valid',
    );
  });

  it('refuses google-services.json for FCM, and names the project of the right file', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = fakeHub();
    mount(fetchImpl);
    await user.click(await screen.findByTestId('push-sender-edit-fcm'));
    const dialog = await screen.findByTestId('push-sender-dialog');
    await user.upload(
      within(dialog).getByTestId('push-sender-file'),
      new File([GOOGLE_SERVICES], 'google-services.json', { type: 'application/json' }),
    );
    expect((await within(dialog).findByTestId('push-sender-file-problem')).textContent).toContain(
      "google-services.json, the Android app's own file",
    );
    expect(within(dialog).getByTestId('push-sender-save').hasAttribute('disabled')).toBe(true);

    await user.upload(
      within(dialog).getByTestId('push-sender-file'),
      new File([ACCOUNT], 'core-hub-66772-firebase-adminsdk.json', { type: 'application/json' }),
    );
    expect((await within(dialog).findByTestId('push-sender-file-ok')).textContent).toBe(
      'Service account for project core-hub-66772.',
    );
    await user.click(within(dialog).getByTestId('push-sender-save'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({
        enabled: true,
        service_account: ACCOUNT,
      }),
    );
  });

  it('names what is stored without a secret', async () => {
    const { fetchImpl } = fakeHub();
    const stored = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/push/senders'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                sender({
                  provider: 'fcm',
                  state: 'ready',
                  source: 'settings',
                  details: {
                    project_id: 'core-hub-66772',
                    client_email: 'push@x',
                    service_account: '[stored]',
                  },
                }),
                sender({
                  provider: 'apns',
                  state: 'ready',
                  source: 'settings',
                  details: {
                    key_id: 'ABC123DEFG',
                    team_id: '58QWJ228ZE',
                    bundle_id: 'com.twuijri.corehub',
                    environment: 'production',
                    private_key: '[stored]',
                  },
                }),
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    mount(stored);
    expect((await screen.findByTestId('push-sender-stored-fcm')).textContent).toBe(
      'Saved — project core-hub-66772',
    );
    const apns = screen.getByTestId('push-sender-stored-apns').textContent ?? '';
    expect(apns).toBe('Saved — key ending …DEFG · team 58QWJ228ZE');
    expect(screen.getByTestId('push-senders').textContent).not.toContain('[stored]');
  });
});
