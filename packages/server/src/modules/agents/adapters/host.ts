/**
 * Host probing for the adapters: find a binary on PATH, ask it for its version, and call
 * an HTTP endpoint with a deadline.
 *
 * Everything here uses argv arrays — no shell string is ever built (AGENTS.md hard rules),
 * so an agent name from the registry cannot become a command injection.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where to look for a binary, and what a spawned agent inherits. Always injected: the
 * hub's configuration file is the only place allowed to read the environment, and a unit
 * test enforces that.
 */
export interface HostEnvironment {
  /** `PATH` as the adapters should search it; tests point it at a fixture directory. */
  pathValue: string | undefined;
  /** Windows needs the extension list; harmless elsewhere. */
  pathExt?: string | undefined;
  /** The environment a spawned agent process inherits. */
  inherited?: NodeJS.ProcessEnv | undefined;
}

/** First executable named `binary` on PATH, or null. Never throws. */
export function whichSync(binary: string, host: HostEnvironment): string | null {
  if (binary.includes('/') || binary.includes('\\')) {
    return isExecutable(binary) ? binary : null;
  }
  const extensions = (host.pathExt ?? '').split(path.delimiter).filter(Boolean);
  const candidates = extensions.length > 0 ? ['', ...extensions] : [''];
  for (const dir of (host.pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of candidates) {
      const candidate = path.join(dir, binary + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Runs argv with a deadline. Failure is a value, never an exception. */
export async function runCommand(
  argv: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (!command) return { ok: false, stdout: '', stderr: '', error: 'empty command' };
  try {
    const { stdout, stderr } = await run(command, args, {
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: 1024 * 1024,
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr), error: null };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
      error: failure.message ?? 'command failed',
    };
  }
}

/**
 * Pulls a version out of `--version` output: agents print anything from `1.2.3` to
 * `claude-code/2.1.0 (darwin-arm64)`.
 */
export function parseVersion(output: string): string | null {
  const match = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1] ?? null;
}

export interface HttpProbe {
  ok: boolean;
  status: number | null;
  body: unknown;
  error: string | null;
}

/** GET with a deadline. Used to ask a Hermes gateway whether it is up. */
export async function probeHttp(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<HttpProbe> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // A non-JSON body is still a sign of life; keep the text.
    }
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
