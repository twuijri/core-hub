/**
 * Runs the programs the person switched on (ADR 0025): each one's MCP server is started as a
 * child of the app the first time an agent uses it, kept running between calls (a program
 * session is stateful), and stopped when the program is switched off or the app quits.
 *
 * Every call goes through here, from the hub on this computer (the helper, local mode) or from
 * a hub elsewhere (a device request): the profile must be one the program is on for, the person
 * is asked once per session, and the call goes into the activity list.
 *
 * A call that is still running after `softDeadlineMs` answers "running" with a call id; the
 * program carries on, and `status(callId)` says how it stands (a render takes minutes; a
 * device request waits seconds).
 */
import { randomBytes } from 'node:crypto';
import type { ConsentGate } from './consent.js';
import {
  StdioMcpClient,
  type McpCallResult,
  type McpTool,
  type Progress,
  type StdioLaunch,
} from './mcp-stdio.js';
import { launchOf, type DiscoveredProgram } from '../shared/programs.js';
import type { ProgramSettings, ProgramToolSnapshot } from '../shared/helper.js';

export const SOFT_DEADLINE_MS = 20_000;
/** A finished call's result is kept this long for `status`. */
const KEEP_FINISHED_MS = 30 * 60_000;
const MAX_CALLS = 200;

export interface ProgramActivity {
  at: string;
  tool: string;
  target: string | null;
  ok: boolean;
  detail: string | null;
  program: string;
  via: 'local' | 'hub';
}

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

interface RunningCall {
  id: string;
  programId: string;
  tool: string;
  progress: Progress | null;
  result: CallOutcome | null;
  error: Error | null;
  finishedAt: number | null;
}

export interface ProgramHostOptions {
  /** What discovery found last. */
  catalogue(): DiscoveredProgram[];
  /** The person's choices, by program id. */
  settings(): Record<string, ProgramSettings>;
  /** A saved value in clear (the OS keychain opens it). */
  unseal(value: string): string;
  clientVersion: string;
  consent: ConsentGate;
  record(activity: ProgramActivity): void;
  /** A program listed its tools: kept, so the hub can list them without starting it. */
  onTools(programId: string, tools: ProgramToolSnapshot[]): void;
  softDeadlineMs?: number;
  /** Tests start a fake program; the app starts the real one. */
  makeClient?: (launch: StdioLaunch) => StdioMcpClient;
  baseEnv?: NodeJS.ProcessEnv;
}

export class ProgramHost {
  private readonly clients = new Map<string, StdioMcpClient>();
  private readonly starting = new Map<string, Promise<StdioMcpClient>>();
  private readonly calls = new Map<string, RunningCall>();

  constructor(private readonly options: ProgramHostOptions) {}

  /** The program, if it is switched on for this profile (null: for any profile). */
  shared(programId: string, profile: string | null): DiscoveredProgram | null {
    const program = this.options.catalogue().find((p) => p.id === programId) ?? null;
    const settings = this.options.settings()[programId];
    if (!program || !settings || settings.profiles.length === 0) return null;
    if (profile !== null && !settings.profiles.includes(profile)) return null;
    return program;
  }

  /** Programs switched on for this profile, with their tools as last listed. */
  available(
    profile: string | null,
  ): Array<{ program: DiscoveredProgram; tools: ProgramToolSnapshot[] }> {
    const settings = this.options.settings();
    return this.options
      .catalogue()
      .filter((program) => this.shared(program.id, profile))
      .map((program) => ({ program, tools: settings[program.id]?.tools ?? [] }));
  }

  running(programId: string): boolean {
    return this.clients.get(programId)?.running ?? false;
  }

  /** Starts the program if it is not running, and lists its tools (kept for the hub). */
  async listTools(programId: string): Promise<McpTool[]> {
    const client = await this.client(programId);
    const tools = await client.listTools();
    this.options.onTools(
      programId,
      tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    );
    return tools;
  }

  /** One tool call, as the person allowed it. */
  async call(input: {
    programId: string;
    tool: string;
    args: Record<string, unknown>;
    profile: string | null;
    via: 'local' | 'hub';
    hub: string | null;
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
        program: program?.name ?? input.programId,
        via: input.via,
      });
    if (!program) {
      const message = `the program "${input.programId}" is not shared with this profile`;
      note(false, message);
      throw new ProgramRefusal('unavailable', message);
    }
    const allowed = await this.options.consent.check({
      programId: program.id,
      programName: program.name,
      tool: input.tool,
      via: input.via,
      hub: input.hub,
      profile: input.profile,
    });
    if (!allowed) {
      note(false, 'declined on this computer');
      throw new ProgramRefusal('permission_denied', 'The person declined on this computer.');
    }
    let client: StdioMcpClient;
    try {
      client = await this.client(program.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(false, message);
      throw new ProgramRefusal('failed', message);
    }
    this.sweep();
    const call: RunningCall = {
      id: randomBytes(12).toString('hex'),
      programId: program.id,
      tool: input.tool,
      progress: null,
      result: null,
      error: null,
      finishedAt: null,
    };
    this.calls.set(call.id, call);
    const work = client
      .callTool(input.tool, input.args, (progress) => {
        call.progress = progress;
      })
      .then(
        (result: McpCallResult) => {
          call.result = { state: 'done', content: result.content, isError: result.isError };
          call.finishedAt = Date.now();
          note(!result.isError, result.isError ? firstText(result.content) : null);
          return call.result;
        },
        (error: Error) => {
          call.error = error;
          call.finishedAt = Date.now();
          note(false, error.message);
          throw new ProgramRefusal('failed', error.message);
        },
      );
    const deadline = this.options.softDeadlineMs ?? SOFT_DEADLINE_MS;
    let timer: NodeJS.Timeout | undefined;
    const soon = new Promise<'running'>((resolve) => {
      timer = setTimeout(() => resolve('running'), deadline);
    });
    try {
      const first = await Promise.race([work, soon]);
      if (first === 'running') {
        // It goes on; whoever asked follows it with `status`.
        work.catch(() => undefined);
        return { state: 'running', callId: call.id, progress: call.progress };
      }
      return first;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** How a long call stands; its result once it finished. */
  status(callId: string): CallOutcome {
    const call = this.calls.get(callId);
    if (!call) throw new ProgramRefusal('unavailable', 'There is no such call on this computer.');
    if (call.error) throw new ProgramRefusal('failed', call.error.message);
    if (call.result) return call.result;
    return { state: 'running', callId: call.id, progress: call.progress };
  }

  /** Switched off, or its settings changed: its process goes (it starts again when used). */
  async stop(programId: string): Promise<void> {
    const client = this.clients.get(programId);
    this.clients.delete(programId);
    this.options.consent.forget(programId);
    await client?.close();
  }

  async stopAll(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private async client(programId: string): Promise<StdioMcpClient> {
    const existing = this.clients.get(programId);
    if (existing?.running) return existing;
    const pending = this.starting.get(programId);
    if (pending) return pending;
    const program = this.options.catalogue().find((p) => p.id === programId);
    if (!program) throw new Error(`no program "${programId}" on this computer`);
    const settings = this.options.settings()[programId];
    const values = Object.fromEntries(
      Object.entries(settings?.values ?? {}).map(([key, sealed]) => [
        key,
        this.options.unseal(sealed),
      ]),
    );
    const launch = launchOf(program, values);
    if (!launch) throw new Error(`"${program.name}" needs its settings first`);
    const start = (async () => {
      const client =
        this.options.makeClient?.(launch) ??
        new StdioMcpClient(launch, {
          clientVersion: this.options.clientVersion,
          ...(this.options.baseEnv ? { baseEnv: this.options.baseEnv } : {}),
        });
      await client.start();
      this.clients.set(programId, client);
      return client;
    })();
    this.starting.set(programId, start);
    try {
      return await start;
    } finally {
      this.starting.delete(programId);
    }
  }

  private sweep(): void {
    const at = Date.now();
    for (const [id, call] of this.calls) {
      if (call.finishedAt !== null && at - call.finishedAt > KEEP_FINISHED_MS)
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
