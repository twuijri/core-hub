/**
 * The local helper (ADR 0009, ADR 0022): an MCP server inside the desktop app that lets an
 * agent use this computer — only the folders the person chose, and only as they allowed.
 *
 * Transport: MCP's Streamable HTTP, the plain-JSON half of it (a POST carries a JSON-RPC
 * message and gets a JSON answer; no server-initiated stream is needed for tools). It listens
 * on 127.0.0.1 only, wants the helper's bearer token on every request, refuses any request a
 * web page could make (an `Origin` header, or a `Host` that is not this address), and is off
 * until the person turns it on. What it did is kept in a short in-memory log the page shows.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { resolveInside, type HelperConfig, type Resolved } from '../shared/helper.js';
import { helperToolName } from '../shared/programs.js';
import { ProgramRefusal, type CallOutcome, type ProgramHost } from './programs.js';

export const MCP_PATH = '/mcp';
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MAX_BODY = 2 * 1024 * 1024;
const READ_DEFAULT = 256 * 1024;
const READ_MAX = 1024 * 1024;
const WRITE_MAX = 1024 * 1024;
const LIST_MAX = 500;
const LOG_MAX = 50;

export interface HelperActivity {
  at: string;
  tool: string;
  /** The path or link the tool was asked about, when there was one. */
  target: string | null;
  ok: boolean;
  /** Why it was refused or failed. */
  detail: string | null;
  /** The program the call went to, for a program's tool. */
  program?: string | null;
  /** Who asked: the hub on this computer, or a hub elsewhere through the device connection. */
  via?: 'local' | 'hub';
}

export interface HelperEnv {
  /** Opens a file or folder with its default app (`shell.openPath`); '' on success. */
  openPath(file: string): Promise<string>;
  /** Opens an http(s) link in the default browser (`shell.openExternal`). */
  openUrl(url: string): Promise<void>;
  realpath?: (p: string) => string | null;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** The tools this configuration exposes — exactly what the permission screen lists. */
export function toolsFor(config: HelperConfig): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'list_allowed_folders',
      description:
        'List the folders on this computer that the person shared, and whether each is read-only or writable.',
      inputSchema: obj({}),
    },
    {
      name: 'list_directory',
      description: 'List the files and folders inside a shared folder (or a folder below it).',
      inputSchema: obj({ path: { type: 'string', description: 'Absolute path' } }, ['path']),
    },
    {
      name: 'read_text_file',
      description: 'Read a text file inside a shared folder (up to 1 MB).',
      inputSchema: obj(
        {
          path: { type: 'string', description: 'Absolute path' },
          max_bytes: { type: 'integer', minimum: 1, maximum: READ_MAX },
        },
        ['path'],
      ),
    },
  ];
  if (config.folders.some((f) => f.write))
    tools.push({
      name: 'write_text_file',
      description:
        'Write a text file inside a folder the person shared as writable. Refuses to replace an existing file unless overwrite is true.',
      inputSchema: obj(
        {
          path: { type: 'string', description: 'Absolute path' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        ['path', 'content'],
      ),
    });
  if (config.allowOpen)
    tools.push(
      {
        name: 'open_path',
        description:
          'Open a file or folder inside a shared folder with its default application on this computer.',
        inputSchema: obj({ path: { type: 'string', description: 'Absolute path' } }, ['path']),
      },
      {
        name: 'open_url',
        description: 'Open an http or https link in the default browser on this computer.',
        inputSchema: obj({ url: { type: 'string' } }, ['url']),
      },
    );
  return tools;
}

class ToolError extends Error {}

function defaultRealpath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

const REASON: Record<Exclude<Resolved, { ok: true }>['reason'], string> = {
  outside: 'That path is not inside a folder shared with the helper.',
  missing: 'That path does not exist.',
  read_only: 'That folder is shared read-only.',
};

/** Runs one tool call against the current configuration. Pure apart from the file system. */
export async function callTool(
  config: HelperConfig,
  env: HelperEnv,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; target: string | null }> {
  const realpath = env.realpath ?? defaultRealpath;
  const allowed = toolsFor(config).some((tool) => tool.name === name);
  if (!allowed) throw new ToolError(`The helper does not offer "${name}" now.`);
  const inside = (value: unknown, forWrite = false) => {
    const resolved = resolveInside(config.folders, String(value ?? ''), { realpath, forWrite });
    if (!resolved.ok) throw new ToolError(REASON[resolved.reason]);
    return resolved.path;
  };
  switch (name) {
    case 'list_allowed_folders':
      return {
        target: null,
        text: JSON.stringify(
          config.folders.map((f) => ({
            path: f.path,
            access: f.write ? 'read-write' : 'read-only',
          })),
          null,
          2,
        ),
      };
    case 'list_directory': {
      const dir = inside(args.path);
      if (!statSync(dir).isDirectory()) throw new ToolError('That path is not a folder.');
      const entries = readdirSync(dir, { withFileTypes: true }).slice(0, LIST_MAX);
      const rows = entries.map((entry) => {
        const full = path.join(dir, entry.name);
        let size: number | null;
        try {
          size = entry.isFile() ? lstatSync(full).size : null;
        } catch {
          size = null;
        }
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'folder' : entry.isSymbolicLink() ? 'link' : 'file',
          size,
        };
      });
      return { target: dir, text: JSON.stringify(rows, null, 2) };
    }
    case 'read_text_file': {
      const file = inside(args.path);
      const limit =
        typeof args.max_bytes === 'number' && args.max_bytes > 0
          ? Math.min(Math.floor(args.max_bytes), READ_MAX)
          : READ_DEFAULT;
      const stat = statSync(file);
      if (!stat.isFile()) throw new ToolError('That path is not a file.');
      const buffer = readFileSync(file).subarray(0, limit);
      if (buffer.includes(0)) throw new ToolError('That file is not text.');
      const cut = stat.size > limit ? `\n\n[truncated: ${stat.size} bytes, showing ${limit}]` : '';
      return { target: file, text: `${buffer.toString('utf8')}${cut}` };
    }
    case 'write_text_file': {
      if (typeof args.content !== 'string') throw new ToolError('content must be text.');
      if (Buffer.byteLength(args.content) > WRITE_MAX) throw new ToolError('content is over 1 MB.');
      const file = inside(args.path, true);
      let exists = false;
      try {
        exists = lstatSync(file).isFile();
        if (!exists) throw new ToolError('That path is a folder.');
      } catch (error) {
        if (error instanceof ToolError) throw error;
      }
      if (exists && args.overwrite !== true)
        throw new ToolError('That file exists; pass overwrite: true to replace it.');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, args.content, 'utf8');
      return { target: file, text: `Wrote ${Buffer.byteLength(args.content)} bytes to ${file}.` };
    }
    case 'open_path': {
      const file = inside(args.path);
      const problem = await env.openPath(file);
      if (problem) throw new ToolError(problem);
      return { target: file, text: `Opened ${file}.` };
    }
    case 'open_url': {
      let url: URL;
      try {
        url = new URL(String(args.url ?? ''));
      } catch {
        throw new ToolError('That is not a link.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new ToolError('Only http and https links are opened.');
      await env.openUrl(url.toString());
      return { target: url.toString(), text: `Opened ${url.toString()}.` };
    }
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

export interface HelperServerOptions {
  config: () => HelperConfig;
  env: HelperEnv;
  version: string;
  preferredPort: number | null;
  onActivity?: (entry: HelperActivity) => void;
  /** Programs on this computer, offered to the profile the request names (ADR 0025). */
  programs?: ProgramHost;
}

/** The header the hub on this computer puts on its MCP config: which profile is asking. */
export const PROFILE_HEADER = 'x-corehub-profile';
export const PROGRAM_STATUS_TOOL = 'program_call_status';

/** A program's tools as this computer's helper offers them to one profile. */
export function programToolsFor(host: ProgramHost | undefined, profile: string | null): ToolSpec[] {
  if (!host || profile === null) return [];
  const tools: ToolSpec[] = [];
  for (const { program, tools: listed } of host.available(profile)) {
    for (const tool of listed) {
      tools.push({
        name: helperToolName(program.id, tool.name),
        description: `[${program.name}] ${tool.description}`.slice(0, 2000),
        inputSchema: tool.input_schema,
      });
    }
  }
  if (tools.length > 0)
    tools.push({
      name: PROGRAM_STATUS_TOOL,
      description:
        'How a long program call stands (a tool answered state: running with a call_id), and its result once it is done.',
      inputSchema: obj({ call_id: { type: 'string' } }, ['call_id']),
    });
  return tools;
}

/** Which program and tool a helper tool name stands for, for this profile. */
function programToolOf(
  host: ProgramHost,
  profile: string,
  name: string,
): { programId: string; tool: string } | null {
  for (const { program, tools } of host.available(profile)) {
    const tool = tools.find((t) => helperToolName(program.id, t.name) === name);
    if (tool) return { programId: program.id, tool: tool.name };
  }
  return null;
}

/** A program's answer as an MCP tool result. */
export function outcomeResult(outcome: CallOutcome): { content: unknown[]; isError: boolean } {
  if (outcome.state === 'running')
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            state: 'running',
            call_id: outcome.callId,
            progress: outcome.progress,
            next: `call ${PROGRAM_STATUS_TOOL} with this call_id in a little while`,
          }),
        },
      ],
      isError: false,
    };
  return { content: outcome.content, isError: outcome.isError };
}

export interface HelperServer {
  readonly port: number;
  readonly url: string;
  activity(): HelperActivity[];
  /** Adds an entry made elsewhere (a program's call, a hub's request) to the same list. */
  record(entry: HelperActivity): void;
  close(): Promise<void>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startHelper(options: HelperServerOptions): Promise<HelperServer> {
  let port = 0;
  const log: HelperActivity[] = [];
  const record = (entry: HelperActivity) => {
    log.unshift(entry);
    if (log.length > LOG_MAX) log.pop();
    options.onActivity?.(entry);
  };

  async function handle(message: RpcRequest, profile: string | null): Promise<unknown> {
    const { id, method } = message;
    const notification = id === undefined;
    if (method === 'initialize') {
      const asked = String(message.params?.protocolVersion ?? '');
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'corehub-desktop',
            title: 'Core Hub — this computer',
            version: options.version,
          },
          instructions:
            'Tools for the computer the Core Hub desktop app runs on. Only the folders the person shared are reachable; list_allowed_folders says which.',
        },
      };
    }
    if (notification) return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [...toolsFor(options.config()), ...programToolsFor(options.programs, profile)],
        },
      };
    if (method === 'tools/call') {
      const name = String(message.params?.name ?? '');
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const at = new Date().toISOString();
      const host = options.programs;
      const program = host && profile !== null ? programToolOf(host, profile, name) : null;
      if (host && (program || (name === PROGRAM_STATUS_TOOL && profile !== null))) {
        // The host asks the person and writes the activity itself.
        try {
          const outcome = program
            ? await host.call({
                programId: program.programId,
                tool: program.tool,
                args,
                profile,
                via: 'local',
                hub: null,
              })
            : host.status(String(args.call_id ?? ''));
          return { jsonrpc: '2.0', id, result: outcomeResult(outcome) };
        } catch (error) {
          const detail =
            error instanceof ProgramRefusal || error instanceof Error
              ? error.message
              : String(error);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: detail }], isError: true },
          };
        }
      }
      try {
        const { text, target } = await callTool(options.config(), options.env, name, args);
        record({ at, tool: name, target, ok: true, detail: null, via: 'local' });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: false },
        };
      } catch (error) {
        const detail =
          error instanceof ToolError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        const target =
          typeof args.path === 'string'
            ? args.path
            : typeof args.url === 'string'
              ? args.url
              : null;
        record({ at, tool: name, target, ok: false, detail, via: 'local' });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: detail }], isError: true },
        };
      }
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  const send = (res: ServerResponse, status: number, body?: unknown, headers = {}) => {
    res.writeHead(status, {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '');
    // A browser always says where a request comes from; the agents this serves never do.
    if (!hostOk || req.headers.origin !== undefined)
      return send(res, 403, rpcError(null, -32000, 'Forbidden'));
    if ((req.url ?? '').split('?')[0] !== MCP_PATH)
      return send(res, 404, rpcError(null, -32000, 'Not found'));
    if (!tokenMatches(req.headers.authorization, options.config().token))
      return send(res, 401, rpcError(null, -32001, 'Unauthorized'), {
        'www-authenticate': 'Bearer',
      });
    if (req.method === 'DELETE') return send(res, 200);
    if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST, DELETE' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, rpcError(null, -32700, 'Parse error'));
      }
      const batch = Array.isArray(parsed);
      const messages = (batch ? parsed : [parsed]) as RpcRequest[];
      const named = req.headers[PROFILE_HEADER];
      const profile =
        typeof named === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(named) ? named : null;
      void Promise.all(
        messages.map((m) =>
          m && typeof m === 'object' && typeof m.method === 'string'
            ? handle(m, profile)
            : Promise.resolve(rpcError(null, -32600, 'Invalid request')),
        ),
      ).then((answers) => {
        const replies = answers.filter((a) => a !== null);
        const session = messages.some((m) => m?.method === 'initialize')
          ? { 'mcp-session-id': randomBytes(16).toString('hex') }
          : {};
        if (replies.length === 0) return send(res, 202, undefined, session);
        send(res, 200, batch ? replies : replies[0], session);
      });
    });
  });
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  try {
    port = await listen(options.preferredPort ?? 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !options.preferredPort)
      throw error;
    port = await listen(0);
  }
  return {
    port,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    activity: () => [...log],
    record,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }),
  };
}

export const newHelperToken = (): string => randomBytes(32).toString('hex');
