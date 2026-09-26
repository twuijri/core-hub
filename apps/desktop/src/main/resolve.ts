/**
 * Is DaVinci Resolve ready to be driven by an agent (ADR 0025)? Four things, each said plainly
 * with the step that fixes it:
 *
 * 1. its integration (an MCP server) is installed where another assistant registered it, and
 *    switched on here for a profile;
 * 2. Resolve is running (its scripting API talks to the running app only);
 * 3. scripting from outside the app is allowed — Preferences → System → General → "External
 *    scripting using" → Local;
 * 4. it is DaVinci Resolve Studio: in recent versions the free edition allows scripting only
 *    from inside the app.
 *
 * 3 and 4 are asked of Resolve itself, the way its public scripting documentation says to
 * reach it: Python with `RESOLVE_SCRIPT_API` / `RESOLVE_SCRIPT_LIB` set, `DaVinciResolveScript`
 * imported, `scriptapp("Resolve")`. When that answers, the product name says the edition; when
 * it does not while Resolve runs, either setting may be the reason and both steps are shown.
 * Everything runs with argument arrays, never a shell.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { isResolve, type DiscoveredProgram } from '../shared/programs.js';
import type { ProgramSettings } from '../shared/helper.js';

export type ResolveStep =
  'install_integration' | 'share_program' | 'start_resolve' | 'enable_scripting' | 'needs_studio';

export interface ResolveReadiness {
  checkedAt: string;
  /** The integration's program id here, when one was found. */
  programId: string | null;
  integration: 'missing' | 'found' | 'shared';
  running: boolean | null;
  scripting: 'reachable' | 'unreachable' | 'unknown';
  /** From Resolve itself when scripting answered: `DaVinci Resolve Studio`, … */
  product: string | null;
  version: string | null;
  studio: boolean | null;
  /** What to do next, in order; empty when it is ready. */
  steps: ResolveStep[];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
}

export type Exec = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ExecResult>;

export const execWithArgs: Exec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: options.env, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? null
              : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      },
    );
  });

/** Where Resolve's scripting files are, per its README (the defaults of an installed Resolve). */
export function scriptingEnv(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  let api: string;
  let lib: string;
  if (platform === 'darwin') {
    api = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting';
    lib =
      '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
  } else if (platform === 'win32') {
    const data = env.PROGRAMDATA ?? 'C:\\ProgramData';
    api = path.win32.join(
      data,
      'Blackmagic Design',
      'DaVinci Resolve',
      'Support',
      'Developer',
      'Scripting',
    );
    lib = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll';
  } else {
    api = '/opt/resolve/Developer/Scripting';
    lib = '/opt/resolve/libs/Fusion/fusionscript.so';
  }
  // A person who set them already (another integration asked them to) knows better.
  api = env.RESOLVE_SCRIPT_API ?? api;
  lib = env.RESOLVE_SCRIPT_LIB ?? lib;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const modules = join(api, 'Modules');
  const separator = platform === 'win32' ? ';' : ':';
  return {
    RESOLVE_SCRIPT_API: api,
    RESOLVE_SCRIPT_LIB: lib,
    PYTHONPATH: env.PYTHONPATH ? `${env.PYTHONPATH}${separator}${modules}` : modules,
  };
}

/** Asks the running Resolve its name and version; prints one JSON line. */
const PROBE = [
  'import json',
  'try:',
  '    import DaVinciResolveScript as d',
  '    r = d.scriptapp("Resolve")',
  '    print(json.dumps({"ok": r is not None, "product": r.GetProductName() if r else None, "version": r.GetVersionString() if r else None}))',
  'except Exception as e:',
  '    print(json.dumps({"ok": False, "error": str(e)[:200]}))',
].join('\n');

async function isRunning(platform: NodeJS.Platform, exec: Exec): Promise<boolean | null> {
  if (platform === 'win32') {
    const out = await exec('tasklist', ['/FI', 'IMAGENAME eq Resolve.exe', '/NH'], {
      timeoutMs: 10_000,
    });
    if (out.code === null && !out.stdout) return null;
    return /resolve\.exe/i.test(out.stdout);
  }
  const out = await exec('pgrep', ['-x', platform === 'darwin' ? 'Resolve' : 'resolve'], {
    timeoutMs: 10_000,
  });
  if (out.code === 0) return true;
  if (out.code === 1) return false;
  return null;
}

async function probe(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exec: Exec,
): Promise<{ ok: boolean; product: string | null; version: string | null } | null> {
  const pythons: Array<[string, string[]]> =
    platform === 'win32'
      ? [
          ['py', ['-3']],
          ['python', []],
        ]
      : [['python3', []]];
  for (const [command, prefix] of pythons) {
    const out = await exec(command, [...prefix, '-c', PROBE], {
      env: { ...env, ...scriptingEnv(platform, env) },
      timeoutMs: 20_000,
    });
    const line = out.stdout.trim().split('\n').pop() ?? '';
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; product?: unknown; version?: unknown };
      return {
        ok: parsed.ok === true,
        product: typeof parsed.product === 'string' ? parsed.product : null,
        version: typeof parsed.version === 'string' ? parsed.version : null,
      };
    } catch {
      // No Python there, or it printed something else: try the next one.
    }
  }
  return null;
}

export async function checkResolve(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  programs: DiscoveredProgram[];
  settings: Record<string, ProgramSettings>;
  exec?: Exec;
  now?: () => Date;
}): Promise<ResolveReadiness> {
  const exec = input.exec ?? execWithArgs;
  const program = input.programs.find((p) => p.kind === 'stdio' && isResolve(p)) ?? null;
  const shared = program ? (input.settings[program.id]?.profiles.length ?? 0) > 0 : false;
  const integration = !program ? 'missing' : shared ? 'shared' : 'found';
  const running = await isRunning(input.platform, exec);
  const answer = running === false ? null : await probe(input.platform, input.env, exec);
  const scripting = answer === null ? 'unknown' : answer.ok ? 'reachable' : 'unreachable';
  const studio = answer?.product ? /studio/i.test(answer.product) : null;
  const steps: ResolveStep[] = [];
  if (integration === 'missing') steps.push('install_integration');
  else if (integration === 'found') steps.push('share_program');
  if (running === false) steps.push('start_resolve');
  else if (scripting === 'unreachable') steps.push('enable_scripting', 'needs_studio');
  else if (studio === false) steps.push('needs_studio');
  return {
    checkedAt: (input.now?.() ?? new Date()).toISOString(),
    programId: program?.id ?? null,
    integration,
    running,
    scripting,
    product: answer?.product ?? null,
    version: answer?.version ?? null,
    studio,
    steps,
  };
}
