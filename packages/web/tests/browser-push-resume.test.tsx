// A browser's Web Push lives as long as the sign-in that registered it (the hub forgets it when
// that sign-in ends). After the same person signs in again, the web hands the subscription back
// silently — only with the permission still granted and a subscription still held — and never
// for another person signing in to the same browser.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubClient } from '@corehub/contracts';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore, type StoredSession } from '../src/auth/store.js';
import { I18nProvider } from '../src/i18n/context.js';
import { BrowserPushResume } from '../src/devices/BrowserPushResume.js';
import {
  browserPushState,
  disableBrowserPush,
  enableBrowserPush,
  resumeBrowserPush,
  type PushEnvironment,
} from '../src/devices/browserPush.js';

const KEY =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

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

const json = (value: unknown, status = 200) =>
  Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** The hub, played: the push config, the browser's device row, and its push registration. */
function hub(publicKey: string | null = KEY) {
  const sent: string[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    sent.push(`${method} ${path}`);
    if (path === '/push/config')
      return json({ webpush_public_key: publicKey, providers: publicKey ? ['webpush'] : [] });
    if (path === '/devices' && method === 'POST') return json({ id: 'browser-id' }, 201);
    if (path === '/devices/browser-id/push' && method === 'PUT')
      return json({ provider: 'webpush', locale: 'ar', registered_at: '2026-09-27T09:00:00Z' });
    if (path === '/devices/browser-id/push' && method === 'DELETE') return json(null, 204);
    return json({ error: 'not found', code: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    sent,
    client: createHubClient({ baseUrl: 'http://hub.test', fetch: fetchImpl }),
  };
}

/** A browser, played: its permission, a service worker registry and a push manager. */
function browser(permission: NotificationPermission = 'granted') {
  const calls: string[] = [];
  let subscription: Record<string, unknown> | null = null;
  const pushManager = {
    getSubscription: async () => subscription,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      calls.push('subscribe');
      subscription = {
        options,
        unsubscribe: async () => {
          subscription = null;
          return true;
        },
        toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      };
      return subscription;
    },
  };
  let registered = false;
  const notification = {
    permission,
    requestPermission: async () => {
      calls.push('permission');
      return notification.permission;
    },
  };
  const env: PushEnvironment = {
    serviceWorker: {
      getRegistration: async () => (registered ? { pushManager } : undefined),
      register: async () => {
        registered = true;
        return { pushManager };
      },
    } as unknown as ServiceWorkerContainer,
    notification,
    storage: memoryStorage(),
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36',
  };
  return { env, calls, notification };
}

afterEach(cleanup);

describe('resumeBrowserPush', () => {
  it('hands the subscription back after the same person signs in, asking nothing', async () => {
    const { env, calls } = browser();
    const first = hub();
    await enableBrowserPush(first.client, env, { publicKey: KEY, locale: 'ar', userId: 'u1' });
    expect(calls).toEqual(['subscribe']);

    // Signed out and in again: the hub forgot the registration with the old sign-in.
    const again = hub();
    expect(await resumeBrowserPush(again.client, env, { userId: 'u1', locale: 'en' })).toBe(
      'registered',
    );
    expect(again.sent).toEqual([
      'GET /push/config',
      'POST /devices',
      'PUT /devices/browser-id/push',
    ]);
    // The same subscription: no prompt, no new subscribe.
    expect(calls).toEqual(['subscribe']);
  });

  it('does nothing for another person, without the permission, or with no subscription', async () => {
    const { env, notification } = browser();
    const first = hub();
    await enableBrowserPush(first.client, env, { publicKey: KEY, locale: 'ar', userId: 'u1' });

    const other = hub();
    expect(await resumeBrowserPush(other.client, env, { userId: 'u2', locale: 'ar' })).toBe(
      'not_theirs',
    );
    expect(await browserPushState(env, 'u2')).toBe('off');
    expect(await browserPushState(env, 'u1')).toBe('on');

    notification.permission = 'denied';
    expect(await resumeBrowserPush(other.client, env, { userId: 'u1', locale: 'ar' })).toBe(
      'not_granted',
    );
    notification.permission = 'granted';
    expect(other.sent).toEqual([]);

    // Turned off: the browser holds nothing and remembers nobody.
    await disableBrowserPush(first.client, env);
    expect(await resumeBrowserPush(other.client, env, { userId: 'u1', locale: 'ar' })).toBe(
      'not_theirs',
    );

    const unsupported = { ...browser().env, serviceWorker: null };
    expect(await resumeBrowserPush(other.client, unsupported, { userId: 'u1', locale: 'ar' })).toBe(
      'unsupported',
    );
    expect(other.sent).toEqual([]);
  });

  it('subscribes again with a new hub key, and never throws', async () => {
    const { env, calls } = browser();
    await enableBrowserPush(hub().client, env, { publicKey: KEY, locale: 'ar', userId: 'u1' });
    const replaced = hub('BAAB');
    expect(await resumeBrowserPush(replaced.client, env, { userId: 'u1', locale: 'ar' })).toBe(
      'registered',
    );
    expect(calls).toEqual(['subscribe', 'subscribe']);

    const noKey = hub(null);
    expect(await resumeBrowserPush(noKey.client, env, { userId: 'u1', locale: 'ar' })).toBe(
      'no_key',
    );
    const down = createHubClient({
      baseUrl: 'http://hub.test',
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    expect(await resumeBrowserPush(down, env, { userId: 'u1', locale: 'ar' })).toBe('failed');
  });
});

describe('BrowserPushResume', () => {
  const session = (id: string): StoredSession => ({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id, username: 'admin', display_name: 'Admin', role: 'owner' },
  });

  function mount(store: SessionStore, fetchImpl: typeof fetch, env: PushEnvironment) {
    return render(
      <I18nProvider language="en">
        <QueryClientProvider client={new QueryClient()}>
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <BrowserPushResume environment={env} />
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it('hands the subscription back on a sign-in, not on a page already signed in', async () => {
    const { env } = browser();
    await enableBrowserPush(hub().client, env, { publicKey: KEY, locale: 'ar', userId: 'u1' });

    // A page loaded while signed in: its registration stands, nothing is sent.
    const loaded = new SessionStore(memoryStorage());
    loaded.save(session('u1'));
    const quiet = hub();
    mount(loaded, quiet.fetchImpl, env);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quiet.sent).toEqual([]);
    cleanup();

    // Signed out, then signed in on this page.
    const store = new SessionStore(memoryStorage());
    const live = hub();
    mount(store, live.fetchImpl, env);
    expect(live.sent).toEqual([]);
    act(() => store.save(session('u1')));
    await waitFor(() => expect(live.sent).toContain('PUT /devices/browser-id/push'));
  });
});
