/**
 * `AgentAdapter` — the one interface the rest of the hub sees (ADR 0002).
 *
 * The ADR names seven verbs: `discover`, `start`, `send`, `stream`, `interrupt`,
 * `capabilities`, `settings`. Four of them are per-conversation, so they live on the
 * `AgentSession` that `start` returns; the adapter itself keeps the three that are about
 * the agent rather than a conversation, plus `probe`, which is what "is it installed and
 * is it up" needs to be answerable without starting anything.
 *
 *     adapter.discover()        -> what of this kind is on the host
 *     adapter.probe(target)     -> install state, version, runtime state
 *     adapter.capabilities()    -> the floor every agent of this kind supports
 *     adapter.settings(...)     -> the form the settings screen renders
 *     adapter.start(target)     -> AgentSession { send, stream, interrupt, close }
 *
 * Rooms, tasks and schedules never import an adapter; they receive one of these.
 * Nothing here knows about HTTP, Fastify or the database.
 */
import type { AgentCapability, AgentSection } from '../schema.js';
import type { SubagentControl } from './subagents.js';

export type AdapterKind = 'hermes' | 'acp' | 'harness' | 'builtin';

/** What the registry knows about one agent, as far as an adapter needs it. */
export interface AgentTarget {
  slug: string;
  name: string;
  /**
   * The workspace this conversation belongs to.
   *
   * A process agent needs none of this — its workspace was already resolved into `env`
   * and `cwd` before the target was built. The `builtin` adapter does: it has no process
   * to hand an environment to, and resolves the workspace's provider and key at the
   * moment of each turn, through the `models` port. Absent outside a run (a probe, a
   * settings form), which is why it is optional.
   */
  workspace?: string;
  /**
   * The agent runtime's own profile this conversation runs in (ADR 0014 stage 3): for
   * Hermes, the workspace's slug, or `default` for the hub's default workspace. Absent
   * outside a run and for agents without profiles; absent is the runtime's own default.
   */
  profile?: string | null;
  /** argv to start the agent; never a shell string (AGENTS.md hard rules). */
  command: readonly string[];
  executablePath: string | null;
  /** Hermes: the gateway base URL. */
  endpoint: string | null;
  /** Non-secret environment for the process. */
  env?: Record<string, string>;
  /**
   * The workspace's stored settings for this agent, exactly as the adapter's own
   * `settings()` form declared them. A process adapter has no use for them — its
   * configuration is its argv and its environment — but an adapter the hub *is* reads
   * its own fields from here.
   */
  settings?: Readonly<Record<string, unknown>>;
  /** Working directory for a session. */
  cwd?: string;
  /**
   * The agent's own id for a conversation the hub already had with it (Hermes `session_id`,
   * an ACP session id): `start()` resumes it; `null`/absent opens a new one.
   */
  sessionRef?: string | null;
  /** Model and reasoning effort the session or run asks for; `null` = the agent's default. */
  model?: string | null;
  /**
   * The name the agent runtime knows the model's provider by — Hermes's own slug, or the
   * `providers:` block the hub wrote for an OpenAI-compatible endpoint (ADR 0010). Sent
   * with the model so a run is never served by whichever provider the runtime's own
   * configuration happened to name last.
   */
  modelProvider?: string | null;
  /** The hub's own `providers` row id behind that model; see `PromptInput`. */
  modelProviderId?: string | null;
  reasoningEffort?: string | null;
}

export type InstallSource = 'managed' | 'user_cli' | 'builtin' | 'none';
export type RuntimeState = 'running' | 'stopped' | 'starting' | 'error' | 'not_applicable';

/** The answer to "is this agent usable on this host right now". */
export interface AgentProbe {
  installed: boolean;
  source: InstallSource;
  executablePath: string | null;
  version: string | null;
  runtime: { state: RuntimeState; url: string | null; error: string | null };
  /** Capabilities the probe itself proved, narrowing the adapter's floor. */
  capabilities?: AgentCapability[];
  error: string | null;
}

/** An agent of this kind found on the host that the registry did not know about. */
export interface DiscoveredAgent {
  slug: string;
  name: string;
  vendor: string | null;
  command: string[];
  executablePath: string;
  version: string | null;
  capabilities: AgentCapability[];
  sections: AgentSection[];
}

/**
 * One streamed item of a turn, in the vocabulary of the contract's realtime events.
 *
 * `kind` on a tool is the agent's own word for it (ACP `read`/`execute`, a Hermes tool
 * name); the runner (`../runner.ts`) folds it into the contract's `ToolCall.kind`. Every
 * field beyond the required ones is optional so an adapter reports what its wire carries
 * and nothing it would have to invent.
 */
export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | {
      type: 'tool.started';
      id: string;
      title: string;
      kind: string;
      /** Tool name as the agent reported it; defaults to `title`. */
      name?: string;
      input?: Record<string, unknown>;
      subagentId?: string | null;
      raw?: unknown;
    }
  | {
      type: 'tool.completed';
      id: string;
      title: string;
      output: string | null;
      exitCode?: number | null;
      raw?: unknown;
    }
  | {
      type: 'tool.failed';
      id: string;
      title: string;
      output: string | null;
      exitCode?: number | null;
      raw?: unknown;
    }
  | {
      type: 'approval.requested';
      id: string;
      title: string;
      options: ApprovalOption[];
      description?: string | null;
      /** The command the agent wants to run, already redacted by the agent. */
      command?: string | null;
      /** `tool.started.id` this decision gates, when the adapter can tell. */
      toolId?: string | null;
    }
  | {
      /**
       * The agent asks the person something and waits (Hermes's `clarify` tool): a
       * question, up to a few choices, and always a line to write one's own answer.
       * Answered through `AgentSession.answer`; `null` there means the person skipped it.
       */
      type: 'question.asked';
      id: string;
      question: string;
      choices: string[];
      /** `tool.started.id` of the tool call that asked, when the adapter can tell. */
      toolId?: string | null;
    }
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | {
      /** Cumulative token totals for the turn, as the agent reports them. */
      type: 'usage';
      modelLabel?: string | null;
      providerId?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      /**
       * What the turn cost, when the adapter can say. The gateway adapters cannot — they
       * report tokens and the runtime keeps the invoice — so they leave it unset and the
       * ledger records `unknown`. The `builtin` adapter made the request against a model
       * row that carries published prices, so it reports an `estimated` number.
       */
      costMicroUsd?: number;
      costSource?: 'provider' | 'estimated' | 'unknown';
    }
  | { type: 'context'; usedTokens: number; windowTokens?: number | null }
  | {
      /**
       * The turn moved down the fallback chain (contract decision §54): the models in
       * `failed` refused it, in order, with an error another model could get past, and
       * `answered` is the one that took it — or, when the run then failed, the last tried.
       * `provider` is the hub's provider slug, when known.
       */
      type: 'model.fallback';
      failed: FallbackAttempt[];
      answered: { model: string; provider: string | null };
    }
  | { type: 'run.completed'; stopReason: string; interrupted?: boolean }
  | {
      type: 'run.failed';
      error: string;
      /**
       * One of the contract's `ErrorCode`s, when the adapter already knows which. The
       * gateway adapters do not — they get one flattened sentence and the runner reads
       * the code out of its wording (`runner.ts` §`failureCode`). The `builtin` adapter
       * made the request itself, so it says so instead of leaving it to be guessed.
       */
      code?: string;
    };

export interface ApprovalOption {
  id: string;
  label: string;
  /**
   * What choosing it means, in the agent's words: ACP `allow_once` / `allow_always` /
   * `reject_once` / `reject_always`; Hermes `once` / `session` / `always` / `deny`.
   */
  kind: string;
}

/**
 * One block of the turn's prompt, as `sessions` handed it over.
 *
 * The process adapters read `PromptInput.text`, where the hub has already flattened
 * these into one string naming each attachment's path — Hermes's run surface and ACP's
 * prompt both take text, and both agents have file tools to open a path with. The
 * `builtin` adapter has neither, so it reads the blocks and puts the bytes in the
 * request itself.
 */
export type PromptBlock =
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

export interface PromptInput {
  /** Plain text of the person's message, attachments named by path. */
  text: string;
  /**
   * The same turn, unflattened. Set on every run; read only by an adapter that carries
   * the bytes itself rather than pointing the agent at a path.
   */
  blocks?: readonly PromptBlock[];
  /**
   * What this turn should run on, resolved by the hub: the model id as its provider
   * names it, and the name the agent runtime knows that provider by.
   *
   * Per turn, not per session. The person can change the model in the composer between
   * turns, and a Hermes conversation outlives every one of them — a selection taken only
   * at `start()` would silently keep running the first model chosen. Hermes's run surface
   * takes both on every `POST /v1/runs` (ADR 0008 §1), which is why this is expressible
   * at all. Absent = whatever the session was started with.
   */
  model?: string | null;
  modelProvider?: string | null;
  /**
   * The hub's own `providers` row id behind that model.
   *
   * `modelProvider` above is a *name* the agent's runtime knows — Hermes's slug, or the
   * `providers:` block the hub wrote for it — and it is meaningless to an adapter that
   * has no runtime. The `builtin` adapter needs the row, because it is the hub itself
   * that will make the request.
   */
  modelProviderId?: string | null;
  /** The hub's slug for the provider of `model`, for saying which model answered. */
  modelProviderSlug?: string | null;
  /**
   * The profile's fallback chain for this turn, without the model above (contract decision
   * §54). Hermes reads its own copy from `config.yaml` and uses this only to name what it
   * switched to; the `builtin` adapter hands it to the models module, which walks it.
   */
  fallbacks?: readonly FallbackModel[];
  reasoningEffort?: string | null;
}

/** One model of a fallback chain that failed a turn (contract `RunFallbackAttempt`). */
export interface FallbackAttempt {
  model: string;
  /** The hub's provider slug, when known. */
  provider: string | null;
  /** A contract `ErrorCode`; `null` when the runtime switched without saying why. */
  code: string | null;
  /** The provider's own words, when it sent any. */
  error: string | null;
}

/**
 * One model the turn may move on to when the chosen one fails (contract decision §54), in
 * every vocabulary an adapter might need: the hub's row id (the `builtin` adapter makes the
 * request itself), the runtime's name for the provider (Hermes), and the hub's slug.
 */
export interface FallbackModel {
  providerId: string;
  /** The name the agent runtime knows the provider by; null when it cannot be told. */
  provider: string | null;
  /** The hub's provider slug. */
  slug: string;
  model: string;
}

/** A live conversation with one agent. */
export interface AgentSession {
  readonly id: string;
  /** Hands the agent a turn; resolves when the agent stops. */
  send(prompt: PromptInput): Promise<{ stopReason: string }>;
  /** Everything the agent emits, in order, until the session closes. */
  stream(): AsyncIterable<AgentEvent>;
  /** Answer an `approval.requested` the agent is blocked on. */
  respond(approvalId: string, optionId: string): Promise<void>;
  /** Answer a `question.asked`: the person's words, or `null` when they skipped it. */
  answer?(questionId: string, text: string | null): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  /**
   * The subagents this conversation's agent delegates to (contract decision §56), on a channel
   * of their own because one can outlive the turn that started it. Absent: the agent never
   * says it delegated.
   */
  readonly subagents?: SubagentControl;
}

export interface SettingsChoice {
  value: string;
  label: string;
}

/** The contract's `SettingsField`. */
export interface SettingsField {
  key: string;
  label: { ar: string; en: string };
  kind: 'text' | 'secret' | 'integer' | 'number' | 'toggle' | 'choice' | 'list' | 'json';
  value: unknown;
  options: SettingsChoice[];
  min: number | null;
  max: number | null;
  hint: string | null;
}

/** The contract's `SettingsSection`. */
export interface SettingsSection {
  key: string;
  title: { ar: string; en: string };
  restart_required: boolean;
  fields: SettingsField[];
}

export interface AgentAdapter {
  readonly kind: AdapterKind;
  readonly name: string;
  /** Version of the adapter code, not of the agent. */
  readonly version: string;
  /** True while the adapter is declared but must not be chosen (ADR 0002 harness). */
  readonly selectable: boolean;
  /** The capability floor every agent driven by this adapter supports. */
  capabilities(): AgentCapability[];
  discover(): Promise<DiscoveredAgent[]>;
  probe(target: AgentTarget): Promise<AgentProbe>;
  /** The settings form for one agent, with the stored values filled in. */
  settings(target: AgentTarget, stored: Record<string, unknown>): SettingsSection[];
  start(target: AgentTarget): Promise<AgentSession>;
}
