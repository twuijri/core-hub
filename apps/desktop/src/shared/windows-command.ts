/**
 * Starting a program the way another assistant's registration names it, on Windows (ADR 0025).
 *
 * A registration says `npx`, `uvx` or `node`; Windows finds programs through `PATH` and
 * `PATHEXT`, and many of them (`npx`) are `.cmd` scripts, which Node refuses to start without
 * a shell. The app still never builds a shell string from what it was given: it finds the
 * file itself, starts an `.exe` directly, and starts a `.cmd`/`.bat` through `cmd.exe /d /s /c`
 * with every argument quoted for the C runtime and every `cmd.exe` special character escaped,
 * so nothing in an argument can run as a command.
 *
 * On macOS and Linux the program is started as it is (the OS searches `PATH`).
 */
import path from 'node:path';

export interface Launchable {
  file: string;
  args: string[];
  /** Hand `args` to the process as they are (already quoted for `cmd.exe`). */
  verbatim: boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Where a command is on Windows: its own path when it has one, else the first match on PATH. */
export function findOnWindows(
  command: string,
  env: Record<string, string | undefined>,
  exists: (file: string) => boolean,
): string | null {
  const exts = (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const hasExt = exts.includes(path.win32.extname(command).toLowerCase());
  const names = hasExt ? [command] : [...exts.map((ext) => `${command}${ext}`), command];
  const hasDir = /[\\/]/.test(command) || path.win32.isAbsolute(command);
  const dirs = hasDir
    ? ['']
    : (env.PATH ?? env.Path ?? '').split(';').filter((dir) => dir.trim() !== '');
  for (const dir of dirs) {
    for (const name of names) {
      const file = dir ? path.win32.join(dir, name) : name;
      if (exists(file)) return file;
    }
  }
  return null;
}

/** One argument as the C runtime reads it back: quoted, inner quotes and backslashes kept. */
export function quoteForCRuntime(arg: string): string {
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      // Backslashes before a quote are doubled, and the quote itself escaped.
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + char;
    }
    slashes = 0;
  }
  // Backslashes before the closing quote are doubled so they do not escape it.
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** Every character `cmd.exe` would act on, made literal with `^`. */
export function escapeForCmd(text: string): string {
  return text.replace(/[()[\]%!^"`<>&|;, *?]/g, (char) => `^${char}`);
}

export function windowsLaunch(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  exists: (file: string) => boolean,
): Launchable {
  const found = findOnWindows(command, env, exists) ?? command;
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args, verbatim: false };
  // An npm shim runs its own `cmd` line again, so its arguments need a second escape.
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const escape = (value: string) => {
    const once = escapeForCmd(quoteForCRuntime(value));
    return twice ? escapeForCmd(once) : once;
  };
  const line = [escapeForCmd(quoteForCRuntime(found)), ...args.map(escape)].join(' ');
  return {
    file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}
