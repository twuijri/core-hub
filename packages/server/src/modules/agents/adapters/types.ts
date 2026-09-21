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

export type AdapterKind = 'hermes' | 'acp' | 'harness' | 'builtin';

/** What the registry knows about one agent, as far as an adapter needs it. */
export interface AgentTarget {
  slug: string;
  name: string;
  /** argv to start the agent; never a shell string (AGENTS.md hard rules). */
  command: readonly string[];
  executablePath: string | null;
  /** Hermes: the gateway base URL. */
  endpoint: string | null;
  /** Non-secret environment for the process. */
  env?: Record<string, string>;
  /** Working directory for a session. */
  cwd?: string;
  /**
   * The agent's own id for a conversation the hub already had with it (Hermes `session_id`,
   * an ACP session id): `start()` resumes it; `null`/absent opens a new one.
   */
  sessionRef?: string | null;
  /** Model and reasoning effort the session or run asks for; `null` = the agent's default. */
  model?: string | null;
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
    }
  | { type: 'context'; usedTokens: number; windowTokens?: number | null }
  | { type: 'run.completed'; stopReason: string; interrupted?: boolean }
  | { type: 'run.failed'; error: string };

export interface ApprovalOption {
  id: string;
  label: string;
  /**
   * What choosing it means, in the agent's words: ACP `allow_once` / `allow_always` /
   * `reject_once` / `reject_always`; Hermes `once` / `session` / `always` / `deny`.
   */
  kind: string;
}

export interface PromptInput {
  /** Plain text of the person's message. Attachments arrive in a later slice. */
  text: string;
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
  interrupt(): Promise<void>;
  close(): Promise<void>;
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
