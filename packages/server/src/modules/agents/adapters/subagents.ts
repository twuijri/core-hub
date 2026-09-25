/**
 * Subagents: what an agent reports about the agents it delegates to (contract decision §49).
 *
 * A subagent is not part of a turn's stream. Hermes can keep one going after the turn that
 * started it (asynchronous delegation), and a report that arrived between turns would have no
 * turn to ride on. So an adapter hands these out on a channel of their own —
 * `AgentSession.subagents.watch` — and the hub keeps them per conversation.
 *
 * Two agents say something today, each in its own words, read here into one vocabulary:
 *
 * - **Hermes** (`full`), over its TUI gateway: `subagent.start`, `subagent.tool`,
 *   `subagent.complete` events carrying `subagent_id`, `parent_id`, `depth`, `goal`, `model`,
 *   `tool_count`, `status`, `summary` (Hermes's MIT source, `tui_gateway/tool_progress.py`
 *   `_progress_subagent` and `tools/delegate_tool_progress.py`), and the calls
 *   `subagent.list` / `subagent.interrupt` / `subagent.steer` / `subagent.tail`.
 * - **ACP agents** (`observe`), whose stream names a delegation as a tool call: Claude Code's
 *   bridge marks it `_meta.claudeCode.toolName = "Task"` (the newer name `Agent` too), OpenCode's
 *   is the `task` tool; both carry `subagent_type` in `rawInput` once the arguments are known.
 *   Its end is the tool call's end. Nothing else is said: no tools, no stop, no steer.
 */

export type SubagentOutcome = 'completed' | 'failed' | 'interrupted';

/** One report about one subagent. Absent fields are "not said", never "empty". */
export interface SubagentSignal {
  phase: 'started' | 'updated' | 'tool' | 'completed';
  id: string;
  parentId?: string | null;
  depth?: number | null;
  goal?: string | null;
  model?: string | null;
  /** `tool`: the tool it called, and the agent's one-line summary of the call. */
  toolName?: string | null;
  toolPreview?: string | null;
  /** How many tools it has called, when the agent counts them. */
  toolCount?: number | null;
  /** `completed`: how it ended, and its last words or why it failed. */
  status?: SubagentOutcome;
  summary?: string | null;
  /** Whether a note sent now would still reach it. */
  acceptingSteer?: boolean;
  /** The tool call in the parent's stream that started it (ACP), when there is one. */
  toolCallRef?: string | null;
}

/** One live subagent as the agent lists it (`SubagentControl.list`). */
export interface LiveSubagent {
  id: string;
  parentId: string | null;
  depth: number;
  goal: string;
  model: string | null;
  startedAt: number | null;
  toolCount: number | null;
  lastTool: string | null;
  acceptingSteer: boolean;
}

export interface SubagentTailText {
  available: boolean;
  text: string;
  truncated: boolean;
}

/** What a live conversation lets the hub do about its subagents. */
export interface SubagentControl {
  readonly support: 'full' | 'observe';
  /** Every report from now on; returns the unsubscribe. */
  watch(listener: (signal: SubagentSignal) => void): () => void;
  /** The ones still running, as the agent has them. */
  list?(): Promise<LiveSubagent[]>;
  /** Stop one; resolves whether the agent found it. */
  interrupt?(id: string): Promise<boolean>;
  steer?(id: string, text: string): Promise<'queued' | 'rejected'>;
  tail?(id: string): Promise<SubagentTailText>;
}

/**
 * The listeners of one conversation's reports; a listener that throws never stops the rest.
 * It remembers which subagents are still running, so a conversation that ends (its process
 * gone, the session closed) can say each of them was cut short rather than leave them running.
 */
export class SubagentSignals {
  private readonly listeners = new Set<(signal: SubagentSignal) => void>();
  private readonly running = new Set<string>();

  watch(listener: (signal: SubagentSignal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every subagent still running ends `interrupted`, with `reason` as its last words. */
  endAll(reason: string | null = null): void {
    for (const id of [...this.running]) {
      this.emit({
        phase: 'completed',
        id,
        status: 'interrupted',
        summary: reason,
        acceptingSteer: false,
      });
    }
  }

  emit(signal: SubagentSignal): void {
    if (signal.phase === 'completed') this.running.delete(signal.id);
    else this.running.add(signal.id);
    for (const listener of this.listeners) {
      try {
        listener(signal);
      } catch {
        // A listener's failure is its own; the agent's stream goes on.
      }
    }
  }
}

type Json = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;
const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;

/** Hermes's words for how a subagent ended, in ours. */
export function hermesOutcome(status: unknown): SubagentOutcome {
  const word = String(status ?? '').toLowerCase();
  if (word === 'completed' || word === 'complete' || word === 'ok' || word === 'success') {
    return 'completed';
  }
  if (word === 'interrupted' || word === 'cancelled' || word === 'canceled') return 'interrupted';
  return 'failed';
}

/**
 * A Hermes gateway event about a subagent, as a signal; `null` for the ones that change nothing
 * the hub shows (`subagent.thinking`, the batched `subagent.progress`, `spawn_requested` before
 * the child exists). An older Hermes that sends no `subagent_id` is identified by its delegation
 * and its place in the batch, which is what its own TUI falls back to.
 */
export function hermesSubagentSignal(type: string, payload: Json): SubagentSignal | null {
  const phase =
    type === 'subagent.start'
      ? 'started'
      : type === 'subagent.tool'
        ? 'tool'
        : type === 'subagent.complete'
          ? 'completed'
          : null;
  if (!phase) return null;
  const id =
    str(payload.subagent_id) ??
    `${str(payload.delegation_id) ?? 'delegation'}-${int(payload.task_index) ?? 0}`;
  const signal: SubagentSignal = { phase, id };
  if ('parent_id' in payload) signal.parentId = str(payload.parent_id);
  const depth = int(payload.depth);
  if (depth !== null) signal.depth = depth;
  const goal = str(payload.goal);
  if (goal) signal.goal = goal;
  const model = str(payload.model);
  if (model) signal.model = model;
  const toolCount = int(payload.tool_count);
  if (toolCount !== null) signal.toolCount = toolCount;
  if (phase === 'tool') {
    signal.toolName = str(payload.tool_name) ?? 'tool';
    signal.toolPreview = str(payload.tool_preview) ?? str(payload.text);
  }
  if (phase === 'completed') {
    signal.status = hermesOutcome(payload.status);
    signal.summary = str(payload.summary) ?? str(payload.text);
    signal.acceptingSteer = false;
  }
  if (phase === 'started') signal.acceptingSteer = true;
  return signal;
}

/** One entry of Hermes's `subagent.list`, or `null` for something that is not one. */
export function hermesLiveSubagent(entry: unknown): LiveSubagent | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as Json;
  const id = str(row.subagent_id);
  if (!id) return null;
  const started = typeof row.started_at === 'number' ? Math.round(row.started_at * 1000) : null;
  return {
    id,
    parentId: str(row.parent_id),
    depth: int(row.depth) ?? 0,
    goal: str(row.goal) ?? '',
    model: str(row.model),
    startedAt: started,
    toolCount: int(row.tool_count),
    lastTool: str(row.last_tool),
    acceptingSteer: row.accepting_steer === true,
  };
}

/** The tool names ACP agents delegate with (Claude Code's `Task`, since renamed `Agent`). */
const CLAUDE_DELEGATION_TOOLS = new Set(['Task', 'Agent']);

/** Where an ACP tool call says which agent tool it is, if anywhere. */
function claudeToolName(update: Json): string | null {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object') return null;
  const claude = (meta as Json).claudeCode;
  if (!claude || typeof claude !== 'object') return null;
  return str((claude as Json).toolName);
}

/**
 * The parent tool call an ACP update says it runs under, when its bridge says so. Claude
 * Code's bridge (0.16) does not: a subagent's own calls arrive flat. Read here so a bridge that
 * starts saying it is honoured without another change.
 */
export function acpParentToolRef(update: Json): string | null {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object') return null;
  const claude = (meta as Json).claudeCode;
  const fromClaude =
    claude && typeof claude === 'object'
      ? (str((claude as Json).parentToolUseId) ?? str((claude as Json).parent_tool_use_id))
      : null;
  return fromClaude ?? str((meta as Json).parentToolCallId);
}

/** Whether an ACP `tool_call` / `tool_call_update` is a delegation to a subagent. */
export function isAcpDelegation(update: Json): boolean {
  const claude = claudeToolName(update);
  if (claude) return CLAUDE_DELEGATION_TOOLS.has(claude);
  const input = update.rawInput;
  if (input && typeof input === 'object' && str((input as Json).subagent_type)) return true;
  // OpenCode's first report of its `task` tool comes before the arguments are known: its
  // title is the tool's name and its kind `think`.
  const title = str(update.title)?.toLowerCase();
  return title === 'task' && update.kind === 'think';
}

/** What an ACP delegation says about its subagent: its goal and the kind of agent it is. */
export function acpDelegationGoal(update: Json): string | null {
  const input = update.rawInput;
  const args = input && typeof input === 'object' ? (input as Json) : {};
  const description = str(args.description);
  const title = str(update.title);
  const titled = title && title.toLowerCase() !== 'task' ? title : null;
  return description ?? titled ?? str(args.prompt)?.slice(0, 200) ?? null;
}

/** The kind of subagent an ACP delegation asked for (`subagent_type`), shown as its model. */
export function acpDelegationAgent(update: Json): string | null {
  const input = update.rawInput;
  return input && typeof input === 'object' ? str((input as Json).subagent_type) : null;
}
