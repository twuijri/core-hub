/**
 * What this computer answers a hub on a server (ADR 0025): the same helper tools, the same
 * folder rule, the same programs, consent and activity list as for the hub on this computer —
 * only reached through the device connection instead of the loopback.
 *
 * - `files`: `{tool, arguments}` — the helper's own file tools, plus `send_file`, which uploads a
 *   file from a shared folder into the request's profile (a render for the chat).
 * - `apps`: `{op: call, program, tool, arguments}` or `{op: status, call_id}`.
 */
import { realpathSync, statSync } from 'node:fs';
import { resolveInside, type HelperConfig } from '../shared/helper.js';
import { callTool, toolsFor, type HelperActivity, type HelperEnv } from './helper.js';
import { ProgramRefusal, type CallOutcome, type ProgramHost } from './programs.js';
import { RequestRefusal, type DeviceLink, type DeviceRequestView } from './device-link.js';

export interface AnswerDeps {
  config(): HelperConfig;
  env: HelperEnv;
  programs: ProgramHost;
  record(entry: HelperActivity): void;
  realpath?: (p: string) => string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function outcomeBody(outcome: CallOutcome): Record<string, unknown> {
  return outcome.state === 'running'
    ? { state: 'running', call_id: outcome.callId, progress: outcome.progress }
    : { state: 'done', content: outcome.content, is_error: outcome.isError };
}

export function deviceAnswers(deps: AnswerDeps) {
  return async (request: DeviceRequestView, link: DeviceLink): Promise<Record<string, unknown>> => {
    const config = deps.config();
    if (!config.enabled)
      throw new RequestRefusal('unavailable', 'The helper is switched off on this computer.');
    const params = isRecord(request.params) ? request.params : {};
    const args = isRecord(params.arguments) ? params.arguments : {};
    const at = new Date().toISOString();

    if (request.capability === 'files') {
      const tool = String(params.tool ?? '');
      if (tool === 'send_file') {
        const resolved = resolveInside(config.folders, String(args.path ?? ''), {
          realpath: deps.realpath ?? defaultRealpath,
        });
        if (!resolved.ok) {
          const detail =
            resolved.reason === 'missing'
              ? 'That path does not exist.'
              : 'That path is not inside a folder shared with the helper.';
          deps.record({ at, tool, target: String(args.path ?? ''), ok: false, detail, via: 'hub' });
          throw new RequestRefusal('failed', detail);
        }
        if (!statSync(resolved.path).isFile()) {
          deps.record({
            at,
            tool,
            target: resolved.path,
            ok: false,
            detail: 'not a file',
            via: 'hub',
          });
          throw new RequestRefusal('failed', 'That path is not a file.');
        }
        try {
          const sent = await link.upload(request.profile, resolved.path);
          deps.record({ at, tool, target: resolved.path, ok: true, detail: null, via: 'hub' });
          return sent;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          deps.record({ at, tool, target: resolved.path, ok: false, detail, via: 'hub' });
          throw error instanceof RequestRefusal ? error : new RequestRefusal('failed', detail);
        }
      }
      if (!toolsFor(config).some((t) => t.name === tool)) {
        deps.record({ at, tool, target: null, ok: false, detail: 'not offered', via: 'hub' });
        throw new RequestRefusal('unavailable', `The helper does not offer "${tool}" now.`);
      }
      try {
        const { text, target } = await callTool(config, deps.env, tool, args);
        deps.record({ at, tool, target, ok: true, detail: null, via: 'hub' });
        return { content: [{ type: 'text', text }], is_error: false };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const target =
          typeof args.path === 'string'
            ? args.path
            : typeof args.url === 'string'
              ? args.url
              : null;
        deps.record({ at, tool, target, ok: false, detail, via: 'hub' });
        return { content: [{ type: 'text', text: detail }], is_error: true };
      }
    }

    if (request.capability === 'apps') {
      try {
        if (params.op === 'status') {
          return outcomeBody(deps.programs.status(String(params.call_id ?? '')));
        }
        const outcome = await deps.programs.call({
          programId: String(params.program ?? ''),
          tool: String(params.tool ?? ''),
          args,
          profile: request.profile,
          via: 'hub',
          hub: link.hub,
        });
        return outcomeBody(outcome);
      } catch (error) {
        if (error instanceof ProgramRefusal) throw new RequestRefusal(error.code, error.message);
        throw error;
      }
    }

    throw new RequestRefusal(
      'unavailable',
      `This computer does not answer "${request.capability}".`,
    );
  };
}

function defaultRealpath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}
