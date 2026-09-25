/**
 * What `sessions` needs from the rest of the hub, declared here so the module
 * compiles and is testable on its own (ARCHITECTURE §Modules: a module never
 * imports another module's internals).
 *
 * Two ports, both owned by the `agents` module once it lands
 * (`docs/adr/0002-agent-connectivity.md` — `AgentAdapter`):
 *
 * - `AgentDirectory` — "does this agent exist in this workspace, and can it
 *   take a turn right now?" Backed by the `agents` registry.
 * - `AgentRunner` — the four verbs a turn needs: `start`, `stream`, `send`,
 *   `interrupt`. This is the narrow slice of `AgentAdapter` that sessions
 *   uses; `discover`, `capabilities` and `settings` are the registry's
 *   business, not a run's.
 *
 * Until the adapters exist, the defaults in `unavailable.ts` answer
 * `404 not_found` / `422 agent_unavailable` — never a fake success — and
 * `testing/` holds a scripted implementation the tests drive. Wiring the real
 * adapter is one line in `src/modules/index.ts`.
 */

/** A registry entry, reduced to what starting a turn needs. */
export interface AgentInfo {
  id: string;
  name: string;
  /** `acp` | `hermes` | `process` (ADR 0002). Stored on the run for the UI. */
  adapterKind: string;
  /** Model the agent uses when the session does not override it. */
  defaultModel: string | null;
  defaultProvider: string | null;
  /** False when the agent is known but not installed / not running on this host. */
  available: boolean;
  /** Machine-readable reason for `available: false` (`not_installed`, `stopped`, …). */
  unavailableReason?: string;
}

export interface AgentDirectory {
  /** `null` when the workspace has no such agent — the caller answers 404. */
  find(workspace: string, agentId: string): Promise<AgentInfo | null>;
}

/**
 * One block of the prompt handed to the agent.
 *
 * An attachment travels by id **and** by the path it was written to inside the run's
 * input folder: Hermes's run surface takes text, not files (`POST /v1/runs` reads one
 * `input`), and its file tools take absolute paths. So the hub puts the bytes where the
 * agent can reach them and names the place. An adapter that grows a real attachment
 * channel later uses `attachmentId` instead; nothing else changes.
 */
export type AgentPromptBlock =
  | { type: 'text'; text: string }
  | {
      type: 'attachment';
      attachmentId: string;
      kind: 'image' | 'file' | 'audio';
      /** Original name, sanitised by `knowledge`. */
      name?: string;
      mime?: string;
      sizeBytes?: number;
      /** Absolute path inside the run's input folder; absent when nothing was written. */
      path?: string;
    }
  | { type: 'location'; latitude: number; longitude: number };

/** The folders one turn exchanges files through, told to the agent in the prompt. */
export interface AgentFileExchange {
  /** Where the attachments of this turn were copied. */
  inputDir: string;
  /** Where anything the agent wants the person to download must be written. */
  outputDir: string;
}

/**
 * `knowledge`'s file registry, as `sessions` needs it (ARCHITECTURE §Modules: the
 * consumer declares the port, `src/modules/index.ts` wires the owner's implementation).
 * The default is `noAttachments` in `unavailable.ts`: ids resolve to nothing and no
 * file is ever written, which is honest for a hub whose knowledge module is not wired.
 */
export interface AttachmentSummary {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  kind: string;
  url: string;
}

export interface MaterialisedAttachment {
  id: string;
  name: string;
  path: string;
  mime: string;
  sizeBytes: number;
}

export interface AttachmentsPort {
  resolve(workspace: string, ids: readonly string[]): Map<string, AttachmentSummary>;
  materialise(
    workspace: string,
    ids: readonly string[],
    directory: string,
  ): MaterialisedAttachment[];
  capture(
    scope: { workspace: string; userId: string },
    file: { path: string; relativePath: string; sizeBytes: number },
    sourceId: string,
  ): Promise<Omit<AttachmentSummary, 'url'>>;
}

export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  workspace: string;
  agentId: string;
  /** The agent's own session id from a previous turn; `null` opens a new one. */
  agentSessionRef: string | null;
  workingDir: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  prompt: AgentPromptBlock[];
  /** Where this turn reads files from and writes files to; `null` when files are off. */
  files: AgentFileExchange | null;
  /** Tool names the user already approved for the rest of this session. */
  allowedTools: string[];
}

export interface AgentRunAccepted {
  /** Echoed back so the hub can resume the same agent session next turn. */
  agentSessionRef?: string | null;
  agentRunRef?: string | null;
}

export type AgentToolKind =
  'shell' | 'file_read' | 'file_write' | 'search' | 'web' | 'mcp' | 'device' | 'custom';

export type AgentApprovalKind = 'tool_call' | 'plan' | 'memory_write' | 'skill_write' | 'question';

export interface AgentChoice {
  value: string;
  label: string;
}

/**
 * What an adapter reports while a turn runs. Deliberately flat and
 * transport-free: an ACP notification, a Hermes gateway frame and a parsed
 * PTY line all become one of these.
 */
export type AgentEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | {
      type: 'tool_started';
      ref: string;
      name: string;
      kind?: AgentToolKind;
      title?: string | null;
      input?: Record<string, unknown>;
      subagentId?: string | null;
    }
  | { type: 'tool_completed'; ref: string; output?: string | null; exitCode?: number | null }
  | { type: 'tool_failed'; ref: string; output?: string | null; exitCode?: number | null }
  | {
      type: 'approval_requested';
      ref: string;
      kind: AgentApprovalKind;
      title: string;
      description?: string | null;
      command?: string | null;
      choices?: AgentChoice[];
      allowAlways?: boolean;
      answerMode?: 'choice' | 'text' | 'both';
      /** `tool_started.ref` this approval gates, for `kind: tool_call`. */
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
  | { type: 'context'; usedTokens: number; windowTokens?: number | null; estimated?: boolean }
  /**
   * The agent is compressing the conversation's context on its own inside this run, because
   * the window was filling up (decision §52). `finished` follows before the run ends.
   */
  | { type: 'compression'; phase: 'started' | 'finished' }
  | { type: 'completed' }
  | { type: 'failed'; code?: string; message: string };

/** What a person's answer to an approval or question sends back to the agent. */
export interface AgentRunInput {
  approvalRef: string;
  decision: 'approve_once' | 'approve_session' | 'approve_always' | 'deny' | null;
  answer: string | null;
}

/**
 * One question put to an agent **outside** any run: no `Run` row, no job, no
 * `/rt/sessions` events, no tools, no folder, and no place in the conversation the
 * question is about. The hub uses it to ask a session's own agent for a title
 * (contract decision §26).
 *
 * It is a separate verb rather than a run because everything a run is for — ordering,
 * queueing, approvals, cancellation, the audit ledger, a person watching — is exactly
 * what this must not have.
 */
export interface AgentAskRequest {
  workspace: string;
  agentId: string;
  /** The conversation the question is *about*; never the one it is asked in. */
  sessionId: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  /** Give up after this long; the caller then uses its own fallback. */
  timeoutMs: number;
}

/**
 * Compress a conversation's context now, between runs (`sessions.compress`, decision §52).
 * The fields a run of this session would open the agent's conversation with, so the agent
 * compresses the same one.
 */
export interface AgentCompressRequest {
  sessionId: string;
  workspace: string;
  agentId: string;
  agentSessionRef: string | null;
  workingDir: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  /** What the summary should keep in view; `null` = the agent decides. */
  focus: string | null;
}

export interface AgentCompressResult {
  /** The agent's conversation id, when opening it for this minted or changed one. */
  agentSessionRef: string | null;
  status: 'compressed' | 'unchanged' | 'skipped';
  beforeTokens: number | null;
  afterTokens: number | null;
  beforeMessages: number | null;
  afterMessages: number | null;
  context: { usedTokens: number; windowTokens: number | null; estimated: boolean } | null;
  /** The agent's own words, untranslated. */
  message: string | null;
}

export interface AgentRunner {
  /** Hand the turn to the agent. Throws to fail the run before it streams. */
  start(request: AgentRunRequest): Promise<AgentRunAccepted>;
  /** The turn's events, in order, ending when the agent stops talking. */
  stream(runId: string): AsyncIterable<AgentEvent>;
  /** Deliver a person's decision to a run blocked on an approval. */
  send(runId: string, input: AgentRunInput): Promise<void>;
  /** Ask the agent to stop. The stream ends on its own terms afterwards. */
  interrupt(runId: string): Promise<void>;
  /**
   * Optional (see `AgentAskRequest`). An adapter that has no one-shot surface simply does
   * not declare it, and the caller falls back to something it can compute itself — a
   * hub that cannot name a session prettily still names it.
   */
  ask?(request: AgentAskRequest): Promise<string | null>;
  /**
   * Optional (decision §52). A runner without it cannot compress, and `sessions.compress`
   * says so (`409 state_invalid`, `command_unsupported`); so does one whose adapter throws
   * `HubError('state_invalid', {reason: 'command_unsupported'})`.
   */
  compress?(request: AgentCompressRequest): Promise<AgentCompressResult>;
  /** Optional: guidance into the run in flight without stopping it (`sessions.steerRun`). */
  steer?(runId: string, text: string): Promise<'queued' | 'rejected'>;
}

/**
 * Telling the person something happened while they were not looking.
 *
 * Sessions names the **event**, never the sentence: the wording, the person's language
 * and whether they asked to be told at all belong to `notify`. There is deliberately no
 * locale here — the notice is read later, by the recipient, whose own account says which
 * language that is; the language of the request that started the run is irrelevant. The default does nothing,
 * so a hub composed without it runs exactly as before rather than failing at 3 a.m.
 *
 * It is deliberately synchronous and returns nothing: a notice must never be able to
 * fail a run or make it wait.
 */
export interface SessionsNotifier {
  runFinished(input: {
    workspace: string;
    profile: string;
    userId: string;
    sessionId: string;
    sessionTitle: string;
    agentName: string;
    outcome: 'succeeded' | 'failed';
    reason: string | null;
  }): void;
  approvalRequested(input: {
    workspace: string;
    profile: string;
    userId: string;
    sessionId: string;
    agentName: string;
    what: string;
    /** What the notice opens instead of the session — a workflow run waiting at a step. */
    resource?: { kind: 'workflow_run'; id: string } | undefined;
  }): void;
}

/**
 * Where a person's answer to a workflow step's gate goes (`kind: workflow_step`). The
 * approval is this module's row; the paused run is `schedules`'s. The composition root
 * joins them (`registerWorkflowGate`), so neither module imports the other.
 */
export interface WorkflowGate {
  resolve(input: {
    workspace: string;
    profile: string;
    approvalId: string;
    workflowRunId: string;
    nodeId: string;
    approved: boolean;
    /** The words given with the answer: the reason for a `deny`. */
    answer: string | null;
    respondedBy: { id: string; name: string };
  }): Promise<void>;
}

export interface SessionsPorts {
  agents: AgentDirectory;
  runner: AgentRunner;
  /** `knowledge`'s file registry; the default stores nothing. */
  attachments: AttachmentsPort;
  /** Who to tell when a run ends or an approval is waiting; the default tells nobody. */
  notifier: SessionsNotifier;
  /** No event for this long ends the run as `timed_out` (run state machine). */
  agentTimeoutMs: number;
  /** Who continues a workflow when its gate is answered; `null` when nobody can. */
  gate?: (() => WorkflowGate | null) | undefined;
}
