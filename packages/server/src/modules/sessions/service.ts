/**
 * The use cases behind the `sessions` operations of the contract.
 *
 * Routes parse and answer; this file decides. Everything it returns is
 * already in the contract's wire shape (`mappers.ts`), so a route is a
 * one-liner and there is exactly one place where a rule lives.
 */
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
import { preview, type SessionFilters } from './store.js';
import type { MessagePart } from './schema.js';

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

  async create(scope: EngineScope, input: SessionCreateInput): Promise<Record<string, unknown>> {
    const agent = await this.requireAgent(scope, input.agent_id);
    // Resolved before the row is minted: a refused path must not leave a session behind.
    const root = this.rootOf(scope);
    const asked = input.working_dir?.trim() ? input.working_dir.trim() : null;
    const row = this.store.createSession({
      workspace: scope.workspace,
      ownerId: scope.userId,
      agentId: agent.id,
      title: input.title ?? null,
      source: 'chat',
      modelLabel: input.model ?? agent.defaultModel,
      provider: input.provider ?? agent.defaultProvider,
      reasoningEffort: input.reasoning_effort ?? null,
      // The folder is named after the session when nobody chose one, so it is
      // unique by construction; the id exists only after the insert.
      workingDir: null,
      categoryId: input.category_id ?? null,
      parentSessionId: null,
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
            ? { message_id: hit.id, snippet: preview(hit.content) ?? '' }
            : { message_id: null, snippet: row.title ?? '' };
        }
        return session;
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

  update(scope: EngineScope, sessionId: string, patch: SessionPatchInput): Record<string, unknown> {
    const row = this.requireSession(scope, sessionId);
    if (patch.category_id !== undefined && patch.category_id !== null) {
      // `session_categories` is declared in the contract but has no table yet;
      // refusing is honest, silently dropping the field would not be.
      throw new HubError('not_implemented', {
        details: { field: 'category_id', operation: 'sessions.listCategories' },
      });
    }
    const changes: Partial<SessionRow> = {};
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.pinned !== undefined) changes.pinned = patch.pinned;
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

    const updated = this.store.updateSession(scope.workspace, row.id, changes) ?? row;
    const payload = this.sessionOf(scope, updated);
    this.realtime.emitToProfile(scope.profile, 'session.updated', { session: payload });
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

  bulkUpdate(
    scope: EngineScope,
    sessionIds: string[],
    patch: SessionPatchInput,
  ): { results: Array<{ id: string; ok: boolean; error: unknown }> } {
    return {
      results: sessionIds.map((id) => {
        try {
          this.update(scope, id, patch);
          return { id, ok: true, error: null };
        } catch (error) {
          return { id, ok: false, error: envelopeOf(error, scope.language) };
        }
      }),
    };
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

  fork(scope: EngineScope, sessionId: string, input: SessionForkInput): Record<string, unknown> {
    const source = this.requireSession(scope, sessionId);
    const cutoff = input.at_message_id
      ? this.store.getMessage(scope.workspace, input.at_message_id)
      : undefined;
    if (input.at_message_id && (!cutoff || cutoff.sessionId !== source.id)) {
      throw notFound({ resource: 'message', id: input.at_message_id });
    }
    const fork = this.store.createSession({
      workspace: scope.workspace,
      ownerId: scope.userId,
      agentId: source.agentId,
      title: input.title ?? source.title,
      source: source.source,
      modelLabel: source.modelLabel,
      provider: source.provider,
      reasoningEffort: source.reasoningEffort,
      workingDir: source.workingDir,
      categoryId: source.categoryId,
      parentSessionId: source.id,
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

  // ------------------------------------------------------------- messages

  listMessages(
    scope: EngineScope,
    sessionId: string,
    before: string | undefined,
    limit: number,
  ): { items: Record<string, unknown>[]; has_more: boolean } {
    this.requireSession(scope, sessionId);
    const page = this.store.listMessages(scope.workspace, sessionId, before, limit);
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
    const resolved = await this.engine.resolveApproval(scope, row, { status, decision, answer });
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
          : { kind: 'system' as const, id: null, name: 'Majlis', avatar: null };
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

  private approvalOf(scope: EngineScope, row: ApprovalRow): Record<string, unknown> {
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
