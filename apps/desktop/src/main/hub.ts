/**
 * The two things the app asks a hub before the web client takes over: "are you a Core Hub"
 * and "here is my pairing code". Both go through the generated client (ADR 0003) — the
 * desktop app has no hand-typed API path either.
 */
import { HubApiError, createHubClient } from '@corehub/contracts';
import type { PairingRequest } from '../shared/deep-link.js';

export type ProbeResult =
  | { ok: true; name: string; serverVersion: string }
  | { ok: false; reason: 'unreachable' | 'not_a_hub' };

export async function probeHub(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<ProbeResult> {
  const client = createHubClient({ baseUrl: origin, fetch: fetchImpl });
  try {
    const { data } = await client.request('get', '/meta', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!data || !Array.isArray(data.api_versions) || !data.api_versions.includes('v1'))
      return { ok: false, reason: 'not_a_hub' };
    return { ok: true, name: data.name, serverVersion: data.server_version };
  } catch (error) {
    // Something answered, but not with the contract's JSON: a web server that is not a hub.
    if (error instanceof HubApiError || error instanceof SyntaxError)
      return { ok: false, reason: 'not_a_hub' };
    return { ok: false, reason: 'unreachable' };
  }
}

/** How this computer introduces itself to the hub (`DeviceRegistration`). */
export interface ThisComputer {
  deviceKey: string;
  name: string;
  platform: NodeJS.Platform;
  appVersion: string;
  model: string | null;
}

export function devicePlatform(platform: NodeJS.Platform): 'macos' | 'windows' | 'linux' {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * The web client's stored session (`packages/web/src/auth/store.ts`, `StoredSession`). An app
 * token has no refresh token; when it expires the web client returns to its sign-in screen.
 */
export interface WebSession {
  profile: string;
  token: string;
  refresh_token: null;
  expires_at: string | null;
  user: { id: string; username: string; display_name: string; role: string };
}

export type PairResult =
  | {
      ok: true;
      session: WebSession;
      hub: string;
      /** The device row the hub made (or updated) for this computer. */
      deviceId: string;
      /** The person's profiles, for catching up on requests (ADR 0025). */
      profiles: string[];
    }
  | { ok: false; message: string };

export async function claimPairing(
  pairing: PairingRequest,
  computer: ThisComputer,
  fetchImpl: typeof fetch = fetch,
): Promise<PairResult> {
  const client = createHubClient({ baseUrl: pairing.hub, fetch: fetchImpl });
  try {
    const { data } = await client.request('post', '/auth/pairings/{pairing_id}/claim', {
      params: { pairing_id: pairing.pairingId },
      body: {
        code: pairing.code,
        device: {
          device_key: computer.deviceKey,
          name: computer.name.slice(0, 80),
          platform: devicePlatform(computer.platform),
          kind: 'computer',
          brand: null,
          model: computer.model,
          app_version: computer.appVersion,
          // What a computer can do for an agent arrives with the local helper, off by default.
          capabilities: ['notifications'],
        },
      },
      signal: AbortSignal.timeout(15_000),
    });
    const user = data.user;
    return {
      ok: true,
      hub: pairing.hub,
      deviceId: data.device.id,
      profiles: user.profiles ?? [],
      session: {
        profile: user.default_profile ?? user.profiles?.[0] ?? 'default',
        token: data.app_token,
        refresh_token: null,
        expires_at: data.expires_at ?? null,
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          role: user.role,
        },
      },
    };
  } catch (error) {
    if (error instanceof HubApiError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
