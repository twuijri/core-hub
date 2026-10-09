/**
 * Shared by the real-Hermes suites (`*.real.test.ts`) that run a messaging gateway: which Hermes
 * the image carries, and where that Hermes puts a named profile's gateway.
 *
 * CI runs every real suite against the floor (§119) and the pinned release (§132). Below v2026.9.21
 * (`0.21.4`) a named profile has a gateway of its own (`hermes -p <profile> gateway run`, its state
 * in the profile's home); from it on, one gateway per host serves every profile (DECISIONS §129):
 * the hub runs only the root's, which lists the profile's platforms as `<profile>:<platform>` in
 * the root's `gateway_state.json` and refuses a second gateway (exit 75). A suite checks what the
 * hub does with the Hermes in front of it, so it asks.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseVersion } from '../../src/modules/agents/adapters/host.js';
import {
  readGatewayRecord,
  topologyForVersion,
  type GatewayRuntimeRecord,
} from '../../src/modules/agents/hermes-gateways.js';

const versions = new Map<string, string | null>();

/** `hermes --version` of the image's Hermes (`0.21.5`), read once per image. */
export function imageHermesVersion(image: string): string | null {
  if (!versions.has(image)) {
    let out = '';
    try {
      out = execFileSync(
        'docker',
        ['run', '--rm', '--entrypoint', '/opt/hermes/.venv/bin/hermes', image, '--version'],
        { encoding: 'utf8', timeout: 120_000 },
      );
    } catch {
      // unknown: treated as the older topology, as the hub does
    }
    versions.set(image, parseVersion(out.split('\n')[0] ?? ''));
  }
  return versions.get(image) ?? null;
}

const pluginHosts = new Map<string, boolean>();

/**
 * The image's Hermes can run a plugin that is not its own in a plugin-host process
 * (`plugins.isolation: host`, `hermes_cli/plugin_isolation.py`, v0.21.6 and later).
 */
export function runsPluginsInAHost(image: string): boolean {
  if (!pluginHosts.has(image)) {
    let found = false;
    try {
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          image,
          '-c',
          'test -f /opt/hermes/src/hermes_cli/plugin_isolation.py',
        ],
        { stdio: 'ignore', timeout: 120_000 },
      );
      found = true;
    } catch {
      // not there: an older Hermes
    }
    pluginHosts.set(image, found);
  }
  return pluginHosts.get(image) ?? false;
}

/** The image's Hermes runs one gateway per host (v2026.9.21 and later). */
export function servesEveryProfileFromOneGateway(image: string): boolean {
  return topologyForVersion(imageHermesVersion(image)) === 'one-per-host';
}

/**
 * The `hermes` arguments of the gateway that serves `profile`, as the hub starts it: its own on an
 * older Hermes, the root's (no `-p`) on one with one gateway per host.
 */
export function gatewayArgsFor(image: string, profile: string): string[] {
  return servesEveryProfileFromOneGateway(image)
    ? ['gateway', 'run']
    : ['-p', profile, 'gateway', 'run'];
}

/**
 * The gateway record for `profile` as the hub reads it (`ProfileGateways.record`): the profile's
 * own file, or the root's narrowed to `<profile>:` platforms.
 */
export function gatewayRecordFor(
  image: string,
  root: string,
  profile: string,
): GatewayRuntimeRecord | null {
  if (!servesEveryProfileFromOneGateway(image)) {
    return readGatewayRecord(path.join(root, 'profiles', profile));
  }
  const record = readGatewayRecord(root);
  if (!record) return null;
  const platforms: GatewayRuntimeRecord['platforms'] = {};
  for (const [key, value] of Object.entries(record.platforms)) {
    if (key.startsWith(`${profile}:`)) platforms[key.slice(profile.length + 1)] = value;
  }
  return { ...record, platforms };
}
