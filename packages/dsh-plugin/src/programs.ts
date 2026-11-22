/**
 * The `apps` answers (ADR 0033 §4): the MCP servers configured in the harness profile are this
 * computer's programs. Each is off until the person picks the hub profiles it serves (the
 * plugin's settings). A call goes through the harness's own MCP manager — the tool the manager's
 * client registered (`mcp__<server>__<tool>`) is executed through the harness's tool registry —
 * so the harness owns the connection, its credentials and its reconnects.
 *
 * As in the desktop app (`apps/desktop/src/main/programs.ts`, ported): the person is asked once
 * per session per program, every call goes into the activity list, and a call still running
 * after the soft deadline answers `running` with a call id that `status` follows.
 */
import { randomBytes } from 'node:crypto';
import type { ConsentGate, ConsentQuestion } from './consent.js';

export const SOFT_DEADLINE_MS = 20_000;
const KEEP_FINISHED_MS = 30 * 60_000;
const MAX_CALLS = 200;
export const PROGRAM_LIMIT = 50;
const PROFILE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ProgramTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface HarnessServer {
  /** The manager's server name (`mcp__<name>__…`). */
  name: string;
  /** `connected`, `connecting`, `disabled`, `failed`, … as the manager says. */
  state: string;
}

/** What the plugin needs from the harness; the plugin wires it to `mcpManager` and `tools`. */
export interface HarnessMcp {
  servers(): HarnessServer[];
  tools(server: string): ProgramTool[];
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ content: Array<Record<string, unknown>>; isError: boolean }>;
}

export interface Program {
  /** The id the hub uses in `apps` requests (`DeviceProgram.id`). */
  id: string;
  server: string;
  state: string;
}

export interface ProgramActivity {
  at: string;
  tool: string;
  target: string | null;
  ok: boolean;
  detail: string | null;
  program: string;
}

export type Progress = { progress: number; total: number | null; message: string | null };

export type CallOutcome =
  | { state: 'done'; content: Array<Record<string, unknown>>; isError: boolean }
  | { state: 'running'; callId: string; progress: Progress | null };

export class ProgramRefusal extends Error {
  constructor(
    readonly code: 'permission_denied' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ProgramRefusal';
  }
}

/** A program id from a server name: lower-case letters, digits, `-` and `_`. */
export function programId(server: string): string {
  const cleaned = server
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 40);
  return cleaned || 'program';
}

/** Server names to program ids, unique (a second `GitHub` beside `github` is `github-2`). */
export function programsOf(servers: readonly HarnessServer[]): Program[] {
  const ids = new Set<string>();
  const out: Program[] = [];
  for (const server of servers.slice(0, PROGRAM_LIMIT)) {
    const base = programId(server.name);
    let id = base;
    for (let n = 2; ids.has(id); n += 1) id = `${base.slice(0, 40)}-${n}`;
    ids.add(id);
    out.push({ id, server: server.name, state: server.state });
  }
  return out;
}

/** The person's choice per server: the hub profiles it serves (empty or absent: off). */
export function cleanProgramProfiles(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [server, profiles] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(server) || !Array.isArray(profiles)) continue;
    const clean = [
      ...new Set(
        profiles.filter((p): p is string => typeof p === 'string' && PROFILE_SLUG.test(p)),
      ),
    ];
    if (clean.length > 0) out[server] = clean;
  }
  return out;
}

interface RunningCall {
  id: string;
  progress: Progress | null;
  result: CallOutcome | null;
  error: Error | null;
  finishedAt: number | null;
}

export interface ProgramHostOptions {
  mcp: HarnessMcp;
  /** Server name → hub profiles (from the settings). */
  profiles(): Record<string, string[]>;
  consent: ConsentGate;
  question(program: Program, tool: string, profile: string | null): ConsentQuestion;
  record(activity: ProgramActivity): void;
  softDeadlineMs?: number;
}

export class ProgramHost {
  private readonly calls = new Map<string, RunningCall>();

  constructor(private readonly options: ProgramHostOptions) {}

  /** Every server the harness knows, as programs. */
  catalogue(): Program[] {
    return programsOf(this.options.mcp.servers());
  }

  /** The program, if it is switched on for this profile (null profile: for any). */
  shared(id: string, profile: string | null): Program | null {
    const program = this.catalogue().find((p) => p.id === id) ?? null;
    if (!program) return null;
    const profiles = this.options.profiles()[program.server] ?? [];
    if (profiles.length === 0) return null;
    if (profile !== null && !profiles.includes(profile)) return null;
    return program;
  }

  /** What the device report says: each switched-on program with its profiles and tools. */
  report(): Array<{ id: string; name: string; profiles: string[]; tools: ProgramTool[] }> {
    const chosen = this.options.profiles();
    return this.catalogue()
      .filter((p) => (chosen[p.server]?.length ?? 0) > 0)
      .map((p) => ({
        id: p.id,
        name: p.server,
        profiles: chosen[p.server] ?? [],
        tools: this.options.mcp.tools(p.server).slice(0, 200),
      }));
  }

  async call(input: {
    programId: string;
    tool: string;
    args: Record<string, unknown>;
    profile: string | null;
  }): Promise<CallOutcome> {
    const at = new Date().toISOString();
    const program = this.shared(input.programId, input.profile);
    const note = (ok: boolean, detail: string | null) =>
      this.options.record({
        at,
        tool: input.tool,
        target: null,
        ok,
        detail,
        program: program?.server ?? input.programId,
      });
    if (!program) {
      const message = `the program "${input.programId}" is not shared with this profile`;
      note(false, message);
      throw new ProgramRefusal('unavailable', message);
    }
    if (!this.options.mcp.tools(program.server).some((t) => t.name === input.tool)) {
      const message = `"${program.server}" has no tool "${input.tool}" now`;
      note(false, message);
      throw new ProgramRefusal('unavailable', message);
    }
    const allowed = await this.options.consent.check(
      this.options.question(program, input.tool, input.profile),
    );
    if (!allowed) {
      note(false, 'declined on this computer');
      throw new ProgramRefusal('permission_denied', 'The person declined on this computer.');
    }
    this.sweep();
    const call: RunningCall = {
      id: randomBytes(12).toString('hex'),
      progress: null,
      result: null,
      error: null,
      finishedAt: null,
    };
    this.calls.set(call.id, call);
    const controller = new AbortController();
    const work = this.options.mcp
      .call(program.server, input.tool, input.args, controller.signal)
      .then(
        (result) => {
          call.result = { state: 'done', content: result.content, isError: result.isError };
          call.finishedAt = Date.now();
          note(!result.isError, result.isError ? firstText(result.content) : null);
          return call.result;
        },
        (error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          call.error = err;
          call.finishedAt = Date.now();
          note(false, err.message);
          throw new ProgramRefusal('failed', err.message);
        },
      );
    let timer: NodeJS.Timeout | undefined;
    const soon = new Promise<'running'>((resolve) => {
      timer = setTimeout(() => resolve('running'), this.options.softDeadlineMs ?? SOFT_DEADLINE_MS);
    });
    try {
      const first = await Promise.race([work, soon]);
      if (first === 'running') {
        work.catch(() => undefined);
        return { state: 'running', callId: call.id, progress: call.progress };
      }
      return first;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status(callId: string): CallOutcome {
    const call = this.calls.get(callId);
    if (!call) throw new ProgramRefusal('unavailable', 'There is no such call on this computer.');
    if (call.error) throw new ProgramRefusal('failed', call.error.message);
    if (call.result) return call.result;
    return { state: 'running', callId: call.id, progress: call.progress };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, call] of this.calls) {
      if (call.finishedAt !== null && now - call.finishedAt > KEEP_FINISHED_MS)
        this.calls.delete(id);
    }
    while (this.calls.size > MAX_CALLS) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
  }
}

function firstText(content: Array<Record<string, unknown>>): string | null {
  const text = content.find((c) => c.type === 'text' && typeof c.text === 'string');
  return text ? String(text.text).slice(0, 300) : null;
}
