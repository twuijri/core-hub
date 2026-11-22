/**
 * The small part of the harness's plugin API this plugin uses, written down from its published
 * documentation and interface declarations (DeepSeek Harness 0.2.2-rc.5, MIT): docs/architecture.md,
 * docs/subsystems/{commands,mcp,tools}.md, packages/mcp/mcp-manager/README.md, the connection
 * and directory-picker declarations,
 * packages/interaction/user-questions/README.md, the config-editor and llm-pi-ai declarations.
 * Narrow on purpose: the plugin imports none of the harness's runtime packages (only its
 * Schemastery, as a peer), so a breaking change shows up here, in one file.
 */

export interface Disposer {
  (): unknown;
}

/** `ctx.commands` (dsh-commands). */
export interface CommandRuntime {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string; attachments?: boolean };
    recordInput?: boolean;
    handler: (invocation: {
      agent: { id: string };
      rawInput: string;
      signal: AbortSignal;
    }) => Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>;
  }): Disposer;
}

export type ContentBlock = { type: 'text'; text: string } | Record<string, unknown>;

/** A raw tool definition (`ToolDefinition`, dsh-tools). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(
    args: unknown,
    exec: {
      callId: string;
      name: string;
      arguments: unknown;
      agent?: { id: string };
      signal: AbortSignal;
      concludeTurn?: () => void;
    },
  ): Promise<unknown>;
  timeoutMs?: number;
}

export interface ToolExecutionResult {
  isError: boolean;
  value?: unknown;
  content: ContentBlock[];
  error?: { message?: string; code?: string };
}

/** `ctx.tools` (dsh-tools). */
export interface ToolRegistry {
  register(definition: ToolDefinition): Disposer;
  get(name: string): ToolDefinition | undefined;
  definitions(): ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  execute(input: {
    calls: ReadonlyArray<{ type: 'tool-call'; id: string; name: string; arguments: string }>;
    signal: AbortSignal;
  }): Promise<{ results: ReadonlyArray<{ callId: string; result: ToolExecutionResult }> }>;
}

/** `ctx.mcpManager` (dsh-mcp-manager). */
export interface McpServerManager {
  list(): Array<{ name: string; configured: boolean; status: { state: string } }>;
}

/** `ctx.configEditor` (dsh-config-editor). */
export interface ConfigEditor {
  readonly documentPath: string;
  entries(): Array<{ id: string; options?: { id?: string } }>;
  configuration(): Array<{
    entry: { id: string };
    inherited: Record<string, unknown>;
    override: Record<string, unknown>;
  }>;
  edit(
    entry: { id: string },
    change: (
      current: Record<string, unknown>,
      inherited: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<void>;
}

/** `ctx.userQuestions` (dsh-user-questions). */
export interface UserQuestions {
  ask(request: {
    questions: Array<{
      id: string;
      question: string;
      detail?: string;
      header?: string;
      options?: Array<{ label: string }>;
      intent?: {
        kind: 'approval';
        approve: string;
        reject: string;
        always?: string;
        subject?: { name: string };
      };
    }>;
  }): Promise<{ answers: Array<{ id: string; selected: string[] }> }>;
}

/** `ctx.agentDefaultModel` (dsh-agent-default-model). */
export interface AgentDefaultModel {
  currentSelection(): { provider: string; model: string };
}

/**
 * `ctx.connection` (dsh-client-connection's Host half): exact Fetch routes on the harness's
 * authenticated `/api` channel. Only the harness's owner reaches them; the plugin's settings page
 * calls its own.
 */
export interface HostConnection {
  fetch: {
    register(route: {
      path: string;
      methods: ReadonlyArray<'GET' | 'HEAD' | 'POST'>;
      requestBody: 'buffered' | 'streaming';
      fetch: (request: Request) => Promise<Response>;
    }): () => Promise<void>;
  };
}

/** The Cordis context, as far as the plugin reads it. */
export interface HostContext {
  effect(execute: () => (() => void) | void): unknown;
  inject(deps: string[], callback: (ctx: HostContext) => void): unknown;
  on(event: string, listener: (...args: never[]) => unknown): () => boolean;
  logger(name: string): {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  get?(name: string): unknown;
  commands?: CommandRuntime;
  tools?: ToolRegistry;
  mcpManager?: McpServerManager;
  configEditor?: ConfigEditor;
  userQuestions?: UserQuestions;
  connection?: HostConnection;
  computerUse?: unknown;
}
