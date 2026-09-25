// The owner's terminal sessions without a real shell: the cap, the idle timeout, what a
// reattaching page gets back, and that one person's session is invisible to anyone else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';
import { HubError } from '../../lib/errors.js';
import { BACKLOG_LIMIT, TerminalManager, type ExitReason } from './manager.js';
import { defaultShell, pipeSpawner, shellEnv } from './shell.js';
import type { ShellProcess, ShellSpawner } from './shell.js';
import { terminalModule } from './index.js';

interface FakeShell extends ShellProcess {
  written: string[];
  killed: boolean;
  size: [number, number];
  print(data: string): void;
  exit(code: number): void;
}

function fakeSpawner(): ShellSpawner & { shells: FakeShell[] } {
  const shells: FakeShell[] = [];
  return {
    pty: true,
    shell: '/bin/fake',
    shells,
    spawn({ cols, rows }) {
      let onData: (data: string) => void = () => undefined;
      let onExit: (code: number | null) => void = () => undefined;
      const shell: FakeShell = {
        written: [],
        killed: false,
        size: [cols, rows],
        write: (data) => void shell.written.push(data),
        resize: (c, r) => void (shell.size = [c, r]),
        kill: () => void (shell.killed = true),
        onData: (listener) => void (onData = listener),
        onExit: (listener) => void (onExit = listener),
        print: (data) => onData(data),
        exit: (code) => onExit(code),
      };
      shells.push(shell);
      return shell;
    },
  };
}

const IDLE = 15 * 60_000;
const OWNER = '01J8QK3ZR2W7M5N4P6T8V9X0OW';
const where = { ownerId: OWNER, workspaceId: 'ws', profile: 'default', cwd: '/data/workspaces/default' };

describe('module: terminal', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(terminalModule);
  });
});

describe('terminal sessions', () => {
  let spawner: ReturnType<typeof fakeSpawner>;
  let closed: Array<{ id: string; reason: ExitReason; code: number | null }>;
  let output: string[];
  let manager: TerminalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    spawner = fakeSpawner();
    closed = [];
    output = [];
    manager = new TerminalManager({
      spawner,
      idleMs: IDLE,
      maxSessions: 3,
      env: {},
      events: {
        output: (_session, data) => void output.push(data),
        closed: (session, reason, code) => void closed.push({ id: session.id, reason, code }),
      },
    });
  });
  afterEach(() => {
    manager.closeAll();
    vi.useRealTimers();
  });

  it('runs at most three at once; the fourth is refused with conflict until one closes', () => {
    const first = manager.open(where);
    manager.open(where);
    manager.open(where);
    let refusal: unknown;
    try {
      manager.open(where);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HubError);
    expect((refusal as HubError).code).toBe('conflict');
    expect((refusal as HubError).details).toEqual({ reason: 'terminal_limit', max_sessions: 3 });
    expect(spawner.shells).toHaveLength(3);

    expect(manager.close(OWNER, first.id)).toBe(true);
    expect(manager.open(where).id).not.toBe(first.id);
    expect(manager.size).toBe(3);
  });

  it('closes a session nobody typed into for the idle timeout, and kills its shell', () => {
    const session = manager.open(where);
    vi.advanceTimersByTime(IDLE - 1);
    expect(manager.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(manager.size).toBe(0);
    expect(closed).toEqual([{ id: session.id, reason: 'idle', code: null }]);
    expect(spawner.shells[0]!.killed).toBe(true);
  });

  it('typing, resizing and reattaching count as activity; output alone does not', () => {
    const session = manager.open(where);
    vi.advanceTimersByTime(IDLE - 1_000);
    manager.input(OWNER, session.id, 'ls\r');
    vi.advanceTimersByTime(IDLE - 1_000);
    manager.resize(OWNER, session.id, 100, 30);
    vi.advanceTimersByTime(IDLE - 1_000);
    manager.attach(OWNER, session.id);
    vi.advanceTimersByTime(IDLE - 1_000);
    expect(manager.size).toBe(1);
    // A program that keeps printing (`tail -f`) is not somebody at the keyboard.
    spawner.shells[0]!.print('still here\r\n');
    vi.advanceTimersByTime(1_000);
    expect(closed.map((c) => c.reason)).toEqual(['idle']);
    expect(spawner.shells[0]!.written).toEqual(['ls\r']);
    expect(spawner.shells[0]!.size).toEqual([100, 30]);
  });

  it("keeps the tail of the output for a page that reattaches, and ends on the shell's exit", () => {
    const session = manager.open(where);
    spawner.shells[0]!.print('a'.repeat(BACKLOG_LIMIT));
    spawner.shells[0]!.print('hi\r\n');
    const attached = manager.attach(OWNER, session.id)!;
    expect(attached.backlog).toHaveLength(BACKLOG_LIMIT);
    expect(attached.backlog.endsWith('hi\r\n')).toBe(true);
    expect(output).toHaveLength(2);

    spawner.shells[0]!.exit(0);
    expect(closed).toEqual([{ id: session.id, reason: 'exited', code: 0 }]);
    expect(spawner.shells[0]!.killed).toBe(false);
    expect(manager.attach(OWNER, session.id)).toBeNull();
    expect(manager.input(OWNER, session.id, 'x')).toBe(false);
  });

  it("another person's id finds nothing: not listed, not attached, not typed into, not closed", () => {
    const session = manager.open(where);
    const other = '01J8QK3ZR2W7M5N4P6T8V9X0XX';
    expect(manager.list(other)).toEqual([]);
    expect(manager.get(other, session.id)).toBeNull();
    expect(manager.attach(other, session.id)).toBeNull();
    expect(manager.input(other, session.id, 'rm -rf /\r')).toBe(false);
    expect(manager.close(other, session.id)).toBe(false);
    expect(spawner.shells[0]!.written).toEqual([]);
    expect(manager.list(OWNER).map((s) => s.id)).toEqual([session.id]);
  });

  it('clamps a size to what a terminal can be, and stops every session when the hub stops', () => {
    const session = manager.open({ ...where, cols: 99_999, rows: -4 });
    expect([session.cols, session.rows]).toEqual([500, 2]);
    manager.open(where);
    manager.closeAll();
    expect(closed.map((c) => c.reason)).toEqual(['shutdown', 'shutdown']);
    expect(spawner.shells.every((shell) => shell.killed)).toBe(true);
  });
});

describe('the shell a session runs', () => {
  it('inherits only the listed variables: never the admin password or a database URL', () => {
    const env = shellEnv({
      PATH: '/usr/bin',
      HOME: '/home/hub',
      HERMES_HOME: '/data/hermes',
      HUB_ADMIN_PASSWORD: 'secret-owner-password',
      DATABASE_URL: 'postgres://u:p@db/hub',
      OPENAI_API_KEY: 'sk-secret',
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/hub',
      HERMES_HOME: '/data/hermes',
      TERM: 'xterm-256color',
      COREHUB_TERMINAL: '1',
    });
    expect(Object.values(env).join(' ')).not.toMatch(/secret|postgres/);
  });

  it('prefers bash, falling back to sh', () => {
    expect(defaultShell(() => true)).toBe('/bin/bash');
    expect(defaultShell(() => false)).toBe('/bin/sh');
  });

  it('the fallback without a PTY still runs a command and prints what it said', async () => {
    vi.useRealTimers();
    const spawner = pipeSpawner('/bin/sh');
    expect(spawner.pty).toBe(false);
    const shell = spawner.spawn({ cwd: '/', cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } });
    let seen = '';
    const exited = new Promise<number | null>((resolve) => shell.onExit(resolve));
    shell.onData((data) => void (seen += data));
    shell.write('echo from-the-pipe\r');
    shell.write('exit 3\r');
    expect(await exited).toBe(3);
    // Once as the echo of what was typed, once as what `echo` printed.
    expect(seen.split('from-the-pipe\r\n').length).toBeGreaterThanOrEqual(3);
  });
});
