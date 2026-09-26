/**
 * What a device card says, worked out from the contract's `Device` without React: how long
 * ago it was active, which operating system it runs, and where its push stands. Kept pure so
 * the rules are tested on their own (tests/device-card.test.tsx).
 */
import type { components } from '@corehub/contracts';
import { intlLocale } from '../i18n/index.js';

type Device = components['schemas']['Device'];
type PushProvider = components['schemas']['PushProvider'];

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * "5 minutes ago" / «قبل 5 دقائق»: the largest whole unit, and "now" under a minute. A time a
 * little in the future (a clock ahead of the hub's) reads as now, not as "in 3 seconds".
 */
export function relativeTime(iso: string, now: number, language: string): string {
  const format = new Intl.RelativeTimeFormat(intlLocale(language), { numeric: 'auto' });
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return format.format(0, 'second');
}

/** The exact time, for the tooltip beside a relative one. */
export function exactTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function shortDate(iso: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), { dateStyle: 'medium' }).format(
    new Date(iso),
  );
}

/** The i18n key of the operating system's name: an iPad runs iPadOS, not iOS. */
export function osKey(device: Pick<Device, 'platform' | 'kind'>): string | null {
  if (device.platform === 'web') return null;
  if (device.platform === 'ios' && device.kind === 'tablet') return 'devices.os.ipados';
  return `devices.os.${device.platform}`;
}

/** The push service a device of this platform would use. */
export function senderOf(device: Pick<Device, 'platform'>): PushProvider {
  if (device.platform === 'android') return 'fcm';
  if (device.platform === 'ios') return 'apns';
  return 'webpush';
}

export type PushView =
  | { state: 'on'; provider: PushProvider }
  | { state: 'not_in_build' }
  | { state: 'permission_pending' }
  | { state: 'permission_denied' }
  /** Nothing on the device stops it, but the hub has no sender for its kind. */
  | { state: 'no_sender'; provider: PushProvider }
  | { state: 'off' };

/**
 * Where push stands for one device. The hub's registration wins (it is what delivers); then
 * what the device says stops it; then whether the hub can send to its kind at all. `ready` is
 * the hub's senders that can deliver now (`devices.getPushConfig`), or null while unknown.
 */
export function pushView(
  device: Pick<Device, 'platform' | 'push' | 'push_blocker'>,
  ready: readonly PushProvider[] | null,
): PushView {
  if (device.push) return { state: 'on', provider: device.push.provider };
  const blocker = device.push_blocker ?? null;
  if (blocker && blocker !== 'none') return { state: blocker };
  const provider = senderOf(device);
  if (ready && !ready.includes(provider)) return { state: 'no_sender', provider };
  return { state: 'off' };
}

export type DeviceGroup = 'mobile' | 'computer' | 'browser';

/** Phones and tablets, computers (the desktop app), browsers: the page's three groups. */
export function groupOf(device: Pick<Device, 'kind'>): DeviceGroup {
  if (device.kind === 'phone' || device.kind === 'tablet') return 'mobile';
  return device.kind;
}

/**
 * The line under a device's name: its model, and the maker only when the model does not
 * already say it ("Pixel 9" · Google; "iPhone 16 Pro" alone). Null when the device never said.
 */
export function modelLine(device: Pick<Device, 'brand' | 'model'>): string | null {
  const model = device.model?.trim() || null;
  const brand = device.brand?.trim() || null;
  if (!model) return brand;
  if (!brand || model.toLowerCase().includes(brand.toLowerCase()) || brand === 'Apple') {
    return model;
  }
  return `${brand} ${model}`;
}
