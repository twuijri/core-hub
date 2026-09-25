/**
 * Is Hermes Agent already on this computer? (ADR 0008, ADR 0009.)
 *
 * The desktop app never carries Hermes. In local mode it looks for the one the person
 * installed with Hermes's own installer, and hands the embedded hub its program. Where that
 * installer puts things (hermes-agent.nousresearch.com/docs/getting-started/installation,
 * and the installers themselves):
 *
 *   Linux, macOS  per user   program  ~/.local/bin/hermes        home  ~/.hermes
 *                 as root             /usr/local/bin/hermes            /root/.hermes
 *   Windows       per user   program  %LOCALAPPDATA%\hermes\bin   home  %LOCALAPPDATA%\hermes
 *   any                      HERMES_HOME overrides the home
 *
 * An app started from the Dock, Finder or the Start menu does not get the PATH a terminal
 * has, so the known places are checked as well as PATH. Everything here is pure over an
 * injected view of the machine, so the three layouts are tested on any one of them.
 */
import path from 'node:path';

export interface MachineView {
  platform: NodeJS.Platform;
  env: {
    HOME?: string | undefined;
    USERPROFILE?: string | undefined;
    LOCALAPPDATA?: string | undefined;
    HERMES_HOME?: string | undefined;
    PATH?: string | undefined;
    PATHEXT?: string | undefined;
  };
  isFile(file: string): boolean;
  isDirectory(dir: string): boolean;
}

export interface HermesInstall {
  /** The `hermes` program, or null when none was found. */
  cli: string | null;
  /** Hermes's own home directory when it exists (config, keys, memory). */
  home: string | null;
  /** Every place that was looked at, in order — shown when nothing is found. */
  searched: string[];
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Where Hermes keeps its home on this machine (whether or not it exists yet). */
export function hermesHomeFor(view: MachineView): string | null {
  const p = pathApi(view.platform);
  if (view.env.HERMES_HOME) return view.env.HERMES_HOME;
  if (view.platform === 'win32') {
    const local =
      view.env.LOCALAPPDATA ??
      (view.env.USERPROFILE ? p.join(view.env.USERPROFILE, 'AppData', 'Local') : undefined);
    return local ? p.join(local, 'hermes') : null;
  }
  return view.env.HOME ? p.join(view.env.HOME, '.hermes') : null;
}

function executableNames(view: MachineView): string[] {
  if (view.platform !== 'win32') return ['hermes'];
  const exts = (view.env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e === '.exe' || e === '.cmd' || e === '.bat');
  return (exts.length > 0 ? exts : ['.exe', '.cmd']).map((ext) => `hermes${ext}`);
}

/** The places Hermes's installers put the program, after PATH. */
export function knownProgramDirs(view: MachineView, home: string | null): string[] {
  const p = pathApi(view.platform);
  const dirs: string[] = [];
  if (view.platform === 'win32') {
    const local =
      view.env.LOCALAPPDATA ??
      (view.env.USERPROFILE ? p.join(view.env.USERPROFILE, 'AppData', 'Local') : undefined);
    if (local) dirs.push(p.join(local, 'hermes', 'bin'));
    if (home) dirs.push(p.join(home, 'hermes-agent', 'venv', 'Scripts'));
    return dirs;
  }
  if (view.env.HOME) dirs.push(p.join(view.env.HOME, '.local', 'bin'));
  dirs.push('/usr/local/bin');
  if (view.platform === 'darwin') dirs.push('/opt/homebrew/bin');
  if (home) {
    dirs.push(p.join(home, 'hermes-agent', 'venv', 'bin'));
    dirs.push(p.join(home, 'hermes-agent', '.venv', 'bin'));
  }
  return dirs;
}

export function detectHermes(view: MachineView): HermesInstall {
  const p = pathApi(view.platform);
  const home = hermesHomeFor(view);
  const separator = view.platform === 'win32' ? ';' : ':';
  const fromPath = (view.env.PATH ?? '')
    .split(separator)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && p.isAbsolute(dir));
  const dirs = [...new Set([...fromPath, ...knownProgramDirs(view, home)])];
  const names = executableNames(view);
  const searched: string[] = [];
  let cli: string | null = null;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      searched.push(candidate);
      if (view.isFile(candidate)) {
        cli = candidate;
        break;
      }
    }
    if (cli) break;
  }
  return { cli, home: home && view.isDirectory(home) ? home : null, searched };
}

/** The PATH the embedded hub gets: the found program's folder first, then the app's own. */
export function pathWithHermes(
  platform: NodeJS.Platform,
  cli: string | null,
  current: string | undefined,
): string {
  const separator = platform === 'win32' ? ';' : ':';
  const parts = (current ?? '').split(separator).filter(Boolean);
  if (!cli) return parts.join(separator);
  const dir = pathApi(platform).dirname(cli);
  return [dir, ...parts.filter((part) => part !== dir)].join(separator);
}

/** Hermes's official installer for this platform (never a copy of our own). */
export interface HermesInstaller {
  url: string;
  /** The program that runs the downloaded script, and its arguments after the script path. */
  command: string;
  args(script: string): string[];
  /** What the person is shown before anything runs. */
  display: string;
}

export const HERMES_INSTALL_DOCS =
  'https://hermes-agent.nousresearch.com/docs/getting-started/installation';

export function hermesInstallerFor(platform: NodeJS.Platform): HermesInstaller {
  if (platform === 'win32') {
    const url = 'https://hermes-agent.nousresearch.com/install.ps1';
    return {
      url,
      command: 'powershell.exe',
      // -NonInteractive skips the installer's setup wizard: keys are set in Core Hub.
      args: (script) => [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-NonInteractive',
        '-SkipBrowser',
      ],
      display: `iex (irm ${url})  -NonInteractive -SkipBrowser`,
    };
  }
  const url = 'https://hermes-agent.nousresearch.com/install.sh';
  return {
    url,
    command: '/bin/bash',
    args: (script) => [script, '--non-interactive', '--skip-browser'],
    display: `curl -fsSL ${url} | bash -s -- --non-interactive --skip-browser`,
  };
}
