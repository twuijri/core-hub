/**
 * A client for one program's MCP server over stdio (ADR 0025): the app starts the program as
 * its own child, with an argument array and never a shell, and speaks MCP to it as the MCP
 * specification's stdio transport says — one JSON-RPC message per line on stdin and stdout;
 * stderr is the program's log.
 *
 * The program keeps running between calls (a program session is stateful: an open project, a
 * render in progress). Progress notifications for a call are passed to whoever asked.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { windowsLaunch } from '../shared/windows-command.js';

export const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const LOG_LINES = 40;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<Record<string, unknown>>;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface Progress {
  progress: number;
  total: number | null;
  message: string | null;
}

export interface StdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
}

export class McpProgramError extends Error {
  constructor(
    message: string,
    readonly log: string[] = [],
  ) {
    super(message);
    this.name = 'McpProgramError';
  }
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: Progress) => void;
  progressToken?: string;
};

export class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly log: string[] = [];
  private exited: Error | null = null;
  serverName: string | null = null;

  constructor(
    private readonly launch: StdioLaunch,
    private readonly options: {
      clientVersion: string;
      /** The environment the program inherits (the app's own, PATH above all). */
      baseEnv?: NodeJS.ProcessEnv;
      spawnImpl?: typeof spawn;
      /** Windows finds `npx` and friends itself (`shared/windows-command.ts`). */
      platform?: NodeJS.Platform;
    },
  ) {}

  get running(): boolean {
    return this.child !== null && this.exited === null;
  }

  /** The program's last lines on stderr, for the page when it fails. */
  recentLog(): string[] {
    return [...this.log];
  }

  async start(timeoutMs = 30_000): Promise<void> {
    const run = this.options.spawnImpl ?? spawn;
    const env = { ...(this.options.baseEnv ?? process.env), ...this.launch.env };
    const target =
      (this.options.platform ?? process.platform) === 'win32'
        ? windowsLaunch(this.launch.command, this.launch.args, env, (file) => existsSync(file))
        : { file: this.launch.command, args: this.launch.args, verbatim: false };
    const child = run(target.file, target.args, {
      cwd: this.launch.cwd ?? undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.log.push(line.slice(0, 500));
        if (this.log.length > LOG_LINES) this.log.shift();
      }
    });
    const fail = (error: Error) => {
      if (this.exited) return;
      this.exited = error;
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    };
    child.on('error', (error) => fail(new McpProgramError(error.message, this.recentLog())));
    child.on('exit', (code, signal) =>
      fail(
        new McpProgramError(
          `the program stopped (${signal ?? `exit ${code ?? '?'}`})`,
          this.recentLog(),
        ),
      ),
    );
    const init = await this.request(
      'initialize',
      {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'corehub-desktop', version: this.options.clientVersion },
      },
      { timeoutMs },
    );
    const info = (init.serverInfo ?? {}) as { name?: unknown };
    this.serverName = typeof info.name === 'string' ? info.name : null;
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, {
        timeoutMs: 30_000,
      });
      for (const tool of Array.isArray(result.tools) ? result.tools : []) {
        const t = tool as Record<string, unknown>;
        if (typeof t.name !== 'string') continue;
        tools.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          inputSchema:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? (t.inputSchema as Record<string, unknown>)
              : { type: 'object' },
        });
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: Progress) => void,
  ): Promise<McpCallResult> {
    const token = `corehub-${this.nextId}`;
    const result = await this.request(
      'tools/call',
      { name, arguments: args, _meta: { progressToken: token } },
      { ...(onProgress ? { onProgress } : {}), progressToken: token },
    );
    return {
      content: Array.isArray(result.content)
        ? (result.content as Array<Record<string, unknown>>)
        : [],
      isError: result.isError === true,
      ...(result.structuredContent && typeof result.structuredContent === 'object'
        ? { structuredContent: result.structuredContent as Record<string, unknown> }
        : {}),
    };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || this.exited) return;
    // The stdio transport's shutdown: close its input, then ask it to stop, then make it.
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      setTimeout(() => child.kill('SIGTERM'), 500).unref();
    });
  }

  // ---------------------------------------------------------------- the wire

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.exited) throw this.exited ?? new McpProgramError('not started');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    extra: { timeoutMs?: number; onProgress?: (p: Progress) => void; progressToken?: string } = {},
  ): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = extra.timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(
              new McpProgramError(`the program did not answer ${method} in time`, this.recentLog()),
            );
          }, extra.timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
        ...(extra.onProgress ? { onProgress: extra.onProgress } : {}),
        ...(extra.progressToken ? { progressToken: extra.progressToken } : {}),
      });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
      newline = this.buffer.indexOf('\n');
    }
    // A program that never ends a line must not grow the buffer forever.
    if (this.buffer.length > 16 * 1024 * 1024) this.buffer = '';
  }

  private onMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Not a message: a program that prints to stdout by mistake.
    }
    const id = message.id;
    const method = typeof message.method === 'string' ? message.method : null;
    if (method && id !== undefined && id !== null) {
      // The program asks something of us (ping, roots, sampling): only ping is served.
      if (method === 'ping') this.write({ jsonrpc: '2.0', id, result: {} });
      else
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Core Hub does not offer ${method}` },
        });
      return;
    }
    if (method === 'notifications/progress') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      for (const waiting of this.pending.values()) {
        if (waiting.progressToken && waiting.progressToken === params.progressToken) {
          waiting.onProgress?.({
            progress: typeof params.progress === 'number' ? params.progress : 0,
            total: typeof params.total === 'number' ? params.total : null,
            message: typeof params.message === 'string' ? params.message : null,
          });
        }
      }
      return;
    }
    if (typeof id !== 'number') return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { message?: unknown };
      waiting.reject(
        new McpProgramError(
          typeof error.message === 'string' ? error.message : 'the program refused',
          this.recentLog(),
        ),
      );
      return;
    }
    waiting.resolve((message.result ?? {}) as Record<string, unknown>);
  }
}
