/**
 * The small part of the harness's plugin API this plugin uses, written down from its published
 * documentation and interface declarations (DeepSeek Harness 0.2.2-rc.5, MIT): docs/architecture.md,
 * docs/subsystems/{commands,mcp,tools,jobs}.md, packages/jobs/tool-jobs/README.md,
 * packages/mcp/mcp-manager/README.md,
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
      /** The model-requested call that owns this one (a `run_code` program's, under PTC). */
      rootCallId?: string;
      name: string;
      arguments: unknown;
      /** The calling agent; its id is the harness session's id (`SessionId`). */
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
 * `ctx.jobs` (dsh-jobs, the background job registry; docs/subsystems/jobs.md). A job owned by
 * a session is reported to that session's agent when it settles (dsh-tool-jobs: a completion
 * notice carrying the job's `result`), unless a `wait` collected the settlement first. `start`
 * throws when no job controller serves the owner (no dsh-tool-jobs in that composition).
 */
export interface JobRegistry {
  start(spec: {
    kind: string;
    label: string;
    owner?: string;
    toolCall?: { callId: string; rootCallId: string };
    outputLimitBytes?: number;
    run(job: { readonly id: string; updateProgress(line: string): void }): {
      cancel(reason?: string): void;
      done: Promise<{
        status: 'completed' | 'killed' | 'failed';
        detail?: string;
        result?: string;
      }>;
    };
  }): string;
  get(id: string, caller?: string): { id: string; status: string };
  wait(
    id: string,
    timeoutMs: number,
    caller?: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; status: string }>;
  remove(id: string, caller?: string): void;
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
  computerUse?: unknown;
  jobs?: JobRegistry;
}
