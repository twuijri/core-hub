// Module `devices`: owns phones/computers linked to the hub, capabilities they expose, media relay.
// Public surface of the module: other modules and app/ import this file only.
//
// Exported now (used by auth's pairing): creating/updating the device row a pairing produces,
// revoking it when its token is revoked, and the contract `Device` shape. The routes of the
// `devices` tag are added once this module is implemented.
import { and, eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';
import {
  devices,
  type CapabilityKind,
  type DeviceConnection,
  type DeviceKind,
  type DevicePlatform,
} from './schema.js';

export type DeviceRow = typeof devices.$inferSelect;
export type { CapabilityKind, DeviceConnection, DeviceKind, DevicePlatform } from './schema.js';
export { CAPABILITY_KINDS, DEVICE_CONNECTIONS, DEVICE_KINDS, DEVICE_PLATFORMS } from './schema.js';

export const devicesModule = defineModule({
  name: 'devices',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.devices);
  },
});

export const registerRoutes = devicesModule.registerRoutes.bind(devicesModule);
export const registerEvents = devicesModule.registerEvents.bind(devicesModule);

/** The contract's `DeviceRegistration` plus who owns the device and which token it got. */
export interface PairedDeviceInput {
  ownerId: string;
  deviceKey: string;
  name: string;
  platform: DevicePlatform;
  kind: DeviceKind;
  brand: string | null;
  model: string | null;
  appVersion: string | null;
  capabilities: readonly CapabilityKind[];
  connection: DeviceConnection;
  appTokenId: string;
}

/**
 * Creates the device row, or re-pairs the same device (same owner + `device_key`) in place.
 * Returns the previous token id so the caller (auth) can revoke it.
 */
export function registerPairedDevice(
  db: ModuleDb,
  input: PairedDeviceInput,
  now: number,
): { device: DeviceRow; previousTokenId: string | null } {
  const existing = db
    .select()
    .from(devices)
    .where(and(eq(devices.ownerId, input.ownerId), eq(devices.deviceKey, input.deviceKey)))
    .get();
  const capabilities = input.capabilities.map((kind) => {
    const known = existing?.capabilities.find((c) => c.kind === kind);
    return { kind, enabled: true, consentAt: known?.consentAt ?? null };
  });
  const values = {
    name: input.name,
    platform: input.platform,
    kind: input.kind,
    brand: input.brand,
    model: input.model,
    appVersion: input.appVersion,
    connection: input.connection,
    capabilities,
    status: 'paired' as const,
    appTokenId: input.appTokenId,
    pairedAt: new Date(now),
    lastSeenAt: new Date(now),
    revokedAt: null,
  };
  if (existing) {
    const device = db
      .update(devices)
      .set(values)
      .where(eq(devices.id, existing.id))
      .returning()
      .get()!;
    return { device, previousTokenId: existing.appTokenId ?? null };
  }
  const device = db
    .insert(devices)
    .values({ ownerId: input.ownerId, deviceKey: input.deviceKey, ...values })
    .returning()
    .get();
  return { device, previousTokenId: null };
}

export function findDevice(db: ModuleDb, id: string): DeviceRow | null {
  return db.select().from(devices).where(eq(devices.id, id)).get() ?? null;
}

/** Marks the device revoked when its pairing token is revoked; null when no device holds it. */
export function revokeDeviceByToken(
  db: ModuleDb,
  appTokenId: string,
  now: number,
): DeviceRow | null {
  const row = db.select().from(devices).where(eq(devices.appTokenId, appTokenId)).get();
  if (!row) return null;
  if (row.status === 'revoked') return row;
  return (
    db
      .update(devices)
      .set({ status: 'revoked', revokedAt: new Date(now) })
      .where(eq(devices.id, row.id))
      .returning()
      .get() ?? null
  );
}

export interface SerializeDeviceOptions {
  /** Has a live `/rt/devices` socket (the socket registry is a later task; callers pass what they know). */
  online: boolean;
  /** True when the reader is this very device. */
  thisDevice: boolean;
}

/** The contract's `Device`. */
export function serializeDevice(row: DeviceRow, options: SerializeDeviceOptions) {
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return {
    id: row.id,
    user_id: row.ownerId,
    device_key: row.deviceKey,
    name: row.name,
    platform: row.platform,
    kind: row.kind,
    brand: row.brand,
    model: row.model,
    app_version: row.appVersion,
    connection: row.connection,
    online: options.online,
    last_seen_at: iso(row.lastSeenAt),
    app_token_id: row.appTokenId,
    capabilities: row.capabilities.map((c) => ({
      kind: c.kind,
      enabled: c.enabled,
      consent_at: c.consentAt === null ? null : new Date(c.consentAt).toISOString(),
    })),
    push:
      row.pushProvider === 'none' || !row.pushRegisteredAt
        ? null
        : {
            provider: row.pushProvider,
            locale: row.pushLocale === 'en' ? ('en' as const) : ('ar' as const),
            registered_at: row.pushRegisteredAt.toISOString(),
          },
    this_device: options.thisDevice,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
