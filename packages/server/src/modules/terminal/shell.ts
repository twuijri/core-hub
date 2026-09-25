/**
 * The shell behind one web terminal session.
 *
 * A real pseudo-terminal through `node-pty` (MIT, THIRD-PARTY-NOTICES.md) when its native
 * binding loads — line editing, colours, `top`, `vim`. When it does not (a platform without a
 * build), the hub falls back to a plain shell over pipes: commands run and print, but there is
 * no terminal behind them, so full-screen programs and line editing do not work. The status
 * route says which one this hub has (`pty`), and so does the Terminal page.
 *
 * Either way the shell runs as the hub's own user — the process spawns it, and the image runs
 * the hub as `hub`, never root — and it inherits only the variables listed in `SHELL_ENV_KEYS`,
 * not the hub's whole environment. That is tidiness, not a wall: the same user can read the
 * hub's own `/proc/<pid>/environ` (docs/changes/2026-09-25-twuijri-owner-terminal.md §threat
 * model).
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface ShellProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number | null) => void): void;
}

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface ShellSpawner {
  /** True for a real pseudo-terminal; false for the pipe fallback. */
  readonly pty: boolean;
  /** The shell every session runs. */
  readonly shell: string;
  spawn(options: SpawnOptions): ShellProcess;
}

/**
 * What a session's shell inherits from the hub's environment. `PATH` and `HOME` so commands
 * resolve as they do for the hub; Hermes's own variables so `hermes …` finds its home and
 * keeps its sealed-image switches; the locale and time zone. Nothing that could carry a
 * secret (`HUB_ADMIN_PASSWORD`, provider keys, `DATABASE_URL`).
 */
export const SHELL_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HERMES_HOME',
  'PYTHONDONTWRITEBYTECODE',
  'HERMES_DISABLE_LAZY_INSTALLS',
  'HERMES_LAZY_INSTALL_TARGET',
] as const;

export function shellEnv(inherited: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SHELL_ENV_KEYS) {
    const value = inherited[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.LANG ??= 'C.UTF-8';
  // A shell can tell it is the hub's terminal (a prompt, a script that should refuse).
  env.COREHUB_TERMINAL = '1';
  return env;
}

/** bash where there is one (the image has it); the POSIX shell anywhere else. */
export function defaultShell(exists: (file: string) => boolean = existsSync): string {
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  };
}

/** node-pty, or null when its native binding does not load on this host. */
export function loadNodePty(): NodePty | null {
  try {
    return createRequire(import.meta.url)('node-pty') as NodePty;
  } catch {
    return null;
  }
}

export function ptySpawner(pty: NodePty, shell: string = defaultShell()): ShellSpawner {
  return {
    pty: true,
    shell,
    spawn({ cwd, cols, rows, env }) {
      const child = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env });
      return {
        write: (data) => child.write(data),
        resize: (c, r) => child.resize(c, r),
        kill: () => child.kill(),
        onData: (listener) => void child.onData(listener),
        onExit: (listener) => void child.onExit(({ exitCode }) => listener(exitCode)),
      };
    },
  };
}

/** What Backspace sends. */
const DELETE = String.fromCharCode(127);

/**
 * The fallback: the shell over pipes. There is no terminal to echo what is typed or to turn
 * Enter into a newline, so this does both, crudely — enough to run a command and read what it
 * printed, which is what the fallback promises and no more.
 */
export function pipeSpawner(shell: string = defaultShell()): ShellSpawner {
  return {
    pty: false,
    shell,
    spawn({ cwd, env }) {
      const child = spawnChild(shell, ['-i'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const dataListeners: Array<(data: string) => void> = [];
      const emit = (data: string) => {
        for (const listener of dataListeners) listener(data);
      };
      const toScreen = (chunk: Buffer) => emit(chunk.toString('utf8').replace(/\r?\n/g, '\r\n'));
      child.stdout.on('data', toScreen);
      child.stderr.on('data', toScreen);
      // A write after the shell exited is dropped, not thrown.
      child.stdin.on('error', () => undefined);
      return {
        write(data) {
          const echoed = data.replace(/\r/g, '\r\n').split(DELETE).join('\b \b');
          emit(echoed);
          if (!child.stdin.destroyed) child.stdin.write(data.replace(/\r/g, '\n'));
        },
        resize: () => undefined,
        kill: () => void child.kill('SIGHUP'),
        onData: (listener) => void dataListeners.push(listener),
        onExit: (listener) => void child.on('close', (code) => listener(code)),
      };
    },
  };
}

/** The real PTY when node-pty loads; otherwise the pipe fallback. */
export function hostSpawner(load: () => NodePty | null = loadNodePty): ShellSpawner {
  const pty = load();
  return pty ? ptySpawner(pty) : pipeSpawner();
}
