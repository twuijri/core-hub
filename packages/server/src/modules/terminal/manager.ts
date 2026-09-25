/**
 * The owner's live terminal sessions, in memory.
 *
 * A session is a shell process and a little state around it: who opened it, in which profile's
 * folder, its size, when someone last typed, and the tail of what it printed (so a page that
 * reloads can repaint the screen before new output arrives). It belongs to the owner, not to a
 * socket: closing the tab does not end it; nobody typing for `idleMs` does, and so do `close`,
 * the shell exiting, and the hub stopping. At most `maxSessions` run at once.
 *
 * Nothing here knows about Socket.IO or the audit log: the module wires `events` to both.
 */
import { newUlid } from '../../db/ids.js';
import { HubError } from '../../lib/errors.js';
import type { ShellProcess, ShellSpawner } from './shell.js';

export type ExitReason = 'exited' | 'closed' | 'idle' | 'shutdown';

export interface TerminalSession {
  id: string;
  ownerId: string;
  workspaceId: string;
  profile: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  lastActiveAt: number;
}

export interface ManagerEvents {
  output(session: TerminalSession, data: string): void;
  closed(session: TerminalSession, reason: ExitReason, exitCode: number | null): void;
}

export interface ManagerOptions {
  spawner: ShellSpawner;
  idleMs: number;
  maxSessions: number;
  env: Record<string, string>;
  events: ManagerEvents;
  now?: () => number;
}

/** How much recent output a session keeps for a reattaching page (characters). */
export const BACKLOG_LIMIT = 64 * 1024;

export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 2;
export const MAX_ROWS = 200;

interface Live {
  session: TerminalSession;
  process: ShellProcess;
  backlog: string;
  timer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const whole = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.floor(value)))
      : fallback;
  return {
    cols: whole(cols, 80, MIN_COLS, MAX_COLS),
    rows: whole(rows, 24, MIN_ROWS, MAX_ROWS),
  };
}

export class TerminalManager {
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;

  constructor(private readonly options: ManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  get pty(): boolean {
    return this.options.spawner.pty;
  }

  get shell(): string {
    return this.options.spawner.shell;
  }

  get idleMs(): number {
    return this.options.idleMs;
  }

  get maxSessions(): number {
    return this.options.maxSessions;
  }

  /** Starts a shell, or refuses with `conflict` when `maxSessions` already run. */
  open(input: {
    ownerId: string;
    workspaceId: string;
    profile: string;
    cwd: string;
    cols?: unknown;
    rows?: unknown;
  }): TerminalSession {
    if (this.live.size >= this.options.maxSessions) {
      throw new HubError('conflict', {
        messageKey: 'terminal.limit',
        details: { reason: 'terminal_limit', max_sessions: this.options.maxSessions },
      });
    }
    const { cols, rows } = clampSize(input.cols, input.rows);
    const at = this.now();
    const session: TerminalSession = {
      id: newUlid(at),
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      cwd: input.cwd,
      cols,
      rows,
      startedAt: at,
      lastActiveAt: at,
    };
    const process = this.options.spawner.spawn({
      cwd: input.cwd,
      cols,
      rows,
      env: this.options.env,
    });
    const entry: Live = { session, process, backlog: '', timer: null, ended: false };
    this.live.set(session.id, entry);
    process.onData((data) => {
      if (entry.ended) return;
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_LIMIT);
      this.options.events.output(session, data);
    });
    process.onExit((exitCode) => this.end(entry, 'exited', exitCode));
    this.arm(entry);
    return session;
  }

  /** The owner's live sessions, oldest first. */
  list(ownerId: string): TerminalSession[] {
    return [...this.live.values()]
      .map((entry) => entry.session)
      .filter((session) => session.ownerId === ownerId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** One live session of this owner, or null — another person's is as unknown as a gone one. */
  get(ownerId: string, id: string): TerminalSession | null {
    const entry = this.live.get(id);
    return entry && entry.session.ownerId === ownerId ? entry.session : null;
  }

  /** Counts as activity; returns the recent output to repaint with. */
  attach(ownerId: string, id: string): { session: TerminalSession; backlog: string } | null {
    const entry = this.entry(ownerId, id);
    if (!entry) return null;
    this.touch(entry);
    return { session: entry.session, backlog: entry.backlog };
  }

  input(ownerId: string, id: string, data: string): boolean {
    const entry = this.entry(ownerId, id);
    if (!entry) return false;
    this.touch(entry);
    entry.process.write(data);
    return true;
  }

  resize(ownerId: string, id: string, cols: unknown, rows: unknown): boolean {
    const entry = this.entry(ownerId, id);
    if (!entry) return false;
    const size = clampSize(cols, rows);
    entry.session.cols = size.cols;
    entry.session.rows = size.rows;
    this.touch(entry);
    entry.process.resize(size.cols, size.rows);
    return true;
  }

  close(ownerId: string, id: string): boolean {
    const entry = this.entry(ownerId, id);
    if (!entry) return false;
    this.end(entry, 'closed', null);
    return true;
  }

  /** Every session, when the hub stops. */
  closeAll(reason: ExitReason = 'shutdown'): void {
    for (const entry of [...this.live.values()]) this.end(entry, reason, null);
  }

  get size(): number {
    return this.live.size;
  }

  private entry(ownerId: string, id: string): Live | null {
    const entry = this.live.get(id);
    return entry && !entry.ended && entry.session.ownerId === ownerId ? entry : null;
  }

  private touch(entry: Live): void {
    entry.session.lastActiveAt = this.now();
    this.arm(entry);
  }

  /** (Re)starts the idle countdown. `unref`: a quiet terminal never keeps a process alive. */
  private arm(entry: Live): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.end(entry, 'idle', null), this.options.idleMs);
    entry.timer.unref?.();
  }

  private end(entry: Live, reason: ExitReason, exitCode: number | null): void {
    if (entry.ended) return;
    entry.ended = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.live.delete(entry.session.id);
    if (reason !== 'exited') {
      try {
        entry.process.kill();
      } catch {
        // Already gone: the end is the same.
      }
    }
    this.options.events.closed(entry.session, reason, exitCode);
  }
}
