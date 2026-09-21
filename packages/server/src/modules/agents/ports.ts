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
  | { type: 'attachment'; attachmentId: string; kind: 'image' | 'file' | 'audio' }
  | { type: 'location'; latitude: number; longitude: number };

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
  allowedTools: string[];
}

export interface RunnerRunAccepted {
  agentSessionRef?: string | null;
  agentRunRef?: string | null;
}

export type RunnerToolKind =
  | 'shell'
  | 'file_read'
  | 'file_write'
  | 'search'
  | 'web'
  | 'mcp'
  | 'device'
  | 'custom';

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

export interface AgentRunnerPort {
  start(request: RunnerRunRequest): Promise<RunnerRunAccepted>;
  stream(runId: string): AsyncIterable<RunnerEvent>;
  send(runId: string, input: RunnerRunInput): Promise<void>;
  interrupt(runId: string): Promise<void>;
}
