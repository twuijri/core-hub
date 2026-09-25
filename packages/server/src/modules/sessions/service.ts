/**
 * The use cases behind the `sessions` operations of the contract.
 *
 * Routes parse and answer; this file decides. Everything it returns is
 * already in the contract's wire shape (`mappers.ts`), so a route is a
 * one-liner and there is exactly one place where a rule lives.
 */
import { PRODUCT } from '@corehub/contracts';
import { HubError, notFound } from '../../lib/errors.js';
import { t, type Language } from '../../i18n/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { newUlid } from '../../db/ids.js';
import { ensureWorkingDir, listWorkingDirs, workspaceRoot } from './working-dir.js';
import type { AuditService } from '../audit/index.js';
import { RunEngine, messageStatusOf, type EngineScope } from './engine.js';
import {
  toApproval,
  toMessage,
  toRun,
  toSession,
  type ApprovalRow,
  type MessageRow,
  type RunRow,
  type SessionRow,
} from './mappers.js';
import type { SessionsPorts } from './ports.js';
import type { SessionsRealtime } from './realtime.js';
import type { SessionsStore } from './store.js';
import { excerpt, type SessionFilters } from './store.js';
import type { MessagePart } from './schema.js';
import type { RunState } from './run-reducer.js';
import { buildTrajectory, type Trajectory } from './trajectory.js';

/** `undefined` is spelled out everywhere: `exactOptionalPropertyTypes` is on. */
export interface ContentBlockInput {
  type: 'text' | 'image' | 'file' | 'audio' | 'location';
  text?: string | undefined;
  attachment_id?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
}

export interface SessionCreateInput {
  agent_id: string;
  title?: string | null | undefined;
  model?: string | null | undefined;
  provider?: string | null | undefined;
  reasoning_effort?: string | null | undefined;
  working_dir?: string | null | undefined;
  category_id?: string | null | undefined;
}

export interface SessionPatchInput {
  title?: string | null | undefined;
  pinned?: boolean | undefined;
  archived?: boolean | undefined;
  category_id?: string | null | undefined;
  model?: string | null | undefined;
  provider?: string | null | undefined;
  reasoning_effort?: string | null | undefined;
  working_dir?: string | null | undefined;
  notify?: boolean | undefined;
}

export interface RunCreateInput {
  content: ContentBlockInput[];
  model?: string | null | undefined;
  provider?: string | null | undefined;
  reasoning_effort?: string | null | undefined;
  when?: 'queue' | 'next' | 'interrupt' | undefined;
  reply_to_message_id?: string | null | undefined;
}

export interface SessionForkInput {
  at_message_id?: string | null | undefined;
  title?: string | null | undefined;
  /** Continue the conversation with a different agent (contract decision §26). */
  agent_id?: string | null | undefined;
  model?: string | null | undefined;
  provider?: string | null | undefined;
}

/** A turn another module asks for (`startTurn`, `oneTurn`). */
export interface TurnInput {
  agentId: string;
  prompt: string;
  title: string;
  source: 'workflow' | 'schedule' | 'task';
  model?: string | null | undefined;
  provider?: string | null | undefined;
  /** The entity the turn serves; its id lands on the session and the run (`origin`). */
  origin?: { kind: 'task' | 'workflow' | 'schedule'; id: string | null } | undefined;
}

/** How a turn ended and what the agent said in it. */
export interface TurnResult {
  sessionId: string;
  runId: string;
  status: RunRow['status'];
  output: string;
  error: string | null;
  /** The run's error code (`stale` for one a restart cut short); `null` when it had none. */
  errorCode: string | null;
}

/** A turn that has started: its ids now, its ending when it comes. */
export interface TurnHandle {
  sessionId: string;
  runId: string;
  jobId: string;
  /** Resolves when the run is terminal; never rejects. */
  done: Promise<TurnResult>;
}

export interface ApprovalResponseInput {
  decision?: string | null | undefined;
  answer?: string | null | undefined;
}

export class SessionsService {
  readonly store: SessionsStore;
  readonly audit: AuditService;
  readonly engine: RunEngine;

  constructor(
    store: SessionsStore,
    audit: AuditService,
    private readonly realtime: SessionsRealtime,
    private readonly ports: SessionsPorts,
    private readonly log: FastifyBaseLogger,
    /** `${DATA_DIR}`; every session works under `<dataDir>/workspaces/<profile>`. */
    private readonly dataDir: string,
  ) {
    this.store = store;
    this.audit = audit;
    this.engine = new RunEngine({ store, audit, realtime, ports, log });
  }

  // ------------------------------------------------------------- sessions

  /** The root this workspace works in, and the folders already under it. */
  workingDirs(scope: EngineScope): { root: string; items: Array<{ name: string; path: string }> } {
    return listWorkingDirs(this.rootOf(scope));
  }

  async create(
    scope: EngineScope,
    input: SessionCreateInput,
    /**
     * Where the session came from, when not a person's chat (a workflow step, a task), and
     * which entity it serves — so the session's `origin` names the task it works on.
     */
    origin: {
      source?: SessionRow['source'];
      kind?: SessionRow['originKind'];
      id?: string | null;
    } = {},
  ): Promise<Record<string, unknown>> {
    const agent = await this.requireAgent(scope, input.agent_id);
    // Resolved before the row is minted: a refused path must not leave a session behind.
    const root = this.rootOf(scope);
    const asked = input.working_dir?.trim() ? input.working_dir.trim() : null;
    const row = this.store.createSession({
      workspace: scope.workspace,
      ownerId: scope.userId,
      agentId: agent.id,
      title: input.title ?? null,
      source: origin.source ?? 'chat',
      modelLabel: input.model ?? agent.defaultModel,
      provider: input.provider ?? agent.defaultProvider,
      reasoningEffort: input.reasoning_effort ?? null,
      // The folder is named after the session when nobody chose one, so it is
      // unique by construction; the id exists only after the insert.
      workingDir: null,
      categoryId: input.category_id ?? null,
      parentSessionId: null,
      ...(origin.kind ? { originKind: origin.kind, originId: origin.id ?? null } : {}),
    });
    let withDir: SessionRow;
    try {
      withDir =
        this.store.updateSession(scope.workspace, row.id, {
          workingDir: ensureWorkingDir(root, asked, row.id),
        }) ?? row;
    } catch (error) {
      // A path we refuse (or a disk we cannot write) must not leave a half-made session.
      this.store.deleteSession(scope.workspace, row.id);
      throw error;
    }
    const payload = this.sessionOf(scope, withDir);
    this.realtime.emitToProfile(scope.profile, 'session.created', { session: payload });
    return payload;
  }

  /**
   * `sessions.openGlobalAgent` (contract decision §46): the caller's own global-agent
   * conversation in this workspace, made with `agent_id` the first time. Two first opens at
   * once may both create one; the store always answers the oldest, so the younger is
   * removed at once and both callers land on the same conversation.
   */
  async openGlobalAgent(
    scope: EngineScope,
    input: { agent_id: string },
  ): Promise<{ session: Record<string, unknown>; created: boolean }> {
    const existing = this.store.findGlobalAgent(scope.workspace, scope.userId);
    if (existing) return { session: this.sessionOf(scope, existing), created: false };
    const session = await this.create(scope, input, { source: 'global_agent' });
    const first = this.store.findGlobalAgent(scope.workspace, scope.userId);
    if (first && first.id !== session.id) {
      await this.remove(scope, session.id as string);
      return { session: this.sessionOf(scope, first), created: false };
    }
    return { session, created: true };
  }

  list(
    scope: EngineScope,
    filters: SessionFilters,
    cursor: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; next_cursor: string | null } {
    const page = this.store.listSessions(scope.workspace, filters, cursor, limit);
    return {
      items: page.items.map((row) => {
        const session = this.sessionOf(scope, row);
        if (filters.q) {
          const hit = this.store.findMatch(scope.workspace, row.id, filters.q);
          session.match = hit
            ? { message_id: hit.id, snippet: excerpt(hit.content, filters.q) ?? '' }
            : { message_id: null, snippet: row.title ?? '' };
        }
        return session;
      }),
      next_cursor: page.nextCursor,
    };
  }

  /**
   * `sessions.list?profiles=all` (ADR 0016): one page over every workspace in `scopes`,
   * each item rendered in its own workspace — its `profile`, its usage, its match — as if
   * it had been listed there. `scopes` comes from `auth`, never from the request body.
   */
  listAcross(
    scopes: readonly EngineScope[],
    filters: SessionFilters,
    cursor: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; next_cursor: string | null } {
    const byWorkspace = new Map(scopes.map((scope) => [scope.workspace, scope]));
    const page = this.store.listSessions([...byWorkspace.keys()], filters, cursor, limit);
    return {
      items: page.items.flatMap((row) => {
        const scope = byWorkspace.get(row.workspace);
        if (!scope) return [];
        const session = this.sessionOf(scope, row);
        if (filters.q) {
          const hit = this.store.findMatch(scope.workspace, row.id, filters.q);
          session.match = hit
            ? { message_id: hit.id, snippet: excerpt(hit.content, filters.q) ?? '' }
            : { message_id: null, snippet: row.title ?? '' };
        }
        return [session];
      }),
      next_cursor: page.nextCursor,
    };
  }

  get(scope: EngineScope, sessionId: string): Record<string, unknown> {
    const row = this.requireSession(scope, sessionId);
    const live = this.store.liveRuns(scope.workspace, row.id);
    const queued = live.filter((run) => run.status === 'queued');
    const pending = this.store.pendingApprovals(scope.workspace, row.id);
    return {
      ...this.sessionOf(scope, row),
      runs: live.map((run) =>
        toRun(
          {
            row: run,
            queuePosition:
              run.status === 'queued' ? queued.findIndex((q) => q.id === run.id) + 1 : null,
            usage: this.audit.totalsForRun(scope.workspace, run.id),
          },
          scope.profile,
        ),
      ),
      pending_approvals: pending.map((approval) => this.approvalOf(scope, approval)),
    };
  }

  async update(
    scope: EngineScope,
    sessionId: string,
    patch: SessionPatchInput,
  ): Promise<Record<string, unknown>> {
    const row = this.requireSession(scope, sessionId);
    if (patch.category_id !== undefined && patch.category_id !== null) {
      // `session_categories` is declared in the contract but has no table yet;
      // refusing is honest, silently dropping the field would not be.
      throw new HubError('not_implemented', {
        details: { field: 'category_id', operation: 'sessions.listCategories' },
      });
    }
    const changes: Partial<SessionRow> = {};
    /**
     * Who owns the name (contract decision §26). A non-empty title is the person's own
     * and the hub never replaces it; `null` gives the naming back, and the hub names the
     * session again from its own first turn — the "Retitle" gesture, with no second verb
     * in the contract for it.
     */
    let renameAgain = false;
    if (patch.title !== undefined) {
      const typed = typeof patch.title === 'string' ? patch.title.trim() : null;
      changes.title = typed === '' ? null : typed;
      changes.titleSetByUser = typed !== null;
      renameAgain = typed === null;
    }
    if (patch.pinned !== undefined) changes.pinned = patch.pinned;
    // The global agent is reached from search and the pending-actions bar, not from the
    // list, so an archived one would have nowhere to be restored from (§46).
    if (patch.archived === true && row.source === 'global_agent') {
      throw new HubError('state_invalid', {
        details: { field: 'archived', reason: 'global_agent' },
      });
    }
    if (patch.archived !== undefined) changes.archivedAt = patch.archived ? new Date() : null;
    if (patch.model !== undefined) changes.modelLabel = patch.model;
    if (patch.provider !== undefined) changes.provider = patch.provider;
    if (patch.reasoning_effort !== undefined)
      changes.reasoningEffort = patch.reasoning_effort as SessionRow['reasoningEffort'];
    if (patch.working_dir !== undefined) {
      // Moving the ground under a conversation that has already run there would
      // make its own transcript lie, so it is only free before the first run.
      if (this.store.listRuns(scope.workspace, row.id, undefined, undefined, 1).items.length > 0) {
        throw new HubError('state_invalid', {
          details: { field: 'working_dir', reason: 'session_has_runs' },
        });
      }
      changes.workingDir = ensureWorkingDir(
        this.rootOf(scope),
        patch.working_dir?.trim() ? patch.working_dir.trim() : null,
        row.id,
      );
    }
    if (patch.notify !== undefined) changes.notify = patch.notify;
    if (patch.category_id === null) changes.categoryId = null;

    // Putting a conversation away puts its work away too (owner, 2026-09-24): an archived
    // chat whose agent kept working — and spending — would be out of sight, not stopped.
    if (patch.archived === true) await this.stopLiveRuns(scope, row.id);

    const updated = this.store.updateSession(scope.workspace, row.id, changes) ?? row;
    const payload = this.sessionOf(scope, updated);
    this.realtime.emitToProfile(scope.profile, 'session.updated', { session: payload });
    // After the answer, never before it: the new title arrives on its own
    // `session.updated`, so clearing a title is as fast as any other patch.
    if (renameAgain) this.engine.namer.schedule(scope, row.id);
    return payload;
  }

  async remove(scope: EngineScope, sessionId: string): Promise<void> {
    const row = this.requireSession(scope, sessionId);
    for (const run of this.store.liveRuns(scope.workspace, row.id)) {
      if (this.engine.isActive(run.id)) await this.engine.requestInterrupt(run.id);
      this.store.updateRun(scope.workspace, run.id, {
        status: 'cancelled',
        finishedAt: new Date(),
        cancelReason: 'session_deleted',
      });
    }
    this.store.deleteSession(scope.workspace, row.id);
    this.realtime.journal.forget(row.id);
    this.realtime.emitToProfile(scope.profile, 'session.deleted', { session_id: row.id });
  }

  /**
   * Stop every live run of a session the way the chat's Stop does (`cancelRun`): a queued
   * run is cancelled before it starts, an active one is interrupted and ends `cancelled`
   * when the agent acknowledges. Queued runs go first, or ending the active one would hand
   * the adapter the next in line. A run that ended in between is simply over.
   */
  private async stopLiveRuns(scope: EngineScope, sessionId: string): Promise<void> {
    const live = this.store.liveRuns(scope.workspace, sessionId);
    const ordered = [
      ...live.filter((run) => run.status === 'queued'),
      ...live.filter((run) => run.status !== 'queued'),
    ];
    for (const run of ordered) {
      try {
        await this.cancelRun(scope, sessionId, run.id);
      } catch (error) {
        if (!(error instanceof HubError && error.code === 'state_invalid')) throw error;
      }
    }
  }

  async bulkUpdate(
    scope: EngineScope,
    sessionIds: string[],
    patch: SessionPatchInput,
  ): Promise<{ results: Array<{ id: string; ok: boolean; error: unknown }> }> {
    const results = [];
    for (const id of sessionIds) {
      try {
        await this.update(scope, id, patch);
        results.push({ id, ok: true, error: null });
      } catch (error) {
        results.push({ id, ok: false, error: envelopeOf(error, scope.language) });
      }
    }
    return { results };
  }

  async bulkDelete(
    scope: EngineScope,
    sessionIds: string[],
  ): Promise<{ results: Array<{ id: string; ok: boolean; error: unknown }> }> {
    const results = [];
    for (const id of sessionIds) {
      try {
        await this.remove(scope, id);
        results.push({ id, ok: true, error: null });
      } catch (error) {
        results.push({ id, ok: false, error: envelopeOf(error, scope.language) });
      }
    }
    return { results };
  }

  /**
   * A fork carries the transcript, starts no run, and leaves the source untouched.
   *
   * With `agent_id` it is also how a conversation continues with a **different agent**
   * (contract decision §26): rewriting `agent_id` in place would leave a transcript half
   * of which was produced by an agent the row no longer names, and would abandon the
   * first agent's live session with no way back. Changing only the model is not a fork —
   * that stays `sessions.update`.
   */
  async fork(
    scope: EngineScope,
    sessionId: string,
    input: SessionForkInput,
  ): Promise<Record<string, unknown>> {
    const source = this.requireSession(scope, sessionId);
    const cutoff = input.at_message_id
      ? this.store.getMessage(scope.workspace, input.at_message_id)
      : undefined;
    if (input.at_message_id && (!cutoff || cutoff.sessionId !== source.id)) {
      throw notFound({ resource: 'message', id: input.at_message_id });
    }
    // An agent the hub does not have is refused *before* anything is written: a fork left
    // behind pointing at an agent that cannot answer would be a dead conversation with a
    // full transcript in it. Unknown id -> 404 from `requireAgent`; known but not
    // installed -> 422, naming the agent and its state.
    const agent = input.agent_id ? await this.requireAgent(scope, input.agent_id) : null;
    if (agent && !agent.available) {
      throw new HubError('agent_unavailable', {
        details: { agent_id: agent.id, status: agent.unavailableReason ?? 'unavailable' },
      });
    }
    const fork = this.store.createSession({
      workspace: scope.workspace,
      ownerId: scope.userId,
      agentId: agent?.id ?? source.agentId,
      title: input.title ?? source.title,
      // A fork is a new chat: the person keeps one global agent (§46).
      source: source.source === 'global_agent' ? 'chat' : source.source,
      // A new agent brings its own default model unless the caller named one; the same
      // agent keeps whatever the source was running on.
      modelLabel: input.model ?? (agent ? agent.defaultModel : source.modelLabel),
      provider: input.provider ?? (agent ? agent.defaultProvider : source.provider),
      reasoningEffort: source.reasoningEffort,
      workingDir: source.workingDir,
      categoryId: source.categoryId,
      parentSessionId: source.id,
      // A title the person wrote stays theirs in the fork too.
      titleSetByUser: input.title ? true : source.titleSetByUser,
    });
    // The transcript is copied; the runs are not — history is not re-executed.
    for (const message of this.store.allMessages(scope.workspace, source.id)) {
      if (cutoff && message.seq > cutoff.seq) break;
      this.store.appendMessage({
        workspace: scope.workspace,
        ownerId: message.ownerId,
        sessionId: fork.id,
        runId: null,
        role: message.role,
        authorKind: message.authorKind,
        authorId: message.authorId,
        content: message.content,
        parts: message.parts,
        attachmentIds: message.attachmentIds,
      });
    }
    const row = this.store.getSession(scope.workspace, fork.id) as SessionRow;
    const payload = this.sessionOf(scope, row);
    this.realtime.emitToProfile(scope.profile, 'session.created', { session: payload });
    return payload;
  }

  export(
    scope: EngineScope,
    sessionId: string,
    format: 'json' | 'markdown',
  ): { body: unknown; contentType: string; filename: string } {
    const row = this.requireSession(scope, sessionId);
    const messages = this.store.allMessages(scope.workspace, row.id);
    const session = this.sessionOf(scope, row);
    const filenameBase = `session-${row.id}`;
    if (format === 'markdown') {
      const lines = [`# ${row.title ?? 'Untitled session'}`, ''];
      for (const message of messages) {
        const who =
          message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Agent' : 'System';
        lines.push(`**${who}** — ${message.content}`, '');
      }
      return {
        body: lines.join('\n'),
        contentType: 'text/markdown; charset=utf-8',
        filename: `${filenameBase}.md`,
      };
    }
    return {
      body: { session, messages: messages.map((m) => this.messageOf(scope, m)) },
      contentType: 'application/json; charset=utf-8',
      filename: `${filenameBase}.json`,
    };
  }

  /**
   * The conversation as a timed list of steps with its metrics (contract
   * `sessions.getTrajectory`, decision §43). The same document is the session log the
   * person downloads. A live run is read from the engine, which holds what it has not
   * written yet.
   */
  trajectory(scope: EngineScope, sessionId: string, now = Date.now()): Trajectory {
    const row = this.requireSession(scope, sessionId);
    const runs = this.store.allRuns(scope.workspace, row.id);
    const ids = runs.map((run) => run.id);
    const live = new Map<string, RunState>();
    for (const id of ids) {
      const state = this.engine.liveState(id);
      if (state) live.set(id, state);
    }
    return buildTrajectory({
      sessionId: row.id,
      messages: this.store.allMessages(scope.workspace, row.id),
      runs,
      toolCalls: this.store.toolCallsForRuns(scope.workspace, ids),
      usage: this.audit.totalsForRuns(scope.workspace, ids),
      live,
      now,
    });
  }

  // ------------------------------------------------------------- messages

  listMessages(
    scope: EngineScope,
    sessionId: string,
    before: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; has_more: boolean } {
    this.requireSession(scope, sessionId);
    const page = this.store.listMessages(scope.workspace, sessionId, before, limit);
    // A cursor that is not a message of this conversation (another chat's, or one deleted)
    // is refused: answering with the newest page instead would hand a client paging back
    // the messages it already holds, as if they were older.
    if (!page) throw notFound({ resource: 'message', id: before ?? '' });
    return {
      items: page.items.map((row) => this.messageOf(scope, row)),
      has_more: page.hasMore,
    };
  }

  // ----------------------------------------------------------------- runs

  listRuns(
    scope: EngineScope,
    sessionId: string,
    status: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; next_cursor: string | null } {
    this.requireSession(scope, sessionId);
    const page = this.store.listRuns(scope.workspace, sessionId, status, cursor, limit);
    const usage = this.audit.totalsForRuns(
      scope.workspace,
      page.items.map((row) => row.id),
    );
    return {
      items: page.items.map((row) =>
        toRun({ row, queuePosition: null, usage: usage.get(row.id) }, scope.profile),
      ),
      next_cursor: page.nextCursor,
    };
  }

  getRun(scope: EngineScope, sessionId: string, runId: string): Record<string, unknown> {
    const row = this.requireRun(scope, sessionId, runId);
    return this.runOf(scope, row);
  }

  /**
   * Store the user's message and accept a run for it (contract
   * `sessions.createRun`, `202 RunAccepted`). The HTTP call never waits for
   * the agent: it returns the ids and the work continues on `/rt/sessions`.
   */
  async createRun(
    scope: EngineScope,
    sessionId: string,
    input: RunCreateInput,
    origin: { kind?: RunRow['originKind']; id?: string | null } = {},
  ): Promise<{ payload: Record<string, unknown>; started: Promise<void> }> {
    const session = this.requireSession(scope, sessionId);
    const agent = await this.requireAgent(scope, session.agentId);
    if (!agent.available) {
      throw new HubError('agent_unavailable', {
        details: { agent_id: agent.id, status: agent.unavailableReason ?? 'unavailable' },
      });
    }

    const when = input.when ?? 'queue';
    const active = this.store.activeRun(scope.workspace, session.id);
    if (active && when === 'interrupt') await this.engine.requestInterrupt(active.id);

    const { content, parts, attachmentIds } = readContent(input.content);
    // An id that names nothing would reach the agent as a promise of a file that is
    // not there. A 404 before the message is written is the honest answer.
    if (attachmentIds.length > 0) {
      const known = this.ports.attachments.resolve(scope.workspace, attachmentIds);
      const missing = attachmentIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw notFound({ resource: 'attachment', id: missing[0], missing });
      }
    }
    const message = this.store.appendMessage({
      workspace: scope.workspace,
      ownerId: scope.userId,
      sessionId: session.id,
      runId: null,
      role: content.startsWith('/') ? 'command' : 'user',
      authorKind: 'user',
      authorId: scope.userId,
      content,
      parts,
      attachmentIds,
    });

    const runId = newUlid();
    const jobId = this.audit.createJob({
      workspace: scope.workspace,
      ownerId: scope.userId,
      kind: 'sessions.run',
      entityKind: 'run',
      entityId: runId,
      input: { session_id: session.id, agent_id: agent.id, when },
    });
    const run = this.store.createRun({
      id: runId,
      workspace: scope.workspace,
      ownerId: scope.userId,
      sessionId: session.id,
      agentId: agent.id,
      jobId,
      triggerMessageId: message.id,
      modelLabel: input.model ?? session.modelLabel ?? agent.defaultModel,
      provider: input.provider ?? session.provider ?? agent.defaultProvider,
      reasoningEffort: input.reasoning_effort ?? session.reasoningEffort ?? null,
      adapterKind: agent.adapterKind,
      ...(origin.kind ? { originKind: origin.kind, originId: origin.id ?? null } : {}),
    });
    this.store.updateMessage(scope.workspace, message.id, { runId: run.id });

    this.realtime.emitToSession(scope.profile, session.id, 'message.created', {
      message: this.messageOf(
        scope,
        this.store.getMessage(scope.workspace, message.id) as MessageRow,
      ),
    });

    const queued = this.store
      .liveRuns(scope.workspace, session.id)
      .filter((row) => row.status === 'queued');
    const queuePosition = queued.findIndex((row) => row.id === run.id) + 1;
    this.realtime.emitToSession(scope.profile, session.id, 'run.queued', {
      run: toRun({ row: run, queuePosition: queuePosition || 1, usage: undefined }, scope.profile),
    });

    // `next` jumps the queue: everything queued before it waits one more turn.
    if (when === 'next' && queued.length > 1) {
      this.store.updateRun(scope.workspace, run.id, { createdAt: earliestQueuedTime(queued) });
    }

    return {
      payload: {
        job_id: jobId,
        run_id: run.id,
        message_id: message.id,
        queue_position: active || queued.length > 1 ? queuePosition || 1 : null,
      },
      started: this.engine.kick(scope, session.id),
    };
  }

  /**
   * One turn, started for something that is not a person at a keyboard, and handed back
   * **before it ends**: open a session of its own, send the prompt, answer with the ids at
   * once, and let `done` say how it ended.
   *
   * The session is an ordinary one — it shows in the history under its source, its tool
   * calls and approvals are the same as in a chat, and a run that asks for an approval
   * waits for a person exactly as a chat run does. A task needs the ids now (its route
   * answers `202` with them) and the ending later; a workflow step only needs the ending
   * (`oneTurn`).
   *
   * An agent that cannot take the turn is refused before anything is written: a session
   * left behind with no run in it would be a conversation nobody started.
   */
  async startTurn(scope: EngineScope, input: TurnInput): Promise<TurnHandle> {
    const agent = await this.requireAgent(scope, input.agentId);
    if (!agent.available) {
      throw new HubError('agent_unavailable', {
        details: { agent_id: agent.id, status: agent.unavailableReason ?? 'unavailable' },
      });
    }
    const session = await this.create(
      scope,
      {
        agent_id: input.agentId,
        title: input.title,
        model: input.model ?? null,
        provider: input.provider ?? null,
      },
      input.origin
        ? { source: input.source, kind: input.origin.kind, id: input.origin.id }
        : { source: input.source },
    );
    const sessionId = String(session.id);
    let accepted: Awaited<ReturnType<SessionsService['createRun']>>;
    try {
      accepted = await this.createRun(
        scope,
        sessionId,
        { content: [{ type: 'text', text: input.prompt }] },
        { kind: input.origin?.kind ?? input.source, id: input.origin?.id ?? null },
      );
    } catch (error) {
      // The same rule as above, for a refusal only `createRun` can see.
      this.store.deleteSession(scope.workspace, sessionId);
      this.realtime.emitToProfile(scope.profile, 'session.deleted', { session_id: sessionId });
      throw error;
    }
    const runId = String(accepted.payload.run_id);
    return {
      sessionId,
      runId,
      jobId: String(accepted.payload.job_id),
      done: accepted.started.then(
        () =>
          this.turnResult(scope.workspace, runId) ?? {
            sessionId,
            runId,
            status: 'failed' as const,
            output: '',
            error: 'the run was deleted before it ended',
            errorCode: null,
          },
      ),
    };
  }

  /**
   * A room seat's own conversation (`rooms`, DECISIONS §57): opened once when the seat is
   * added, then every turn the seat takes runs in it, so the agent keeps what it said
   * before. Source `room`, origin the seat, so it stays out of the chats list and its runs
   * name the seat. An agent that is not installed is refused before anything is written.
   */
  async openSeatSession(
    scope: EngineScope,
    input: {
      agentId: string;
      seatId: string;
      title: string;
      model?: string | null | undefined;
      provider?: string | null | undefined;
      reasoningEffort?: string | null | undefined;
      workingDir?: string | null | undefined;
    },
  ): Promise<string> {
    const agent = await this.requireAgent(scope, input.agentId);
    if (!agent.available) {
      throw new HubError('agent_unavailable', {
        details: { agent_id: agent.id, status: agent.unavailableReason ?? 'unavailable' },
      });
    }
    const session = await this.create(
      scope,
      {
        agent_id: input.agentId,
        title: input.title,
        model: input.model ?? null,
        provider: input.provider ?? null,
        reasoning_effort: input.reasoningEffort ?? null,
        working_dir: input.workingDir ?? null,
      },
      { source: 'room', kind: 'room', id: input.seatId },
    );
    return String(session.id);
  }

  /**
   * One turn of a room seat, in the seat's own session: the prompt is the room as the seat
   * has not yet seen it. Queued behind the seat's current turn, like a chat message sent
   * while the agent is still answering. The ids come back at once; `done` says how it ended.
   */
  async startSeatTurn(
    scope: EngineScope,
    input: { sessionId: string; seatId: string; prompt: string },
  ): Promise<TurnHandle> {
    const accepted = await this.createRun(
      scope,
      input.sessionId,
      { content: [{ type: 'text', text: input.prompt }] },
      { kind: 'room', id: input.seatId },
    );
    const runId = String(accepted.payload.run_id);
    const sessionId = input.sessionId;
    return {
      sessionId,
      runId,
      jobId: String(accepted.payload.job_id),
      done: accepted.started.then(
        () =>
          this.turnResult(scope.workspace, runId) ?? {
            sessionId,
            runId,
            status: 'failed' as const,
            output: '',
            error: 'the run was deleted before it ended',
            errorCode: null,
          },
      ),
    };
  }

  /** The contract's `Run` of each id that exists in the workspace, in the order asked. */
  runsById(scope: EngineScope, runIds: readonly string[]): Record<string, unknown>[] {
    return runIds
      .map((id) => this.store.getRun(scope.workspace, id))
      .filter((row): row is RunRow => !!row)
      .map((row) => this.runOf(scope, row));
  }

  /** Runs of several sessions — a room's seats — live first, then newest (`rooms.listRuns`). */
  runsOfSessions(
    scope: EngineScope,
    sessionIds: readonly string[],
    status: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; next_cursor: string | null } {
    const page = this.store.runsOfSessions(scope.workspace, sessionIds, status, cursor, limit);
    return {
      items: page.items.map((row) => this.runOf(scope, row)),
      next_cursor: page.nextCursor,
    };
  }

  /**
   * One whole turn, start to finish: `startTurn`, then wait for it. What comes back is how
   * it ended and what the agent said, which is all a workflow step needs.
   */
  async oneTurn(
    scope: EngineScope,
    input: { agentId: string; prompt: string; title: string; source: 'workflow' | 'schedule' },
  ): Promise<TurnResult> {
    const handle = await this.startTurn(scope, input);
    return handle.done;
  }

  /**
   * How a run stands and what its agent said in it — for a caller that holds a run id but
   * not the session (a task settling after a restart). `null` when there is no such run.
   */
  turnResult(workspace: string, runId: string): TurnResult | null {
    const run = this.store.getRun(workspace, runId);
    if (!run) return null;
    const output = this.store
      .allMessages(workspace, run.sessionId)
      .filter((message) => message.runId === runId && message.role === 'assistant')
      .map((message) => message.content)
      .join('\n')
      .trim();
    return {
      sessionId: run.sessionId,
      runId,
      status: run.status,
      output,
      error: run.errorMessage ?? run.errorCode ?? null,
      errorCode: run.errorCode ?? null,
    };
  }

  async cancelRun(
    scope: EngineScope,
    sessionId: string,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const row = this.requireRun(scope, sessionId, runId);
    if (isTerminalStatus(row.status)) {
      throw new HubError('state_invalid', {
        details: { from: row.status, allowed: [] },
      });
    }
    this.store.updateRun(scope.workspace, row.id, { interruptRequestedAt: new Date() });
    if (row.status === 'queued') {
      // Nothing has started: the run simply never happens.
      const cancelled = this.store.updateRun(scope.workspace, row.id, {
        status: 'cancelled',
        finishedAt: new Date(),
        cancelReason: 'cancelled_before_start',
      }) as RunRow;
      this.audit.finishJob(row.jobId, 'cancelled');
      const payload = this.runOf(scope, cancelled);
      this.realtime.emitToSession(scope.profile, sessionId, 'run.cancelled', { run: payload });
      return payload;
    }
    // Active: ask the adapter and report the run as it stands; the terminal
    // `run.cancelled` follows when the agent acknowledges (domain §sessions).
    await this.engine.requestInterrupt(row.id);
    return this.runOf(scope, this.store.getRun(scope.workspace, row.id) as RunRow);
  }

  // ------------------------------------------------------------ approvals

  listApprovals(
    scope: EngineScope,
    filters: { status?: string | undefined; session_id?: string | undefined },
    cursor: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; next_cursor: string | null } {
    const page = this.store.listApprovals(
      scope.workspace,
      { status: filters.status, sessionId: filters.session_id },
      cursor,
      limit,
    );
    return {
      items: page.items.map((row) => this.approvalOf(scope, row)),
      next_cursor: page.nextCursor,
    };
  }

  getApproval(scope: EngineScope, approvalId: string): Record<string, unknown> {
    const row = this.store.getApproval(scope.workspace, approvalId);
    if (!row) throw notFound({ resource: 'approval', id: approvalId });
    return this.approvalOf(scope, row);
  }

  async respondApproval(
    scope: EngineScope,
    approvalId: string,
    body: ApprovalResponseInput,
  ): Promise<Record<string, unknown>> {
    const row = this.store.getApproval(scope.workspace, approvalId);
    if (!row) throw notFound({ resource: 'approval', id: approvalId });
    if (row.status !== 'pending') {
      throw new HubError('state_invalid', { details: { from: row.status, allowed: [] } });
    }
    const decision = body.decision ?? null;
    const answer = body.answer ?? null;
    if (decision === null && answer === null) {
      throw new HubError('validation_failed', {
        details: { issues: [{ path: 'decision', message: 'decision or answer is required' }] },
      });
    }
    const status = decision === 'deny' ? 'denied' : decision ? 'approved' : 'answered';
    if (row.kind === 'workflow_step') return this.answerGate(scope, row, { decision, answer });
    const resolved = await this.engine.resolveApproval(scope, row, { status, decision, answer });
    return this.approvalOf(scope, resolved);
  }

  // ------------------------------------------------- workflow step gates

  /**
   * A workflow run paused at a step that needs a person (`schedules`' engine asks, through
   * the composition root). The gate is an ordinary approval — listed with the others, one
   * `respondApproval` answers it — that belongs to a workflow run instead of a session run.
   * Announced profile-wide and put in the inbox of whoever the run belongs to.
   */
  raiseWorkflowApproval(
    scope: { workspace: string; profile: string; userId: string },
    input: {
      workflowRunId: string;
      workflowId: string;
      workflowName: string;
      nodeId: string;
      title: string;
      description: string | null;
    },
  ): string {
    const id = newUlid();
    const now = new Date();
    const row = this.store.upsertApproval(scope.workspace, scope.userId, null, {
      id,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      toolCallId: null,
      kind: 'workflow_step',
      status: 'pending',
      title: input.title.slice(0, 200),
      description: input.description,
      payload: {
        choices: [
          { value: 'approve_once', label: 'Approve' },
          { value: 'deny', label: 'Deny' },
        ],
        answer_mode: 'both',
        workflow_id: input.workflowId,
        workflow_name: input.workflowName,
      },
      response: null,
      respondedByUserId: null,
      remember: false,
      requestedAt: now,
      respondedAt: null,
      expiresAt: null,
    });
    this.realtime.emitToProfile(scope.profile, 'approval.requested', {
      approval: this.approvalOf(scope, row),
    });
    try {
      this.ports.notifier.approvalRequested({
        workspace: scope.workspace,
        profile: scope.profile,
        userId: scope.userId,
        sessionId: '',
        agentName: input.workflowName,
        what: row.title,
        resource: { kind: 'workflow_run', id: input.workflowRunId },
      });
    } catch (error) {
      this.log.warn({ err: error }, 'notice not delivered');
    }
    return id;
  }

  /** A workflow run that stopped waiting (cancelled, deleted): its open gates close. */
  cancelWorkflowApprovals(
    scope: { workspace: string; profile: string },
    workflowRunId: string,
  ): number {
    let closed = 0;
    for (const row of this.store.pendingWorkflowApprovals(scope.workspace, workflowRunId)) {
      const done = this.store.resolvePending(scope.workspace, row.id, {
        status: 'cancelled',
        response: null,
        respondedByUserId: null,
      });
      if (!done) continue;
      closed += 1;
      this.realtime.emitToProfile(scope.profile, 'approval.resolved', {
        approval: this.approvalOf(scope, done),
      });
    }
    return closed;
  }

  /**
   * An answer to a workflow step's gate: recorded first (exactly once — a second answer or
   * one racing a cancel finds it no longer pending), then handed to the paused run.
   */
  private async answerGate(
    scope: EngineScope,
    row: ApprovalRow,
    input: { decision: string | null; answer: string | null },
  ): Promise<Record<string, unknown>> {
    const gate = this.ports.gate?.() ?? null;
    if (!gate || !row.workflowRunId || !row.nodeId) {
      throw new HubError('state_invalid', {
        details: { from: row.status, allowed: [], reason: 'workflow_gate_unavailable' },
      });
    }
    // A gate is a yes or a no: words alone (no decision) are a yes with a note.
    const approved = input.decision !== 'deny';
    const resolved = this.store.resolvePending(scope.workspace, row.id, {
      status: approved ? 'approved' : 'denied',
      response: { decision: input.decision ?? 'approve_once', answer: input.answer },
      respondedByUserId: scope.userId,
    });
    if (!resolved) {
      const now = this.store.getApproval(scope.workspace, row.id);
      throw new HubError('state_invalid', {
        details: { from: now?.status ?? 'gone', allowed: [] },
      });
    }
    this.realtime.emitToProfile(scope.profile, 'approval.resolved', {
      approval: this.approvalOf(scope, resolved),
    });
    await gate.resolve({
      workspace: scope.workspace,
      profile: scope.profile,
      approvalId: row.id,
      workflowRunId: row.workflowRunId,
      nodeId: row.nodeId,
      approved,
      answer: input.answer,
      respondedBy: { id: scope.userId, name: scope.userName },
    });
    return this.approvalOf(scope, resolved);
  }

  // ------------------------------------------------------------- shutdown

  async drain(): Promise<void> {
    await this.engine.settledAll();
  }

  /**
   * On boot, a run left mid-flight by a crash can never continue: its adapter
   * stream is gone. Mark them failed once, the way stale jobs are handled
   * (docs/domain/README.md §job), instead of showing a spinner forever.
   */
  recoverStaleRuns(): number {
    return this.store.failStaleRuns();
  }

  // ------------------------------------------------------------- internals

  /** `${DATA_DIR}/workspaces/<profile>` — the slug is already validated by the route. */
  private rootOf(scope: EngineScope): string {
    return workspaceRoot(this.dataDir, scope.profile);
  }

  private async requireAgent(scope: EngineScope, agentId: string) {
    const agent = await this.ports.agents.find(scope.workspace, agentId);
    if (!agent) throw notFound({ resource: 'agent', id: agentId });
    return agent;
  }

  private requireSession(scope: EngineScope, sessionId: string): SessionRow {
    const row = this.store.getSession(scope.workspace, sessionId);
    if (!row) throw notFound({ resource: 'session', id: sessionId });
    return row;
  }

  private requireRun(scope: EngineScope, sessionId: string, runId: string): RunRow {
    this.requireSession(scope, sessionId);
    const row = this.store.getRun(scope.workspace, runId);
    if (!row || row.sessionId !== sessionId) throw notFound({ resource: 'run', id: runId });
    return row;
  }

  sessionOf(scope: EngineScope, row: SessionRow): Record<string, unknown> {
    const live = this.store.liveRuns(scope.workspace, row.id);
    const lastRun =
      live[0] ?? (row.lastRunId ? this.store.getRun(scope.workspace, row.lastRunId) : undefined);
    return toSession(
      {
        row,
        lastRunStatus: lastRun?.status ?? null,
        activeRunId: live[0]?.id ?? null,
        usage: this.audit.totalsForSession(scope.workspace, row.id),
      },
      scope.profile,
    );
  }

  private runOf(scope: EngineScope, row: RunRow): Record<string, unknown> {
    const queued = this.store
      .liveRuns(scope.workspace, row.sessionId)
      .filter((r) => r.status === 'queued');
    return toRun(
      {
        row,
        queuePosition:
          row.status === 'queued' ? queued.findIndex((r) => r.id === row.id) + 1 : null,
        usage: this.audit.totalsForRun(scope.workspace, row.id),
      },
      scope.profile,
    );
  }

  private messageOf(scope: EngineScope, row: MessageRow): Record<string, unknown> {
    const run = row.runId ? this.store.getRun(scope.workspace, row.runId) : undefined;
    const toolCalls = row.runId
      ? (this.store.toolCallsForRuns(scope.workspace, [row.runId]).get(row.runId) ?? []).filter(
          (call) => call.messageId === row.id,
        )
      : [];
    const author =
      row.authorKind === 'user'
        ? { kind: 'user' as const, id: row.authorId, name: scope.userName, avatar: null }
        : row.authorKind === 'agent'
          ? { kind: 'agent' as const, id: row.authorId, name: 'agent', avatar: null }
          : { kind: 'system' as const, id: null, name: PRODUCT.name, avatar: null };
    return toMessage(
      {
        row,
        author,
        toolCalls,
        // `ContentBlock` carries `name`, `mime` and `size_bytes` on read; they live in
        // `knowledge`, so the row is resolved here rather than guessed in the mapper.
        attachments:
          row.attachmentIds.length > 0
            ? this.ports.attachments.resolve(scope.workspace, row.attachmentIds)
            : undefined,
        status:
          row.role === 'assistant' && run ? messageStatusOf(run.status) : ('complete' as const),
        usage:
          row.role === 'assistant' && row.runId
            ? this.audit.totalsForRun(scope.workspace, row.runId)
            : undefined,
      },
      scope.profile,
    );
  }

  private approvalOf(
    scope: { workspace: string; profile: string },
    row: ApprovalRow,
  ): Record<string, unknown> {
    if (!row.runId) {
      // A workflow step's gate: the one asking is the workflow, named as it was when it asked.
      const payload = row.payload as { workflow_id?: unknown; workflow_name?: unknown };
      return toApproval(
        {
          row,
          sessionId: null,
          messageId: null,
          agent: {
            id: typeof payload.workflow_id === 'string' ? payload.workflow_id : row.id,
            name: typeof payload.workflow_name === 'string' ? payload.workflow_name : 'workflow',
          },
        },
        scope.profile,
      );
    }
    const run = this.store.getRun(scope.workspace, row.runId);
    return toApproval(
      {
        row,
        sessionId: run?.sessionId ?? '',
        messageId: run?.finalMessageId ?? null,
        agent: { id: run?.agentId ?? '', name: 'agent' },
      },
      scope.profile,
    );
  }
}

function isTerminalStatus(status: RunRow['status']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status);
}

function earliestQueuedTime(queued: RunRow[]): Date {
  const earliest = Math.min(...queued.map((row) => row.createdAt.getTime()));
  return new Date(earliest - 1);
}

function envelopeOf(error: unknown, language: Language): { error: string; code: string } {
  if (error instanceof HubError) return error.toEnvelope(language);
  return { error: t('errors.internal', language), code: 'internal' };
}

/** `RunCreate.content` -> the Markdown the agent reads plus the parts we store. */
export function readContent(blocks: ContentBlockInput[]): {
  content: string;
  parts: MessagePart[];
  attachmentIds: string[];
} {
  const parts: MessagePart[] = [];
  const attachmentIds: string[] = [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
      texts.push(block.text);
    } else if (
      (block.type === 'image' || block.type === 'file' || block.type === 'audio') &&
      typeof block.attachment_id === 'string'
    ) {
      parts.push({ type: block.type, attachmentId: block.attachment_id });
      attachmentIds.push(block.attachment_id);
    } else if (
      block.type === 'location' &&
      typeof block.latitude === 'number' &&
      typeof block.longitude === 'number'
    ) {
      parts.push({ type: 'location', latitude: block.latitude, longitude: block.longitude });
    }
  }
  return { content: texts.join('\n\n'), parts, attachmentIds };
}
