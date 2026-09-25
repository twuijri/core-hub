/**
 * The subagents of each conversation (contract decision §47).
 *
 * An agent reports its delegations on a channel of their own (`AgentRunner.onSubagent`),
 * between turns too, because one can outlive the turn that started it. This book folds those
 * reports into one record per subagent, announces every change profile-wide
 * (`subagent.started` / `.updated` / `.completed`), and keeps the conversation's last 50 in
 * its `metadata.subagents`, written when one starts and when it ends — a tool call in between
 * is announced, not written.
 *
 * What is live is held here, per process. A record stored as running that this process never
 * saw is a subagent a restart cut short: it reads `interrupted`.
 */
import { HubError, notFound } from '../../lib/errors.js';
import type { AgentSubagentControl, AgentSubagentSignal } from './ports.js';
import type { SessionsRealtime } from './realtime.js';
import type { SessionsStore } from './store.js';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type SubagentSupport = 'full' | 'observe' | 'none';

export interface SubagentToolRecord {
  name: string;
  preview: string | null;
  at: number;
}

/** One subagent as the hub keeps it; times are epoch milliseconds. */
export interface SubagentRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  parentId: string | null;
  depth: number;
  goal: string;
  model: string | null;
  status: SubagentStatus;
  startedAt: number;
  finishedAt: number | null;
  toolCount: number | null;
  lastTool: string | null;
  acceptingSteer: boolean;
  summary: string | null;
  tools: SubagentToolRecord[];
  /** The delegating tool call in the parent's stream, when the agent names one (ACP). */
  toolCallRef: string | null;
}

/** Where a conversation lives, remembered from its runs so a report between turns can be told. */
export interface SubagentScope {
  workspace: string;
  profile: string;
  /** The conversation's owner: whose Background panel its subagents are in. */
  ownerId: string;
}

export interface SubagentBookDeps {
  store: SessionsStore;
  realtime: SessionsRealtime;
  /** The run going on in a session right now, if any. */
  activeRunOf(sessionId: string): string | null;
  control(sessionId: string): AgentSubagentControl | null;
  now?: () => number;
}

/** How many a conversation keeps, and how many tools each keeps. */
export const KEPT_SUBAGENTS = 50;
export const KEPT_TOOLS = 50;
const SUMMARY_MAX = 2000;
const GOAL_MAX = 2000;
/** How long a finished one stays in the Background panel's "Finished". */
export const FINISHED_WINDOW_MS = 24 * 60 * 60_000;
const FINISHED_KEPT = 200;

const clip = (text: string | null | undefined, max: number): string | null =>
  text == null ? null : text.length > max ? `${text.slice(0, max)}…` : text;

export class SubagentBook {
  /** Live records, by session then subagent id. */
  private readonly live = new Map<string, Map<string, SubagentRecord>>();
  private readonly scopes = new Map<string, SubagentScope>();
  /** Finished in this process, newest last, for the Background panel. */
  private readonly finished: Array<{ record: SubagentRecord; scope: SubagentScope }> = [];
  private readonly now: () => number;

  constructor(private readonly deps: SubagentBookDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A run of this conversation started here: its reports can now be told to its profile. */
  remember(sessionId: string, scope: SubagentScope): void {
    this.scopes.set(sessionId, scope);
  }

  /** One report from the agent. Unknown sessions (never run in this process) are ignored. */
  onSignal(sessionId: string, signal: AgentSubagentSignal): void {
    const scope = this.scopes.get(sessionId);
    if (!scope) return;
    let records = this.live.get(sessionId);
    if (!records) {
      records = new Map();
      this.live.set(sessionId, records);
    }
    const now = this.now();
    let record = records.get(signal.id);
    const isNew = !record;
    if (!record) {
      if (signal.phase === 'completed' && this.storedFinished(scope, sessionId, signal.id)) return;
      record = {
        id: signal.id,
        sessionId,
        runId: this.deps.activeRunOf(sessionId),
        parentId: signal.parentId ?? null,
        depth: signal.depth ?? 0,
        goal: clip(signal.goal, GOAL_MAX) ?? '',
        model: signal.model ?? null,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        toolCount: signal.toolCount === undefined ? null : signal.toolCount,
        lastTool: null,
        acceptingSteer: signal.acceptingSteer ?? false,
        summary: null,
        tools: [],
        toolCallRef: signal.toolCallRef ?? null,
      };
      records.set(signal.id, record);
    } else {
      if (signal.parentId !== undefined && signal.parentId !== null)
        record.parentId = signal.parentId;
      if (signal.depth !== undefined && signal.depth !== null) record.depth = signal.depth;
      if (signal.goal) record.goal = clip(signal.goal, GOAL_MAX) ?? record.goal;
      if (signal.model) record.model = signal.model;
      if (signal.acceptingSteer !== undefined) record.acceptingSteer = signal.acceptingSteer;
    }

    if (signal.phase === 'tool') {
      const name = signal.toolName ?? 'tool';
      record.tools.push({ name, preview: clip(signal.toolPreview, 300), at: now });
      if (record.tools.length > KEPT_TOOLS)
        record.tools.splice(0, record.tools.length - KEPT_TOOLS);
      record.lastTool = name;
      record.toolCount =
        signal.toolCount !== undefined && signal.toolCount !== null
          ? signal.toolCount
          : (record.toolCount ?? 0) + 1;
    } else if (signal.toolCount !== undefined && signal.toolCount !== null) {
      record.toolCount = signal.toolCount;
    }

    if (signal.phase === 'completed') {
      record.status = signal.status ?? 'completed';
      record.finishedAt = now;
      record.acceptingSteer = false;
      record.summary = clip(signal.summary, SUMMARY_MAX);
      records.delete(record.id);
      if (records.size === 0) this.live.delete(sessionId);
      this.finished.push({ record, scope });
      this.trimFinished();
      this.persist(scope, record);
      this.announce(scope, record, 'subagent.completed');
      return;
    }
    if (isNew) {
      this.persist(scope, record);
      this.announce(scope, record, 'subagent.started');
      return;
    }
    this.announce(scope, record, 'subagent.updated');
  }

  /** A conversation's subagents: running first (oldest first), then finished (newest first). */
  list(workspace: string, sessionId: string): SubagentRecord[] {
    const live = this.live.get(sessionId) ?? new Map<string, SubagentRecord>();
    const stored = this.stored(workspace, sessionId).filter((row) => !live.has(row.id));
    const running = [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
    const finished = stored
      .map((row): SubagentRecord =>
        // Stored as running, and not running here: the hub restarted under it.
        row.status === 'running' ? { ...row, status: 'interrupted', acceptingSteer: false } : row,
      )
      .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
    return [...running.map((row) => ({ ...row, tools: [...row.tools] })), ...finished];
  }

  get(workspace: string, sessionId: string, id: string): SubagentRecord {
    const found = this.list(workspace, sessionId).find((row) => row.id === id);
    if (!found) throw notFound({ resource: 'subagent', id });
    return found;
  }

  isRunning(sessionId: string, id: string): boolean {
    return this.live.get(sessionId)?.has(id) ?? false;
  }

  /**
   * Stop one. The agent confirms with its own `completed` report; one the agent no longer
   * knows is over already, and is closed here so it does not read running for ever.
   */
  async interrupt(workspace: string, sessionId: string, id: string): Promise<SubagentRecord> {
    const record = this.running(workspace, sessionId, id);
    const control = this.deps.control(sessionId);
    if (!control?.interrupt) {
      throw new HubError('state_invalid', { details: { reason: 'unsupported' } });
    }
    const found = await control.interrupt(id);
    const scope = this.scopes.get(sessionId);
    if (!found && this.isRunning(sessionId, id)) {
      this.onSignal(sessionId, { phase: 'completed', id, status: 'interrupted', summary: null });
    } else if (scope && this.isRunning(sessionId, id) && record.acceptingSteer) {
      record.acceptingSteer = false;
      this.announce(scope, record, 'subagent.updated');
    }
    return this.get(workspace, sessionId, id);
  }

  async steer(
    workspace: string,
    sessionId: string,
    id: string,
    text: string,
  ): Promise<'queued' | 'rejected'> {
    const record = this.running(workspace, sessionId, id);
    const control = this.deps.control(sessionId);
    if (!control?.steer) {
      throw new HubError('state_invalid', { details: { reason: 'unsupported' } });
    }
    if (!record.acceptingSteer) {
      throw new HubError('state_invalid', { details: { reason: 'not_accepting_steer' } });
    }
    return control.steer(id, text);
  }

  async tail(
    workspace: string,
    sessionId: string,
    id: string,
  ): Promise<{ available: boolean; text: string; truncated: boolean }> {
    this.get(workspace, sessionId, id);
    const none = { available: false, text: '', truncated: false };
    if (!this.isRunning(sessionId, id)) return none;
    const control = this.deps.control(sessionId);
    if (!control?.tail) return none;
    return control.tail(id).catch(() => none);
  }

  /** Every running subagent of these workspaces' conversations owned by `ownerId`. */
  runningFor(
    ownerId: string,
    workspaces: ReadonlySet<string>,
  ): Array<{ record: SubagentRecord; scope: SubagentScope }> {
    const out: Array<{ record: SubagentRecord; scope: SubagentScope }> = [];
    for (const [sessionId, records] of this.live) {
      const scope = this.scopes.get(sessionId);
      if (!scope || scope.ownerId !== ownerId || !workspaces.has(scope.workspace)) continue;
      for (const record of records.values()) out.push({ record, scope });
    }
    return out;
  }

  /** The ones that finished in this process within the window, newest first. */
  finishedFor(
    ownerId: string,
    workspaces: ReadonlySet<string>,
    since: number,
  ): Array<{ record: SubagentRecord; scope: SubagentScope }> {
    return this.finished
      .filter(
        ({ record, scope }) =>
          scope.ownerId === ownerId &&
          workspaces.has(scope.workspace) &&
          (record.finishedAt ?? 0) >= since,
      )
      .reverse();
  }

  // ------------------------------------------------------------ internals

  private running(workspace: string, sessionId: string, id: string): SubagentRecord {
    const live = this.live.get(sessionId)?.get(id);
    if (live) return live;
    this.get(workspace, sessionId, id);
    throw new HubError('state_invalid', { details: { reason: 'finished' } });
  }

  private announce(
    scope: SubagentScope,
    record: SubagentRecord,
    event: 'subagent.started' | 'subagent.updated' | 'subagent.completed',
  ): void {
    this.deps.realtime.emitToProfileFor(scope.profile, record.sessionId, event, {
      subagent: toSubagent(record),
    });
  }

  private stored(workspace: string, sessionId: string): SubagentRecord[] {
    const session = this.deps.store.getSession(workspace, sessionId);
    if (!session) throw notFound({ resource: 'session', id: sessionId });
    const raw = (session.metadata as { subagents?: unknown } | null)?.subagents;
    return Array.isArray(raw) ? raw.filter(isRecord) : [];
  }

  private storedFinished(scope: SubagentScope, sessionId: string, id: string): boolean {
    try {
      return this.stored(scope.workspace, sessionId).some(
        (row) => row.id === id && row.status !== 'running',
      );
    } catch {
      return false;
    }
  }

  private persist(scope: SubagentScope, record: SubagentRecord): void {
    const session = this.deps.store.getSession(scope.workspace, record.sessionId);
    if (!session) return;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const kept = Array.isArray(metadata.subagents) ? metadata.subagents.filter(isRecord) : [];
    const next = [
      ...kept.filter((row) => row.id !== record.id),
      { ...record, tools: [...record.tools] },
    ]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-KEPT_SUBAGENTS);
    this.deps.store.updateSession(scope.workspace, record.sessionId, {
      metadata: { ...metadata, subagents: next },
    });
  }

  private trimFinished(): void {
    const since = this.now() - FINISHED_WINDOW_MS;
    while (
      this.finished.length > 0 &&
      (this.finished.length > FINISHED_KEPT || (this.finished[0]!.record.finishedAt ?? 0) < since)
    ) {
      this.finished.shift();
    }
  }
}

function isRecord(value: unknown): value is SubagentRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SubagentRecord).id === 'string' &&
    typeof (value as SubagentRecord).startedAt === 'number'
  );
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The contract's `Subagent`. */
export function toSubagent(record: SubagentRecord) {
  return {
    id: record.id,
    session_id: record.sessionId,
    run_id: record.runId,
    parent_id: record.parentId,
    depth: record.depth,
    goal: record.goal,
    model: record.model,
    status: record.status,
    started_at: iso(record.startedAt) as string,
    finished_at: iso(record.finishedAt),
    tool_count: record.toolCount,
    last_tool: record.lastTool,
    accepting_steer: record.acceptingSteer,
    summary: record.summary,
    tools: record.tools.map((tool) => ({
      name: tool.name,
      preview: tool.preview,
      at: iso(tool.at) as string,
    })),
  };
}
