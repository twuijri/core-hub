/**
 * "Hermes uses Core Hub's models" (DECISIONS §143): one choice per hub, kept in the gateway's
 * folder (`<DATA_DIR>/gateway/hermes-models.json`) so it needs no migration and a backup of the
 * data folder carries it.
 *
 * - `hub`: every model Hermes answers with, its cron model and its fallbacks go through the hub's
 *   model gateway whenever the gateway can serve them — one `providers:` block per provider row,
 *   at that row's own gateway address, with the profile's long-lived token. Models the gateway
 *   cannot serve (a Nous or MiniMax sign-in through Hermes) stay Hermes's own.
 * - `native`: Hermes as before this choice existed.
 *
 * A hub that has never decided decides once, at its first boot with this code: `hub` for a new hub
 * (no provider added yet) whose gateway is available, `native` for every hub that already has
 * providers — an upgrade never moves Hermes by itself.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type HermesModelSource = 'native' | 'hub';

const FILE = 'hermes-models.json';

export function readHermesSource(gatewayDir: string): HermesModelSource | null {
  const file = path.join(gatewayDir, FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { source?: unknown };
    return parsed.source === 'hub' || parsed.source === 'native' ? parsed.source : null;
  } catch {
    return null;
  }
}

export function writeHermesSource(
  gatewayDir: string,
  source: HermesModelSource,
  why: 'default_new_hub' | 'default_existing_hub' | 'chosen',
): void {
  mkdirSync(gatewayDir, { recursive: true, mode: 0o700 });
  const file = path.join(gatewayDir, FILE);
  writeFileSync(
    file,
    `${JSON.stringify({ source, why, at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
}
