/**
 * ACP adapter — any coding agent that speaks the Agent Client Protocol over stdio
 * (ADR 0002, implementation 1).
 *
 * Wire format: JSON-RPC 2.0, one object per line, on the child's stdin/stdout. The turn
 * the hub drives is:
 *
 *     -> initialize            { protocolVersion: 1, clientCapabilities, clientInfo }
 *     <- initialize            { protocolVersion, agentCapabilities, authMethods }
 *     -> session/new           { cwd, mcpServers: [] }          => { sessionId }
 *     -> session/prompt        { sessionId, prompt: [ContentBlock] }
 *     <- session/update        (notifications: agent_message_chunk, agent_thought_chunk,
 *                               tool_call, tool_call_update, plan, …)
 *     <- session/request_permission                 (a request, answered by the person)
 *     <- session/prompt result { stopReason }
 *     -> session/cancel        (notification, for interrupt)
 *
 * The agent may also call the client (`fs/read_text_file`, `fs/write_text_file`,
 * `session/request_permission`). Phase 0 answers the two filesystem methods with
 * "unsupported" — the hub does not lend an agent its own filesystem — and turns a
 * permission request into an `approval.requested` event the `sessions` module will
 * resolve. Anything else gets a JSON-RPC "method not found" rather than silence, so a
 * mismatched agent fails loudly.
 *
 * Nothing about a specific vendor lives here: which CLIs to look for is data
 *  (`../catalog/`), not code: only a catalog entry the owner approved can be driven.
 */
import { PRODUCT, derived } from '@corehub/contracts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentCapability } from '../schema.js';
import { entriesFor, type CatalogEntry } from '../catalog/index.js';
import { EventQueue } from './event-queue.js';
import {
  SubagentSignals,
  acpDelegationAgent,
  acpDelegationGoal,
  acpParentToolRef,
  isAcpDelegation,
  type SubagentControl,
} from './subagents.js';
import { parseVersion, runCommand, whichSync, type HostEnvironment } from './host.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentProbe,
  AgentSession,
  AgentTarget,
  DiscoveredAgent,
  PromptInput,
  SettingsSection,
} from './types.js';

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_ADAPTER_VERSION = '1.0.0';

/** JSON-RPC error codes ACP inherits from the base protocol. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpTransport {
  /** Write one JSON-RPC message (the transport adds the newline). */
  write(message: JsonRpcMessage): void;
  /** Called for every message the agent sends. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: (reason: string | null) => void): void;
  close(): void;
}

/** Line-delimited JSON over a child process's stdio. */
export function childProcessTransport(child: ChildProcessWithoutNullStreams): AcpTransport {
  const messageHandlers: ((message: JsonRpcMessage) => void)[] = [];
  const closeHandlers: ((reason: string | null) => void)[] = [];
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Kept only to explain an exit; never streamed to a client as agent output.
    stderr = (stderr + chunk).slice(-4096);
  });
  lines.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return;
    }
    for (const handler of messageHandlers) handler(message);
  });
  child.on('exit', (code, signal) => {
    const reason =
      code === 0
        ? null
        : `agent exited (${signal ?? `code ${code ?? '?'}`})${stderr ? `: ${stderr.trim()}` : ''}`;
    for (const handler of closeHandlers) handler(reason);
  });
  return {
    write(message) {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      lines.close();
      child.stdin.end();
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** The ACP client for one session: owns the request ids and the update stream. */
export class AcpSession implements AgentSession {
  private sessionId: string;
  private readonly transport: AcpTransport;
  private readonly pending = new Map<number, Pending>();
  private readonly queue = new EventQueue();
  private readonly approvals = new Map<string, number | string>();
  private nextId = 1;
  private closed = false;
  private readonly subagentSignals = new SubagentSignals();
  /** Tool calls that are delegations, by their id: the subagent is the call (§56). */
  private readonly delegations = new Map<string, { goal: string | null }>();

  /**
   * What an ACP agent's stream says about its delegations: that one started, what it was asked,
   * and that it ended — `observe`, nothing more (contract decision §56).
   */
  readonly subagents: SubagentControl = {
    support: 'observe',
    watch: (listener) => this.subagentSignals.watch(listener),
  };

  private constructor(transport: AcpTransport, sessionId: string) {
    this.transport = transport;
    this.sessionId = sessionId;
  }

  get id(): string {
    return this.sessionId;
  }

  static async connect(
    transport: AcpTransport,
    options: {
      cwd: string;
      clientName: string;
      clientVersion: string;
      timeoutMs?: number;
      /**
       * MCP servers the hub hands the agent for this session — the hub's own tools (contract
       * decision §67). An HTTP server goes only to an agent that says it can reach one
       * (`agentCapabilities.mcpCapabilities.http`); ACP requires every agent to take stdio.
       */
      mcpServers?: readonly AcpMcpServer[];
    },
  ): Promise<{ session: AcpSession; agentCapabilities: Record<string, unknown> }> {
    const client = new AcpSession(transport, '');
    client.listen();
    const initialize = (await client.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: options.clientName, version: options.clientVersion },
      },
      options.timeoutMs,
    )) as { protocolVersion?: number; agentCapabilities?: Record<string, unknown> };
    if (initialize.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `agent speaks ACP v${String(initialize.protocolVersion)}, the hub speaks v${ACP_PROTOCOL_VERSION}`,
      );
    }
    const capabilities = initialize.agentCapabilities ?? {};
    const mcp = (capabilities.mcpCapabilities ?? {}) as { http?: unknown; sse?: unknown };
    const mcpServers = (options.mcpServers ?? []).filter(
      (server) =>
        server.type === 'stdio' ||
        (server.type === 'http' && mcp.http === true) ||
        (server.type === 'sse' && mcp.sse === true),
    );
    const created = (await client.request(
      'session/new',
      { cwd: options.cwd, mcpServers },
      options.timeoutMs,
    )) as { sessionId?: string };
    if (!created.sessionId) throw new Error('agent returned no sessionId');
    client.sessionId = created.sessionId;
    return { session: client, agentCapabilities: initialize.agentCapabilities ?? {} };
  }

  private listen(): void {
    this.transport.onMessage((message) => this.handle(message));
    this.transport.onClose((reason) => {
      if (reason) this.queue.push({ type: 'run.failed', error: reason });
      for (const pending of this.pending.values()) {
        pending.reject(new Error(reason ?? 'agent closed the connection'));
      }
      this.pending.clear();
      this.closed = true;
      this.subagentSignals.endAll(reason);
      this.queue.end();
    });
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.transport.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.transport.write({ jsonrpc: '2.0', method, params });
  }

  private handle(message: JsonRpcMessage): void {
    // A response to something the hub asked.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;

    // A notification from the agent.
    if (message.id === undefined) {
      if (message.method === 'session/update') this.onUpdate(message.params);
      return;
    }

    // A request from the agent to the hub.
    if (message.method === 'session/request_permission') {
      this.onPermission(message.id, message.params);
      return;
    }
    this.transport.write({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: `${PRODUCT.name} does not implement ${message.method}`,
      },
    });
  }

  private onUpdate(params: unknown): void {
    const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
    if (!update) return;
    const kind = update.sessionUpdate;
    const text = contentText(update.content);
    switch (kind) {
      case 'agent_message_chunk':
        if (text) this.queue.push({ type: 'message.delta', text });
        return;
      case 'agent_thought_chunk':
        if (text) this.queue.push({ type: 'reasoning.delta', text });
        return;
      case 'tool_call': {
        const id = String(update.toolCallId ?? '');
        const parent = acpParentToolRef(update);
        this.queue.push({
          type: 'tool.started',
          id,
          title: String(update.title ?? update.kind ?? 'tool'),
          kind: String(update.kind ?? 'other'),
          input: acpToolInput(update),
          // A subagent's own call, where the bridge says whose it is.
          ...(parent && this.delegations.has(parent) ? { subagentId: parent } : {}),
          raw: update,
        });
        this.trackDelegation(id, update);
        return;
      }
      case 'tool_call_update': {
        const status = String(update.status ?? '');
        this.trackDelegation(String(update.toolCallId ?? ''), update);
        const output = contentText(update.content) ?? contentText(update.rawOutput);
        if (status === 'failed') {
          this.queue.push({
            type: 'tool.failed',
            id: String(update.toolCallId ?? ''),
            title: String(update.title ?? 'tool'),
            output,
            raw: update,
          });
        } else if (status === 'completed') {
          this.queue.push({
            type: 'tool.completed',
            id: String(update.toolCallId ?? ''),
            title: String(update.title ?? 'tool'),
            output,
            raw: update,
          });
        }
        return;
      }
      case 'plan':
        this.queue.push({
          type: 'plan',
          entries: (Array.isArray(update.entries) ? update.entries : []).map((entry) => ({
            content: String((entry as { content?: unknown }).content ?? ''),
            status: String((entry as { status?: unknown }).status ?? 'pending'),
          })),
        });
        return;
      default:
        // Updates the hub does not model yet (usage, modes, commands) are dropped, not
        // guessed at; the terminal `run.completed` still carries the outcome.
        return;
    }
  }

  /**
   * A delegation starts with its tool call, learns its goal when the arguments arrive (OpenCode
   * sends them in a later update) and ends with the call.
   */
  private trackDelegation(id: string, update: Record<string, unknown>): void {
    if (!id) return;
    const known = this.delegations.get(id);
    if (!known && !isAcpDelegation(update)) return;
    const goal = acpDelegationGoal(update);
    const agent = acpDelegationAgent(update);
    const status = String(update.status ?? '');
    if (!known) {
      this.delegations.set(id, { goal });
      this.subagentSignals.emit({
        phase: 'started',
        id,
        parentId: null,
        depth: 0,
        goal,
        model: agent,
        toolCount: null,
        acceptingSteer: false,
        toolCallRef: id,
      });
    } else if (goal && goal !== known.goal) {
      known.goal = goal;
      this.subagentSignals.emit({ phase: 'updated', id, goal, ...(agent ? { model: agent } : {}) });
    }
    if (status === 'completed' || status === 'failed') {
      this.subagentSignals.emit({
        phase: 'completed',
        id,
        status: status === 'completed' ? 'completed' : 'failed',
        summary: contentText(update.content) ?? contentText(update.rawOutput),
        acceptingSteer: false,
      });
    }
  }

  private onPermission(requestId: number | string, params: unknown): void {
    const body = params as
      | {
          toolCall?: { toolCallId?: string; title?: string };
          options?: { optionId?: string; name?: string; kind?: string }[];
        }
      | undefined;
    const approvalId = String(body?.toolCall?.toolCallId ?? requestId);
    this.approvals.set(approvalId, requestId);
    this.queue.push({
      type: 'approval.requested',
      id: approvalId,
      title: String(body?.toolCall?.title ?? 'The agent needs a decision'),
      options: (body?.options ?? []).map((option) => ({
        id: String(option.optionId ?? ''),
        label: String(option.name ?? option.optionId ?? ''),
        kind: String(option.kind ?? 'other'),
      })),
    });
  }

  async respond(approvalId: string, optionId: string): Promise<void> {
    const requestId = this.approvals.get(approvalId);
    if (requestId === undefined) throw new Error(`no open permission request ${approvalId}`);
    this.approvals.delete(approvalId);
    this.transport.write({
      jsonrpc: '2.0',
      id: requestId,
      result: { outcome: { outcome: 'selected', optionId } },
    });
  }

  async send(prompt: PromptInput): Promise<{ stopReason: string }> {
    const result = (await this.request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt.text }] },
      10 * 60_000,
    )) as { stopReason?: string };
    const stopReason = result.stopReason ?? 'completed';
    // An ACP delegation lives inside its turn: one the stream never closed ends with it.
    this.subagentSignals.endAll();
    this.queue.push({ type: 'run.completed', stopReason });
    return { stopReason };
  }

  stream(): AsyncIterable<AgentEvent> {
    return this.queue.iterator();
  }

  async interrupt(): Promise<void> {
    this.notify('session/cancel', { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.subagentSignals.endAll();
    this.queue.end();
    this.transport.close();
  }
}

/** ACP content blocks are a union; only text carries something to show. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => contentText(part)).filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join('') : null;
  }
  if (content && typeof content === 'object') {
    const block = content as { type?: string; text?: string; content?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.content !== undefined) return contentText(block.content);
  }
  return null;
}

/** An MCP server as ACP's `session/new` carries it. */
export type AcpMcpServer =
  | {
      type: 'http' | 'sse';
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    }
  | {
      type: 'stdio';
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };

export interface AcpAdapterOptions {
  host: HostEnvironment;
  /** The MCP servers a session in this target's workspace is given (the hub's own tools). */
  mcpServers?: (target: AgentTarget) => readonly AcpMcpServer[];
  catalog?: readonly CatalogEntry[];
  clientName?: string;
  clientVersion?: string;
  /** Injected in tests so a fake binary can be driven without spawning. */
  connect?: (target: AgentTarget) => Promise<AcpTransport>;
}

export function createAcpAdapter(options: AcpAdapterOptions): AgentAdapter {
  const host = options.host;
  const catalog = options.catalog ?? entriesFor('acp');
  const clientName = options.clientName ?? derived.serviceName;
  const clientVersion = options.clientVersion ?? ACP_ADAPTER_VERSION;

  const openTransport = async (target: AgentTarget): Promise<AcpTransport> => {
    if (options.connect) return options.connect(target);
    const argv = [...target.command];
    const [command, ...args] = argv;
    if (!command) throw new Error(`agent ${target.slug} has no command`);
    const child = spawn(target.executablePath ?? command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(host.inherited ?? {}), ...(target.env ?? {}) },
      ...(target.cwd ? { cwd: target.cwd } : {}),
    }) as ChildProcessWithoutNullStreams;
    return childProcessTransport(child);
  };

  return {
    kind: 'acp',
    name: 'Agent Client Protocol',
    version: ACP_ADAPTER_VERSION,
    selectable: true,

    capabilities(): AgentCapability[] {
      return ['streaming', 'tools', 'approvals', 'resume'];
    },

    async discover(): Promise<DiscoveredAgent[]> {
      const found: DiscoveredAgent[] = [];
      for (const entry of catalog) {
        const executablePath = whichSync(entry.binary, host);
        if (!executablePath) continue;
        const probe = await runCommand([executablePath, ...entry.versionArgs]);
        found.push({
          slug: entry.id,
          name: entry.name,
          vendor: entry.vendor,
          command: [entry.binary, ...entry.protocolArgs],
          executablePath,
          version: parseVersion(`${probe.stdout}${probe.stderr}`),
          capabilities: entry.capabilities,
          sections: entry.sections,
        });
      }
      return found;
    },

    async probe(target: AgentTarget): Promise<AgentProbe> {
      const binary = target.executablePath ?? target.command[0] ?? target.slug;
      const executablePath = whichSync(binary, host);
      if (!executablePath) {
        return {
          installed: false,
          source: 'none',
          executablePath: null,
          version: null,
          runtime: { state: 'not_applicable', url: null, error: null },
          error: null,
        };
      }
      const entry = catalog.find((candidate) => candidate.id === target.slug);
      const result = await runCommand([executablePath, ...(entry?.versionArgs ?? ['--version'])]);
      return {
        installed: true,
        source: 'user_cli',
        executablePath,
        version: parseVersion(`${result.stdout}${result.stderr}`),
        // An ACP agent is a process the hub starts per session: there is no long-lived
        // runtime to report, which is exactly what `not_applicable` means.
        runtime: { state: 'not_applicable', url: null, error: null },
        error: result.ok ? null : result.error,
      };
    },

    settings(_target, stored): SettingsSection[] {
      return [
        {
          key: 'session',
          title: { ar: 'الجلسة', en: 'Session' },
          restart_required: false,
          fields: [
            {
              key: 'working_dir',
              label: { ar: 'مجلد العمل', en: 'Working directory' },
              kind: 'text',
              value: stored.working_dir ?? null,
              options: [],
              min: null,
              max: null,
              hint: 'Directory new sessions of this agent start in.',
            },
            {
              key: 'approval_mode',
              label: { ar: 'وضع الموافقات', en: 'Approvals' },
              kind: 'choice',
              value: stored.approval_mode ?? 'ask',
              options: [
                { value: 'ask', label: 'Ask every time' },
                { value: 'auto_safe', label: 'Auto-approve reads' },
                { value: 'auto_all', label: 'Auto-approve everything' },
              ],
              min: null,
              max: null,
              hint: null,
            },
          ],
        },
      ];
    },

    async start(target: AgentTarget): Promise<AgentSession> {
      const transport = await openTransport(target);
      const { session } = await AcpSession.connect(transport, {
        cwd: target.cwd ?? process.cwd(),
        clientName,
        clientVersion,
        mcpServers: options.mcpServers?.(target) ?? [],
      });
      return session;
    },
  };
}

/**
 * What an ACP tool call was given, as the hub records it: the agent's `rawInput`, plus the
 * files the call touches — ACP's `locations` and the paths of its `diff` content — as
 * `locations`, so the chat can open those files (decision §48). `{}` when neither is there.
 */
export function acpToolInput(update: Record<string, unknown>): Record<string, unknown> {
  const raw = update.rawInput;
  const input: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object) } : {};
  const paths = new Set<string>();
  for (const location of Array.isArray(update.locations) ? update.locations : []) {
    const value = (location as { path?: unknown } | null)?.path;
    if (typeof value === 'string' && value !== '') paths.add(value);
  }
  for (const block of Array.isArray(update.content) ? update.content : []) {
    const item = block as { type?: unknown; path?: unknown } | null;
    if (item?.type === 'diff' && typeof item.path === 'string' && item.path !== '')
      paths.add(item.path);
  }
  if (paths.size > 0 && !('locations' in input)) input.locations = [...paths];
  return input;
}
