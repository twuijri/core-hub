/**
 * What this computer answers the hub (ADR 0033 §4, §5), with the desktop helper's shapes
 * (`apps/desktop/src/main/device-answers.ts`):
 *
 * - `files`: `{tool, arguments}` — the file tools, plus `send_file`, which uploads a file from a
 *   shared folder into the request's profile (a render for the chat).
 * - `apps`: `{op: call, program, tool, arguments}` or `{op: status, call_id}`.
 * - `screen_task`: `{task, app?, time_budget_s?, model?}` or `{op: status, call_id}`; answers
 *   `{state: done|running|failed, outcome?, screenshot_attachment_id?, call_id?, progress?}`.
 */
import { statSync } from 'node:fs';
import type { ConsentGate, ConsentQuestion } from './consent.js';
import {
  REASON,
  callFileTool,
  defaultRealpath,
  fileTools,
  resolveInside,
  type FolderConfig,
  type OpenEnv,
} from './folders.js';
import { ProgramRefusal, type CallOutcome, type ProgramHost } from './programs.js';
import { RequestRefusal, type DeviceLink, type DeviceRequestView } from './device-link.js';
import { parseScreenRequest, type ScreenOutcome, type ScreenRequest } from './screen.js';
import { SCREEN_CAPABILITY } from './names.js';

export interface Activity {
  at: string;
  kind: 'files' | 'apps' | 'screen';
  tool: string;
  target: string | null;
  ok: boolean;
  detail: string | null;
}

export interface ScreenService {
  available(): boolean;
  question(request: ScreenRequest, profile: string): ConsentQuestion;
  run(request: ScreenRequest, profile: string): Promise<ScreenOutcome>;
  status(callId: string): ScreenOutcome | null;
}

export interface AnswerDeps {
  folders(): FolderConfig;
  open: OpenEnv;
  programs: ProgramHost;
  screen: ScreenService;
  consent: ConsentGate;
  record(entry: Activity): void;
  realpath?: (p: string) => string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function outcomeBody(outcome: CallOutcome): Record<string, unknown> {
  return outcome.state === 'running'
    ? { state: 'running', call_id: outcome.callId, progress: outcome.progress }
    : { state: 'done', content: outcome.content, is_error: outcome.isError };
}

export function deviceAnswers(deps: AnswerDeps) {
  return async (request: DeviceRequestView, link: DeviceLink): Promise<Record<string, unknown>> => {
    const params = isRecord(request.params) ? request.params : {};
    const args = isRecord(params.arguments) ? params.arguments : {};
    const at = new Date().toISOString();
    const note = (
      kind: Activity['kind'],
      tool: string,
      target: string | null,
      ok: boolean,
      detail: string | null,
    ) => deps.record({ at, kind, tool, target, ok, detail });

    if (request.capability === 'files') {
      const config = deps.folders();
      const tool = String(params.tool ?? '');
      if (config.folders.length === 0)
        throw new RequestRefusal('unavailable', 'No folder is shared on this computer.');
      if (tool === 'send_file') {
        const asked = String(args.path ?? '');
        const resolved = resolveInside(config.folders, asked, {
          realpath: deps.realpath ?? defaultRealpath,
        });
        if (!resolved.ok) {
          note('files', tool, asked, false, REASON[resolved.reason]);
          throw new RequestRefusal('failed', REASON[resolved.reason]);
        }
        if (!statSync(resolved.path).isFile()) {
          note('files', tool, resolved.path, false, 'not a file');
          throw new RequestRefusal('failed', 'That path is not a file.');
        }
        try {
          const sent = await link.upload(request.profile, resolved.path);
          note('files', tool, resolved.path, true, null);
          return sent;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          note('files', tool, resolved.path, false, detail);
          throw error instanceof RequestRefusal ? error : new RequestRefusal('failed', detail);
        }
      }
      if (!fileTools(config).some((t) => t.name === tool)) {
        note('files', tool, null, false, 'not offered');
        throw new RequestRefusal('unavailable', `This computer does not offer "${tool}" now.`);
      }
      const target =
        typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : null;
      try {
        const { text, target: real } = await callFileTool(
          config,
          { ...deps.open, ...(deps.realpath ? { realpath: deps.realpath } : {}) },
          tool,
          args,
        );
        note('files', tool, real, true, null);
        return { content: [{ type: 'text', text }], is_error: false };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        note('files', tool, target, false, detail);
        return { content: [{ type: 'text', text: detail }], is_error: true };
      }
    }

    if (request.capability === 'apps') {
      try {
        if (params.op === 'status')
          return outcomeBody(deps.programs.status(String(params.call_id ?? '')));
        const outcome = await deps.programs.call({
          programId: String(params.program ?? ''),
          tool: String(params.tool ?? ''),
          args,
          profile: request.profile,
        });
        return outcomeBody(outcome);
      } catch (error) {
        if (error instanceof ProgramRefusal) throw new RequestRefusal(error.code, error.message);
        throw error;
      }
    }

    if (request.capability === SCREEN_CAPABILITY) {
      if (!deps.screen.available())
        throw new RequestRefusal('unavailable', 'This computer cannot run screen tasks.');
      if (params.op === 'status') {
        const status = deps.screen.status(String(params.call_id ?? ''));
        if (!status)
          throw new RequestRefusal('unavailable', 'There is no such screen task on this computer.');
        return status;
      }
      const parsed = parseScreenRequest(params);
      if (!parsed.ok) throw new RequestRefusal('failed', parsed.message);
      const allowed = await deps.consent.check(
        deps.screen.question(parsed.request, request.profile),
        {
          everyTime: true,
        },
      );
      if (!allowed) {
        note('screen', 'screen_task', parsed.request.app, false, 'declined on this computer');
        throw new RequestRefusal(
          'permission_denied',
          'The person declined the screen task on this computer.',
        );
      }
      const outcome = await deps.screen.run(parsed.request, request.profile);
      note(
        'screen',
        'screen_task',
        parsed.request.app,
        outcome.state !== 'failed',
        outcome.state === 'failed' ? outcome.outcome.slice(0, 300) : null,
      );
      return outcome;
    }

    throw new RequestRefusal(
      'unavailable',
      `This computer does not answer "${request.capability}".`,
    );
  };
}
