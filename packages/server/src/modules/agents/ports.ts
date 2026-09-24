/**
 * What `agents` offers the `sessions` module.
 *
 * `sessions` declares two ports it needs (`modules/sessions/ports.ts`): `AgentDirectory`
 * ("does this agent exist here and can it take a turn?") and `AgentRunner` (the four
 * verbs of a turn). Both are the registry's business, so both are implemented here and
 * wiring them is one line in `src/modules/index.ts`:
 *
 *     createSessionsModule({ agents: agentDirectory, runner: agentRunner, scopes })
 *
 * The interfaces are restated here rather than imported because a module never imports
 * another module's internals (ARCHITECTURE §Modules); `sessions` owns the shape, this
 * file owns an implementation that satisfies it structurally. A mismatch is a type error
 * at the wiring line, which is exactly where it should surface.
 */

/**
 * What the `models` module gives `agents` (ADR 0010).
 *
 * The direction matters: `agents` never reads a provider row and never sees a key. It
 * says "this agent declares these credential families" and "this agent is of this kind",
 * and gets back an environment and a model reference. `models` registers the
 * implementation at boot (`registerAgentModelsPort`); until it does, agents start with
 * their own settings only, exactly as they did before this port existed.
 */
export interface AgentModelsPort {
  /**
   * The environment a process agent starts with: the workspace's shared provider keys
   * under the names this agent declared, then its own `env`, then its `secret_refs`.
   */
  environmentFor(
    workspace: string,
    declared: Readonly<Record<string, string>>,
    extra: {
      settingsEnv?: Readonly<Record<string, string>>;
      secretRefs?: Readonly<Record<string, string>>;
    },
  ): Record<string, string>;
  /**
   * The model this agent should use: the one pinned to it when there is one, otherwise
   * the workspace default for its kind. `null` when the workspace has chosen none.
   */
  defaultModelFor(
    workspace: string,
    adapterKind: string,
    pinnedModelId: string | null,
  ): { provider_id: string; model: string } | null;
  /**
   * What a run named, resolved to a provider and the model id that provider uses.
   *
   * A client picks from `models.listCatalogue`, whose `Model.key` is
   * `"<provider slug>/<model>"` — one string, so a `<Select>` has something to be the
   * value of. That string is not a model id any provider has ever heard of, and handing
   * it to a runtime is how the model the person chose stopped being the model that ran
   * (the defect of 2026-09-22). A bare model id is accepted too, and resolves against
   * the workspace's own catalogue.
   */
  resolveModelKey(workspace: string, key: string): { provider_id: string; model: string } | null;
  /**
   * The name the agent runtime knows a provider by — Hermes's own slug, or the
   * `providers:` block the hub wrote for an OpenAI-compatible endpoint (ADR 0010).
   * `null` when the runtime cannot be told about this provider at all.
   */
  runtimeProviderName(workspace: string, providerId: string): string | null;
  /** Which workspace assignment an agent of this kind inherits (`chat` / `coding`). */
  roleForAdapter(adapterKind: string): string;
  /**
   * What the `direct` agent must know before it builds a prompt (ADOPTION-BACKLOG
   * §2.15). `null` when the workspace has no such model row — the turn is then refused
   * rather than sent on a guess.
   */
  modelFacts(workspace: string, providerId: string, model: string): DirectModelFacts | null;
  /**
   * One streamed turn, hub to provider, with no agent runtime in between.
   *
   * This is the whole of the direct path across the module boundary: a provider row id,
   * a model, the conversation, and events back. `agents` still never sees a provider
   * row and never sees a key (ADR 0010) — it names what to run and reads what comes out.
   */
  directChat(workspace: string, request: DirectChatRequest): AsyncIterable<DirectChatEvent>;
  /**
   * A named Hermes profile is about to run a turn (ADR 0014 stage 3): `models` puts the
   * hub's providers where that profile reads them — the endpoints in its `config.yaml`, and
   * none of the hub's key names left in its own `.env`, where they would shadow the keys
   * every profile gets from the process environment (contract decision §34). Never throws.
   */
  prepareRuntimeProfile?(profileHome: string): void;
}

// ------------------------------------------------- the direct path (ADOPTION §2.15)

/** An image sent inline with a turn; the caller read the bytes and encoded them. */
export interface DirectChatImage {
  mime: string;
  dataBase64: string;
  name: string;
}

export interface DirectChatMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
  images?: DirectChatImage[];
}

export interface DirectChatRequest {
  providerId: string;
  model: string;
  messages: DirectChatMessage[];
  reasoningEffort?: string | null;
  /** Aborting it closes the provider socket; the stream then ends as `cancelled`. */
  signal?: AbortSignal;
}

export type DirectChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'usage';
      modelLabel: string;
      providerId: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      costMicroUsd?: number;
      costSource?: 'provider' | 'estimated' | 'unknown';
    }
  | { type: 'completed' }
  | {
      /**
       * `code` is one of the contract's `ErrorCode`s, except for `cancelled`, which
       * means the hub's own abort landed and the run ended on request.
       */
      type: 'failed';
      code: string;
      message: string;
    };

export interface DirectModelFacts {
  providerSlug: string;
  providerLabel: string;
  modelLabel: string;
  /** Declared on the model row; never inferred from the model's name. */
  vision: boolean;
  maxOutputTokens: number | null;
}

/** A registry entry, reduced to what starting a turn needs. */
export interface AgentInfo {
  id: string;
  name: string;
  /** `acp` | `hermes` | `harness` (ADR 0002). Stored on the run for the UI. */
  adapterKind: string;
  defaultModel: string | null;
  defaultProvider: string | null;
  /** False when the agent is known but not installed / not running on this host. */
  available: boolean;
  /** Machine-readable reason for `available: false` (`not_installed`, `stopped`, …). */
  unavailableReason?: string;
}

export interface AgentDirectoryPort {
  /** `null` when the workspace has no such agent — the caller answers 404. */
  find(workspace: string, agentId: string): Promise<AgentInfo | null>;
}

// --------------------------------------------------------------- the runner port

export type RunnerPromptBlock =
  | { type: 'text'; text: string }
  | {
      type: 'attachment';
      attachmentId: string;
      kind: 'image' | 'file' | 'audio';
      name?: string;
      mime?: string;
      sizeBytes?: number;
      /** Absolute path the hub wrote the bytes to, inside the run's input folder. */
      path?: string;
    }
  | { type: 'location'; latitude: number; longitude: number };

/** The folders one turn exchanges files through (`sessions`' `AgentFileExchange`). */
export interface RunnerFileExchange {
  inputDir: string;
  outputDir: string;
}

export interface RunnerRunRequest {
  runId: string;
  sessionId: string;
  workspace: string;
  agentId: string;
  agentSessionRef: string | null;
  workingDir: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  prompt: RunnerPromptBlock[];
  files: RunnerFileExchange | null;
  allowedTools: string[];
}

export interface RunnerRunAccepted {
  agentSessionRef?: string | null;
  agentRunRef?: string | null;
}

export type RunnerToolKind =
  'shell' | 'file_read' | 'file_write' | 'search' | 'web' | 'mcp' | 'device' | 'custom';

export type RunnerApprovalKind = 'tool_call' | 'plan' | 'memory_write' | 'skill_write' | 'question';

export interface RunnerChoice {
  value: string;
  label: string;
}

/** The sessions module's `AgentEvent`, restated. */
export type RunnerEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | {
      type: 'tool_started';
      ref: string;
      name: string;
      kind?: RunnerToolKind;
      title?: string | null;
      input?: Record<string, unknown>;
      subagentId?: string | null;
    }
  | { type: 'tool_completed'; ref: string; output?: string | null; exitCode?: number | null }
  | { type: 'tool_failed'; ref: string; output?: string | null; exitCode?: number | null }
  | {
      type: 'approval_requested';
      ref: string;
      kind: RunnerApprovalKind;
      title: string;
      description?: string | null;
      command?: string | null;
      choices?: RunnerChoice[];
      allowAlways?: boolean;
      answerMode?: 'choice' | 'text' | 'both';
      toolRef?: string | null;
      expiresInMs?: number | null;
    }
  | {
      type: 'usage';
      modelLabel?: string | null;
      providerId?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      costMicroUsd?: number;
      costSource?: 'provider' | 'estimated' | 'unknown';
    }
  | { type: 'context'; usedTokens: number; windowTokens?: number | null }
  | { type: 'completed' }
  | { type: 'failed'; code?: string; message: string };

export type RunnerDecision = 'approve_once' | 'approve_session' | 'approve_always' | 'deny';

export interface RunnerRunInput {
  approvalRef: string;
  decision: RunnerDecision | null;
  answer: string | null;
}

/**
 * One question outside any run (`modules/sessions/ports.ts` §AgentAskRequest): no run
 * row, no job, no events, no tools. The hub asks a session's own agent to name it.
 */
export interface RunnerAskRequest {
  workspace: string;
  agentId: string;
  sessionId: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  timeoutMs: number;
}

export interface AgentRunnerPort {
  start(request: RunnerRunRequest): Promise<RunnerRunAccepted>;
  stream(runId: string): AsyncIterable<RunnerEvent>;
  send(runId: string, input: RunnerRunInput): Promise<void>;
  interrupt(runId: string): Promise<void>;
  ask(request: RunnerAskRequest): Promise<string | null>;
}
