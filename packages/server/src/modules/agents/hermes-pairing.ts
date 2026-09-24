/**
 * Who may talk to the agent on a messaging channel: Hermes's pairing, in the selected profile.
 *
 * The hub links WhatsApp with `WHATSAPP_DM_POLICY=pairing`, so a stranger who messages the
 * number gets a pairing code and waits until someone approves them. Hermes keeps those
 * requests and the approved senders per profile (`gateway/pairing.py` §PairingStore, files
 * under the profile's `platforms/pairing/`), and its own server lists and changes them
 * (`hermes_cli/web_routers/ops.py`, tag v2026.9.14):
 *
 * - `GET /api/pairing?profile=` → `{pending: [{platform, request_id, user_id, user_name,
 *   age_minutes}], approved: [{platform, user_id, user_name, approved_at}]}` — the code itself
 *   is never listed, only a request id;
 * - `POST /api/pairing/approve` `{platform, request_id, profile}` → `{ok, user}`, `404` when the
 *   request expired (an hour) or was already answered;
 * - `POST /api/pairing/revoke` `{platform, user_id, profile}` → `{ok}`, `404` when not approved.
 *
 * Hermes has no verb for turning one request down — only `clear-pending`, which drops every
 * request of every platform. So **Deny** removes that one request from the profile's
 * `<platform>-pending.json` itself, the file Hermes reads fresh on every call, written the way
 * Hermes writes it (a temporary file renamed over it). The sender is not told; Hermes's own
 * rate limit keeps them from asking again for ten minutes, and after that they may.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HubError, notFound } from '../../lib/errors.js';
import { HermesDashboardRefusal } from './hermes-dashboard.js';
import { hermesFault, type HermesApiCall } from './hermes-tools.js';

export interface PairingRequest {
  platform: string;
  request_id: string;
  user_id: string;
  user_name: string | null;
  /** When the sender asked, from Hermes's age in minutes. */
  requested_at: string;
}

export interface PairedSender {
  platform: string;
  user_id: string;
  user_name: string | null;
  approved_at: string | null;
}

const PLATFORM = /^[a-z0-9_-]{1,40}$/;
/** Hermes's request ids: `secrets.token_hex(8)` (`PairingStore.looks_like_request_id`). */
const REQUEST_ID = /^[0-9a-f]{16}$/i;

interface HermesPending {
  platform?: unknown;
  request_id?: unknown;
  user_id?: unknown;
  user_name?: unknown;
  age_minutes?: unknown;
}
interface HermesApproved {
  platform?: unknown;
  user_id?: unknown;
  user_name?: unknown;
  approved_at?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** Pending requests and approved senders of every platform in `profile`, newest request first. */
export async function listPairing(
  api: HermesApiCall,
  profile: string,
  now: () => number = Date.now,
): Promise<{ pending: PairingRequest[]; approved: PairedSender[] }> {
  let answer: { pending?: HermesPending[]; approved?: HermesApproved[] };
  try {
    answer = await api('GET', `/api/pairing?profile=${encodeURIComponent(profile)}`);
  } catch (error) {
    return hermesFault(error);
  }
  const at = now();
  const pending = (answer?.pending ?? [])
    // A request from before Hermes hashed its codes has no id to approve it by.
    .filter((row) => text(row.platform) && text(row.request_id) && text(row.user_id))
    .map((row) => {
      const minutes = typeof row.age_minutes === 'number' ? Math.max(0, row.age_minutes) : 0;
      return {
        platform: row.platform as string,
        request_id: row.request_id as string,
        user_id: row.user_id as string,
        user_name: text(row.user_name),
        requested_at: new Date(at - minutes * 60_000).toISOString(),
      };
    })
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
  const approved = (answer?.approved ?? [])
    .filter((row) => text(row.platform) && text(row.user_id))
    .map((row) => ({
      platform: row.platform as string,
      user_id: row.user_id as string,
      user_name: text(row.user_name),
      approved_at:
        typeof row.approved_at === 'number' && Number.isFinite(row.approved_at)
          ? new Date(row.approved_at * 1000).toISOString()
          : null,
    }))
    .sort((a, b) => (b.approved_at ?? '').localeCompare(a.approved_at ?? ''));
  return { pending, approved };
}

function checkPlatform(platform: string): void {
  if (!PLATFORM.test(platform)) {
    throw new HubError('bad_request', { details: { reason: 'platform_invalid', platform } });
  }
}

/** Approves one request; the sender may talk to the agent from now on. */
export async function approvePairing(
  api: HermesApiCall,
  input: { profile: string; platform: string; requestId: string },
): Promise<PairedSender> {
  checkPlatform(input.platform);
  let answer: { user?: { user_id?: unknown; user_name?: unknown } };
  try {
    answer = await api('POST', '/api/pairing/approve', {
      platform: input.platform,
      request_id: input.requestId,
      profile: input.profile,
    });
  } catch (error) {
    if (error instanceof HermesDashboardRefusal && error.status === 404) {
      throw notFound({ resource: 'pairing_request', id: input.requestId });
    }
    return hermesFault(error);
  }
  return {
    platform: input.platform,
    user_id: text(answer?.user?.user_id) ?? '',
    user_name: text(answer?.user?.user_name),
    approved_at: new Date().toISOString(),
  };
}

/** Takes a sender's approval back; their next message is a new pairing request. */
export async function revokePairing(
  api: HermesApiCall,
  input: { profile: string; platform: string; userId: string },
): Promise<void> {
  checkPlatform(input.platform);
  try {
    await api('POST', '/api/pairing/revoke', {
      platform: input.platform,
      user_id: input.userId,
      profile: input.profile,
    });
  } catch (error) {
    if (error instanceof HermesDashboardRefusal && error.status === 404) {
      throw notFound({ resource: 'paired_sender', id: input.userId });
    }
    hermesFault(error);
  }
}

/**
 * Where Hermes keeps a profile's pairing files (`get_hermes_dir("platforms/pairing",
 * "pairing")`): the old `pairing/` while it holds anything, else `platforms/pairing/`.
 */
export function pairingDir(home: string): string {
  const legacy = path.join(home, 'pairing');
  try {
    if (statSync(legacy).isDirectory() && readdirSync(legacy).length > 0) return legacy;
  } catch {
    // No old folder: the new one.
  }
  return path.join(home, 'platforms', 'pairing');
}

/** Turns one request down: it leaves Hermes's pending list; nothing is sent to the sender. */
export function denyPairing(home: string, platform: string, requestId: string): void {
  checkPlatform(platform);
  if (!REQUEST_ID.test(requestId)) throw notFound({ resource: 'pairing_request', id: requestId });
  const file = path.join(pairingDir(home), `${platform}-pending.json`);
  if (!existsSync(file)) throw notFound({ resource: 'pairing_request', id: requestId });
  let pending: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    pending = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw notFound({ resource: 'pairing_request', id: requestId });
  }
  const key = Object.keys(pending).find((id) => id.toLowerCase() === requestId.toLowerCase());
  if (!key) throw notFound({ resource: 'pairing_request', id: requestId });
  delete pending[key];
  const temp = `${file}.majlis-${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(pending, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
