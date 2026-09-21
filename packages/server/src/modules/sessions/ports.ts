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

/** One block of the prompt handed to the agent. Attachments travel by id. */
export type AgentPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachmentId: string; kind: 'image' | 'file' | 'audio' }
  | { type: 'location'; latitude: number; longitude: number };

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
  | { type: 'context'; usedTokens: number; windowTokens?: number | null }
  | { type: 'completed' }
  | { type: 'failed'; code?: string; message: string };

/** What a person's answer to an approval or question sends back to the agent. */
export interface AgentRunInput {
  approvalRef: string;
  decision: 'approve_once' | 'approve_session' | 'approve_always' | 'deny' | null;
  answer: string | null;
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
}

export interface SessionsPorts {
  agents: AgentDirectory;
  runner: AgentRunner;
  /** No event for this long ends the run as `timed_out` (run state machine). */
  agentTimeoutMs: number;
}
