// Finding Hermes on macOS, Windows and Linux, and running its own installer (never ours).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  detectHermes,
  hermesHomeFor,
  hermesInstallerFor,
  pathWithHermes,
  type MachineView,
} from '../../src/shared/hermes-detect.js';
import { installHermes, probeGateway } from '../../src/main/hermes.js';

function machine(
  platform: NodeJS.Platform,
  env: MachineView['env'],
  files: string[],
  dirs: string[] = [],
): MachineView {
  return {
    platform,
    env,
    isFile: (file) => files.includes(file),
    isDirectory: (dir) => dirs.includes(dir),
  };
}

describe('detecting Hermes', () => {
  it('Linux: the per-user install, found even when PATH does not have ~/.local/bin', () => {
    const found = detectHermes(
      machine(
        'linux',
        { HOME: '/home/tariq', PATH: '/usr/bin:/bin' },
        ['/home/tariq/.local/bin/hermes'],
        ['/home/tariq/.hermes'],
      ),
    );
    expect(found.cli).toBe('/home/tariq/.local/bin/hermes');
    expect(found.home).toBe('/home/tariq/.hermes');
    expect(found.searched.slice(0, 2)).toEqual(['/usr/bin/hermes', '/bin/hermes']);
  });

  it('Linux: PATH wins over the known places, and HERMES_HOME names the home', () => {
    const found = detectHermes(
      machine(
        'linux',
        { HOME: '/home/t', PATH: '/opt/tools/bin:relative/bin', HERMES_HOME: '/srv/hermes' },
        ['/opt/tools/bin/hermes', '/home/t/.local/bin/hermes'],
        ['/srv/hermes'],
      ),
    );
    expect(found.cli).toBe('/opt/tools/bin/hermes');
    expect(found.home).toBe('/srv/hermes');
    // A relative PATH entry is never searched: it would depend on the current folder.
    expect(found.searched.some((p) => p.startsWith('relative'))).toBe(false);
  });

  it('Linux: a root install in /usr/local/bin', () => {
    const found = detectHermes(
      machine('linux', { HOME: '/root', PATH: '' }, ['/usr/local/bin/hermes']),
    );
    expect(found.cli).toBe('/usr/local/bin/hermes');
    expect(found.home).toBeNull();
  });

  it('macOS: an app opened from Finder has a bare PATH; Homebrew and ~/.local/bin are checked', () => {
    const view = machine(
      'darwin',
      { HOME: '/Users/tariq', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      ['/opt/homebrew/bin/hermes'],
    );
    const found = detectHermes(view);
    expect(found.cli).toBe('/opt/homebrew/bin/hermes');
    expect(found.searched).toContain('/Users/tariq/.local/bin/hermes');
  });

  it('macOS: the venv inside Hermes’s home, when nothing links it', () => {
    const found = detectHermes(
      machine(
        'darwin',
        { HOME: '/Users/t', PATH: '/usr/bin' },
        ['/Users/t/.hermes/hermes-agent/venv/bin/hermes'],
        ['/Users/t/.hermes'],
      ),
    );
    expect(found.cli).toBe('/Users/t/.hermes/hermes-agent/venv/bin/hermes');
  });

  it('Windows: %LOCALAPPDATA%\\hermes\\bin, with PATHEXT', () => {
    const found = detectHermes(
      machine(
        'win32',
        {
          USERPROFILE: 'C:\\Users\\Tariq',
          LOCALAPPDATA: 'C:\\Users\\Tariq\\AppData\\Local',
          PATH: 'C:\\Windows\\System32;"C:\\Program Files\\Git\\cmd"',
          PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1',
        },
        ['C:\\Users\\Tariq\\AppData\\Local\\hermes\\bin\\hermes.exe'],
        ['C:\\Users\\Tariq\\AppData\\Local\\hermes'],
      ),
    );
    expect(found.cli).toBe('C:\\Users\\Tariq\\AppData\\Local\\hermes\\bin\\hermes.exe');
    expect(found.home).toBe('C:\\Users\\Tariq\\AppData\\Local\\hermes');
    expect(found.searched).toContain('C:\\Program Files\\Git\\cmd\\hermes.exe');
    expect(found.searched.some((p) => p.endsWith('.ps1') || p.endsWith('.com'))).toBe(false);
  });

  it('Windows: a .cmd shim on PATH, and the home from USERPROFILE when LOCALAPPDATA is unset', () => {
    const view = machine('win32', { USERPROFILE: 'C:\\Users\\T', PATH: 'D:\\bin' }, [
      'D:\\bin\\hermes.cmd',
    ]);
    expect(detectHermes(view).cli).toBe('D:\\bin\\hermes.cmd');
    expect(hermesHomeFor(view)).toBe('C:\\Users\\T\\AppData\\Local\\hermes');
  });

  it('says where it looked when there is nothing', () => {
    const found = detectHermes(machine('linux', { HOME: '/home/t', PATH: '/usr/bin' }, []));
    expect(found.cli).toBeNull();
    expect(found.searched).toContain('/home/t/.local/bin/hermes');
  });
});

describe('the hub’s PATH', () => {
  it('puts the found program’s folder first, once', () => {
    expect(
      pathWithHermes('linux', '/home/t/.local/bin/hermes', '/usr/bin:/home/t/.local/bin'),
    ).toBe('/home/t/.local/bin:/usr/bin');
    expect(pathWithHermes('win32', 'C:\\h\\bin\\hermes.exe', 'C:\\Windows')).toBe(
      'C:\\h\\bin;C:\\Windows',
    );
    expect(pathWithHermes('linux', null, '/usr/bin')).toBe('/usr/bin');
  });
});

describe('the official installer', () => {
  it('is Hermes’s own script, run without its setup wizard and without a browser', () => {
    const unix = hermesInstallerFor('darwin');
    expect(unix.url).toBe('https://hermes-agent.nousresearch.com/install.sh');
    expect(unix.args('/tmp/x/install.sh')).toEqual([
      '/tmp/x/install.sh',
      '--non-interactive',
      '--skip-browser',
    ]);
    const windows = hermesInstallerFor('win32');
    expect(windows.url).toBe('https://hermes-agent.nousresearch.com/install.ps1');
    expect(windows.command).toBe('powershell.exe');
    expect(windows.args('C:\\t\\install.ps1')).toContain('-NonInteractive');
  });

  function fakeChild(exitCode: number, lines: string[]) {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough() });
    setTimeout(() => {
      for (const line of lines) stdout.write(`${line}\n`);
      setTimeout(() => child.emit('exit', exitCode, null), 10);
    }, 5);
    return child;
  }

  it('downloads the script, runs it with an argument array and streams plain lines', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const lines: string[] = [];
    const result = await installHermes({
      platform: 'linux',
      fetchImpl: (async () => new Response('#!/bin/bash\necho hi\n')) as unknown as typeof fetch,
      spawnImpl: (command, args) => {
        calls.push({ command, args });
        return fakeChild(0, ['\u001b[32m✓ installed\u001b[0m', '']);
      },
      onLine: (line) => lines.push(line),
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.command).toBe('/bin/bash');
    expect(calls[0]?.args.slice(1)).toEqual(['--non-interactive', '--skip-browser']);
    expect(lines[0]).toContain('install.sh');
    expect(lines).toContain('✓ installed');
  });

  it('reports a failed download or a failed install without running anything else', async () => {
    let spawned = false;
    const refused = await installHermes({
      platform: 'linux',
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
      spawnImpl: () => {
        spawned = true;
        return fakeChild(0, []);
      },
    });
    expect(refused).toEqual({
      ok: false,
      message: 'https://hermes-agent.nousresearch.com/install.sh: HTTP 503',
    });
    expect(spawned).toBe(false);
    const failed = await installHermes({
      platform: 'linux',
      fetchImpl: (async () => new Response('exit 1')) as unknown as typeof fetch,
      spawnImpl: () => fakeChild(1, ['error: uv not found']),
    });
    expect(failed).toEqual({ ok: false, message: 'exit 1' });
  });

  it('asks the gateway port whether a Hermes is already running', async () => {
    expect(await probeGateway((async () => new Response('{}')) as unknown as typeof fetch)).toBe(
      true,
    );
    expect(
      await probeGateway((async () => {
        throw new TypeError('refused');
      }) as unknown as typeof fetch),
    ).toBe(false);
  });
});
