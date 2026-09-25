/**
 * Finding Hermes on this computer and, when asked, installing it with Hermes's own installer
 * (ADR 0009). The installer is downloaded from Hermes's site each time — never a copy we
 * carry — written to a temporary file, and run with an argument array, not through a shell
 * string. It installs into Hermes's own home; the app only reads where it went.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectHermes,
  hermesInstallerFor,
  type HermesInstall,
  type MachineView,
} from '../shared/hermes-detect.js';

/**
 * Where a running Hermes gateway answers (ADR 0008's default). `COREHUB_DESKTOP_HERMES_GATEWAY`
 * points the check elsewhere — a gateway on another port, or none at all in a test.
 */
/** Terminal colour codes (ESC [ … letter), which the screen shows as plain text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

export const HERMES_GATEWAY_HEALTH =
  process.env.COREHUB_DESKTOP_HERMES_GATEWAY ?? 'http://127.0.0.1:8642/health';

export function thisMachine(env: NodeJS.ProcessEnv = process.env): MachineView {
  return {
    platform: process.platform,
    env: {
      HOME: env.HOME ?? os.homedir(),
      USERPROFILE: env.USERPROFILE,
      LOCALAPPDATA: env.LOCALAPPDATA,
      HERMES_HOME: env.HERMES_HOME,
      PATH: env.PATH ?? env.Path,
      PATHEXT: env.PATHEXT,
    },
    isFile: (file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    isDirectory: (dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

export interface HermesFound extends HermesInstall {
  /** A Hermes gateway already answers on its port (the hub then uses it as it is). */
  gateway: boolean;
}

export async function probeGateway(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const res = await fetchImpl(HERMES_GATEWAY_HEALTH, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function findHermes(
  view: MachineView = thisMachine(),
  fetchImpl: typeof fetch = fetch,
): Promise<HermesFound> {
  const [install, gateway] = [detectHermes(view), await probeGateway(fetchImpl)];
  return { ...install, gateway };
}

export interface InstallOptions {
  platform?: NodeJS.Platform;
  onLine?: (line: string) => void;
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
}

export type InstallResult = { ok: true } | { ok: false; message: string };

export async function installHermes(options: InstallOptions = {}): Promise<InstallResult> {
  const platform = options.platform ?? process.platform;
  const installer = hermesInstallerFor(platform);
  const fetchImpl = options.fetchImpl ?? fetch;
  const doSpawn = options.spawnImpl ?? spawn;
  let script: string;
  try {
    const res = await fetchImpl(installer.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { ok: false, message: `${installer.url}: HTTP ${res.status}` };
    script = await res.text();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (script.trim() === '') return { ok: false, message: `${installer.url}: empty` };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-hermes-'));
  const file = path.join(dir, platform === 'win32' ? 'install.ps1' : 'install.sh');
  writeFileSync(file, script, { mode: 0o700 });
  options.onLine?.(`$ ${installer.display}`);
  try {
    return await new Promise<InstallResult>((resolve) => {
      const child = doSpawn(installer.command, installer.args(file), {
        env: { ...(options.env ?? process.env), NONINTERACTIVE: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const emit = (chunk: Buffer | string) => {
        // Installers colour their output; the screen shows plain lines.
        for (const line of String(chunk).replace(ANSI, '').split(/\r?\n/))
          if (line.trim()) options.onLine?.(line);
      };
      child.stdout?.on('data', emit);
      child.stderr?.on('data', emit);
      child.once('error', (error) => resolve({ ok: false, message: error.message }));
      child.once('exit', (code, signal) =>
        resolve(
          code === 0 ? { ok: true } : { ok: false, message: `exit ${signal ?? String(code)}` },
        ),
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
