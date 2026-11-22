/**
 * The settings page's way into the plugin: exact Fetch routes on the harness's own `/api`
 * channel (`ctx.connection.fetch.register`), reached by the page through the same authenticated
 * connection every harness page uses. The harness lets only its owner reach an exact route; the
 * handler checks that again. Nobody else's browser, and no request without the harness's own
 * credential.
 *
 * - `corehub/state` — what the page shows (never the token).
 * - `corehub/link` `{ pairing }` — claim a pairing; the code is used once and kept nowhere.
 * - `corehub/unlink`, `corehub/models` — as the commands do.
 * - `corehub/settings` `{ patch }` — change the plugin's live settings.
 * - `corehub/pick-folder` — the harness's folder chooser on this computer.
 */
import path from 'node:path';
import type { Outcome, SettingsPatch, StatusView } from './core.js';

export const PANEL_PREFIX = 'corehub/';

/** The page's endpoints; each is the route `/api/corehub/<name>`. */
export const PANEL_ENDPOINTS = ['state', 'link', 'unlink', 'models', 'settings', 'pick-folder'];

export interface PanelCore {
  statusView(): StatusView;
  linkWith(raw: string): Promise<Outcome>;
  unlink(): Promise<Outcome>;
  refreshModels(): Promise<Outcome>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  pickFolder(signal: AbortSignal): Promise<string | null>;
}

export type PanelResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } };

const fail = (code: string, message: string): PanelResult => ({
  ok: false,
  error: { code, message, details: {} },
});

/** One Fetch route's answer: the request's JSON body in, the result as JSON out. */
export async function panelResponse(
  core: PanelCore,
  name: string,
  request: Request,
): Promise<Response> {
  let payload: unknown;
  try {
    const text = await request.text();
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = null;
  }
  const result =
    payload === null
      ? fail('corehub/bad-request', 'the body is not JSON')
      : // Exact routes reach only the harness's owner (dsh-client-connection).
        await handlePanel(core, `${PANEL_PREFIX}${name}`, payload, request.signal, {
          kind: 'owner',
        });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** One page request; `principal` is the caller the harness admitted. */
export async function handlePanel(
  core: PanelCore,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  principal: { kind?: string } | null | undefined,
): Promise<PanelResult> {
  if (principal?.kind !== 'owner') return fail('corehub/forbidden', 'owner only');
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  try {
    switch (endpoint.slice(PANEL_PREFIX.length)) {
      case 'state':
        return { ok: true, value: core.statusView() };
      case 'link': {
        const pairing = typeof body.pairing === 'string' ? body.pairing : '';
        const outcome = await core.linkWith(pairing);
        return { ok: true, value: { outcome, state: core.statusView() } };
      }
      case 'unlink': {
        const outcome = await core.unlink();
        return { ok: true, value: { outcome, state: core.statusView() } };
      }
      case 'models': {
        const outcome = await core.refreshModels();
        return { ok: true, value: { outcome, state: core.statusView() } };
      }
      case 'settings': {
        const patch = cleanPatch(body.patch);
        if (!patch.ok) return fail('corehub/bad-request', patch.error);
        await core.updateSettings(patch.value);
        return { ok: true, value: { state: core.statusView() } };
      }
      case 'pick-folder':
        return { ok: true, value: { path: await core.pickFolder(signal) } };
      default:
        return fail('corehub/not-found', `no endpoint ${endpoint}`);
    }
  } catch (error) {
    return fail('corehub/failed', error instanceof Error ? error.message : String(error));
  }
}

const LANGUAGES = new Set(['auto', 'en', 'ar']);
const MAX_FOLDERS = 64;

/** Only the fields the page may change, each of the right shape; anything else is refused. */
export function cleanPatch(
  raw: unknown,
  api: typeof path = path,
): { ok: true; value: SettingsPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'patch must be an object' };
  const out: SettingsPatch = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case 'folders': {
        if (!Array.isArray(value) || value.length > MAX_FOLDERS)
          return { ok: false, error: 'folders must be a list' };
        const folders: Array<{ path: string; write: boolean }> = [];
        const seen = new Set<string>();
        for (const f of value) {
          const p = (f as { path?: unknown })?.path;
          const w = (f as { write?: unknown })?.write;
          if (typeof p !== 'string' || !p.trim() || !api.isAbsolute(p.trim()))
            return { ok: false, error: 'a folder needs an absolute path' };
          const clean = api.normalize(p.trim());
          if (seen.has(clean)) continue;
          seen.add(clean);
          folders.push({ path: clean, write: w === true });
        }
        out.folders = folders;
        break;
      }
      case 'allowOpen':
      case 'screenTasks':
        if (typeof value !== 'boolean') return { ok: false, error: `${key} must be true or false` };
        out[key] = value;
        break;
      case 'agentProfile':
      case 'screenModel':
        if (typeof value !== 'string' || value.length > 200)
          return { ok: false, error: `${key} must be text` };
        out[key] = value.trim();
        break;
      case 'language':
        if (typeof value !== 'string' || !LANGUAGES.has(value))
          return { ok: false, error: 'language must be auto, en or ar' };
        out.language = value as SettingsPatch['language'] & string;
        break;
      case 'programs': {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return { ok: false, error: 'programs must be an object' };
        const programs: Record<string, string[]> = {};
        for (const [server, profiles] of Object.entries(value as Record<string, unknown>)) {
          if (!Array.isArray(profiles) || !profiles.every((p) => typeof p === 'string'))
            return { ok: false, error: 'each program needs a list of profiles' };
          const list = [...new Set((profiles as string[]).map((p) => p.trim()).filter(Boolean))];
          if (list.length > 0) programs[server] = list;
        }
        out.programs = programs;
        break;
      }
      default:
        return { ok: false, error: `unknown setting ${key}` };
    }
  }
  return { ok: true, value: out };
}
