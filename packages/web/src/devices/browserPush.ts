/**
 * This browser as a device that receives push (DECISIONS §66).
 *
 * Turning notifications on is four steps, all of them the browser's own: ask for the
 * permission, register the service worker (`/push-sw.js`), subscribe with the hub's VAPID
 * key, and hand the subscription to the hub — registering this browser as a device first,
 * under a key it keeps in local storage so it stays one device across visits.
 *
 * The subscription lives only as long as the sign-in that registered it (the hub forgets it
 * when that sign-in ends). The browser keeps its subscription, and remembers whose it is: after
 * that same person signs in again, `resumeBrowserPush` hands it back without asking anything —
 * only while the browser's permission is still granted. Another person signing in to the same
 * browser is not subscribed silently; they turn it on themselves.
 *
 * The browser's objects are passed in (`PushEnvironment`) so the tests can play a browser
 * without one.
 */
import { derived, type HubClient } from '@corehub/contracts';

export type BrowserPushState = 'unsupported' | 'denied' | 'off' | 'on';

export interface PushEnvironment {
  serviceWorker: ServiceWorkerContainer | null;
  notification: {
    permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
  } | null;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  userAgent: string;
}

export function browserEnvironment(): PushEnvironment {
  const supported =
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window;
  let storage: PushEnvironment['storage'];
  try {
    storage = typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some privacy modes throw on the mere read of `localStorage`.
    storage = null;
  }
  return {
    serviceWorker: supported ? navigator.serviceWorker : null,
    notification: supported ? window.Notification : null,
    storage,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  };
}

const KEY = `${derived.storagePrefix}device.key`;
/** The person who turned push on in this browser (their user id). */
const OWNER_KEY = `${derived.storagePrefix}push.user`;
export const SERVICE_WORKER_URL = '/push-sw.js';

function pushOwner(storage: PushEnvironment['storage']): string | null {
  try {
    return storage?.getItem(OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

function setPushOwner(storage: PushEnvironment['storage'], userId: string | null): void {
  try {
    if (userId) storage?.setItem(OWNER_KEY, userId);
    else storage?.removeItem(OWNER_KEY);
  } catch {
    // Without a store the browser simply is not handed back silently.
  }
}

/** The key this browser registered under, if it ever did (reading makes nothing). */
export function knownDeviceKey(storage: PushEnvironment['storage']): string | null {
  try {
    return storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

/** The key this browser registers under, made once and kept. */
export function deviceKey(storage: PushEnvironment['storage']): string {
  const existing = storage?.getItem(KEY);
  if (existing) return existing;
  const made =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    storage?.setItem(KEY, made);
  } catch {
    // A store that refuses gives a new device each visit; better than none.
  }
  return made;
}

/** "Chrome — Linux": what a person recognises in the devices list. */
export function browserName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return os ? `${browser} — ${os}` : browser;
}

/** The VAPID key as the bytes `applicationServerKey` takes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(env: PushEnvironment): Promise<ServiceWorkerRegistration | null> {
  if (!env.serviceWorker) return null;
  return (await env.serviceWorker.getRegistration(SERVICE_WORKER_URL)) ?? null;
}

/**
 * On, off, or impossible here. With `userId`, a subscription another person turned on is
 * "off" for this one: it is not registered for them.
 */
export async function browserPushState(
  env: PushEnvironment,
  userId?: string | null,
): Promise<BrowserPushState> {
  if (!env.serviceWorker || !env.notification) return 'unsupported';
  if (env.notification.permission === 'denied') return 'denied';
  if (env.notification.permission !== 'granted') return 'off';
  const owner = pushOwner(env.storage);
  if (userId && owner && owner !== userId) return 'off';
  const existing = await registration(env);
  const subscription = await existing?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

/** Registers this browser as the person's device; the same key gives the same device. */
export async function registerThisBrowser(client: HubClient, env: PushEnvironment) {
  const { data } = await client.request('post', '/devices', {
    body: {
      device_key: deviceKey(env.storage),
      name: browserName(env.userAgent),
      platform: 'web',
      kind: 'browser',
      capabilities: ['notifications'],
    },
  });
  return data;
}

export class BrowserPushError extends Error {
  constructor(readonly reason: 'unsupported' | 'denied' | 'no_key') {
    super(reason);
    this.name = 'BrowserPushError';
  }
}

/**
 * This browser's subscription with the hub's key, made now if there is none or it was made
 * with another key (the hub's data was replaced). Asks nothing: the permission is granted.
 */
async function subscriptionFor(worker: ServiceWorkerRegistration, publicKey: string) {
  const key = base64UrlToBytes(publicKey);
  const subscription = await worker.pushManager.getSubscription();
  if (subscription) {
    const current = subscription.options?.applicationServerKey;
    const same =
      current &&
      new Uint8Array(current).length === key.length &&
      new Uint8Array(current).every((byte, i) => byte === key[i]);
    if (same) return subscription;
    await subscription.unsubscribe();
  }
  return worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** Registers this browser as a device and hands the hub its subscription. */
async function handToHub(
  client: HubClient,
  env: PushEnvironment,
  subscription: PushSubscription,
  locale: 'ar' | 'en',
): Promise<void> {
  const device = await registerThisBrowser(client, env);
  await client.request('put', '/devices/{device_id}/push', {
    params: { device_id: device.id },
    body: { provider: 'webpush', token: JSON.stringify(subscription.toJSON()), locale },
  });
}

export async function enableBrowserPush(
  client: HubClient,
  env: PushEnvironment,
  options: { publicKey: string | null; locale: 'ar' | 'en'; userId?: string | null },
): Promise<void> {
  if (!env.serviceWorker || !env.notification) throw new BrowserPushError('unsupported');
  if (!options.publicKey) throw new BrowserPushError('no_key');
  const permission =
    env.notification.permission === 'granted'
      ? 'granted'
      : await env.notification.requestPermission();
  if (permission !== 'granted') throw new BrowserPushError('denied');
  const worker =
    (await registration(env)) ??
    (await env.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' }));
  const subscription = await subscriptionFor(worker, options.publicKey);
  await handToHub(client, env, subscription, options.locale);
  if (options.userId) setPushOwner(env.storage, options.userId);
}

export async function disableBrowserPush(client: HubClient, env: PushEnvironment): Promise<void> {
  const worker = await registration(env);
  const subscription = await worker?.pushManager.getSubscription();
  await subscription?.unsubscribe();
  setPushOwner(env.storage, null);
  const device = await registerThisBrowser(client, env);
  await client.request('delete', '/devices/{device_id}/push', {
    params: { device_id: device.id },
  });
}

/** What `resumeBrowserPush` did, for the tests and nothing else. */
export type ResumeOutcome =
  | 'unsupported'
  | 'not_granted'
  | 'not_theirs'
  | 'no_subscription'
  | 'no_key'
  | 'registered'
  | 'failed';

/**
 * Right after a sign-in: the hub forgot this browser's subscription when the previous sign-in
 * ended, so it is handed back — silently, and only when the browser still allows notifications,
 * still holds a subscription, and it was this person who turned push on here. Never asks for a
 * permission and never throws: at worst the person turns it on again from Notifications.
 */
export async function resumeBrowserPush(
  client: HubClient,
  env: PushEnvironment,
  options: { userId: string; locale: 'ar' | 'en' },
): Promise<ResumeOutcome> {
  try {
    if (!env.serviceWorker || !env.notification) return 'unsupported';
    if (env.notification.permission !== 'granted') return 'not_granted';
    if (pushOwner(env.storage) !== options.userId) return 'not_theirs';
    const worker = await registration(env);
    if (!worker || !(await worker.pushManager.getSubscription())) return 'no_subscription';
    const { data } = await client.request('get', '/push/config');
    if (!data.webpush_public_key) return 'no_key';
    const subscription = await subscriptionFor(worker, data.webpush_public_key);
    await handToHub(client, env, subscription, options.locale);
    return 'registered';
  } catch {
    return 'failed';
  }
}
