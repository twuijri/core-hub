/**
 * Every database read and write of the `sessions` module, in one place.
 *
 * Two rules hold for all of it:
 *
 * 1. **Workspace first.** Every statement filters by `workspace` (invariant 3,
 *    ADR 0005). There is no query here that can reach another workspace's row.
 * 2. **Ids come from the application.** ULIDs are minted before the insert
 *    (`src/db/ids.ts`), so a run can be reported to the client before its row
 *    is written (invariant 4).
 *
 * Paging is keyset, never offset: a cursor is the sort key of the last row
 * seen, so a page stays stable while new rows arrive at the top — which they
 * constantly do in a chat.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { ModuleDatabase } from '../../db/handle.js';
import { newUlid } from '../../db/ids.js';
import { approvals, messages, runs, sessions, toolCalls } from './schema.js';
import type { ApprovalRow, MessageRow, RunRow, SessionRow, ToolCallRow } from './mappers.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** `<sort value>|<id>`, base64url, opaque to the client (contract `Page.next_cursor`). */
export function encodeCursor(sortValue: number, id: string): string {
  return Buffer.from(`${sortValue}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { sortValue: number; id: string } | null {
  if (!cursor) return null;
  const [rawValue, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const sortValue = Number(rawValue);
  if (!id || !Number.isFinite(sortValue)) return null;
  return { sortValue, id };
}

export interface SessionFilters {
  agentId?: string | undefined;
  source?: string | undefined;
  categoryId?: string | undefined;
  pinned?: boolean | undefined;
  archived: 'true' | 'false' | 'all';
  q?: string | undefined;
}

export interface NewSession {
  workspace: string;
  ownerId: string;
  agentId: string;
  title: string | null;
  source: string;
  modelLabel: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  workingDir: string | null;
  categoryId: string | null;
  parentSessionId: string | null;
  /** The person named it themselves; the hub then never renames it (decision §26). */
  titleSetByUser?: boolean;
  /** The entity the session serves (a task, a workflow run…); a person's chat has none. */
  originKind?: SessionRow['originKind'];
  originId?: string | null;
}

export interface NewMessage {
  workspace: string;
  ownerId: string;
  sessionId: string;
  runId: string | null;
  role: MessageRow['role'];
  authorKind: MessageRow['authorKind'];
  authorId: string | null;
  content: string;
  parts: MessageRow['parts'];
  attachmentIds: string[];
}

export interface NewRun {
  id: string;
  workspace: string;
  ownerId: string;
  sessionId: string;
  agentId: string;
  jobId: string;
  triggerMessageId: string | null;
  modelLabel: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  adapterKind: string;
  /** Who asked for the turn, when it was not a person typing (a task, a workflow step). */
  originKind?: RunRow['originKind'];
  originId?: string | null;
}

/** The sort key of a session in the list: newest activity first. */
const sessionSortKey = sql<number>`coalesce(${sessions.lastMessageAt}, ${sessions.createdAt})`;

export class SessionsStore {
  constructor(readonly db: ModuleDatabase) {}

  // ------------------------------------------------------------- sessions

  createSession(input: NewSession): SessionRow {
    const id = newUlid();
    this.db
      .insert(sessions)
      .values({
        id,
        workspace: input.workspace,
        ownerId: input.ownerId,
        agentId: input.agentId,
        title: input.title,
        source: input.source as SessionRow['source'],
        modelLabel: input.modelLabel,
        provider: input.provider,
        reasoningEffort: input.reasoningEffort as SessionRow['reasoningEffort'],
        workingDir: input.workingDir,
        categoryId: input.categoryId,
        parentSessionId: input.parentSessionId,
        titleSetByUser: input.titleSetByUser ?? false,
        originKind: input.originKind ?? 'user',
        originId: input.originId ?? null,
      })
      .run();
    return this.getSession(input.workspace, id) as SessionRow;
  }

  getSession(workspace: string, id: string): SessionRow | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspace, workspace), eq(sessions.id, id)))
      .get();
  }

  /**
   * The person's global-agent conversation in this workspace (contract decision §46): the
   * oldest one, should two ever exist, so every open lands on the same conversation.
   */
  findGlobalAgent(workspace: string, ownerId: string): SessionRow | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspace, workspace),
          eq(sessions.ownerId, ownerId),
          eq(sessions.source, 'global_agent'),
        ),
      )
      .orderBy(asc(sessions.createdAt), asc(sessions.id))
      .limit(1)
      .get();
  }

  updateSession(workspace: string, id: string, patch: Partial<SessionRow>): SessionRow | undefined {
    this.db
      .update(sessions)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(sessions.workspace, workspace), eq(sessions.id, id)))
      .run();
    return this.getSession(workspace, id);
  }

  deleteSession(workspace: string, id: string): boolean {
    const result = this.db
      .delete(sessions)
      .where(and(eq(sessions.workspace, workspace), eq(sessions.id, id)))
      .run();
    return result.changes > 0;
  }

  /**
   * One workspace, or several for a list across profiles (ADR 0016). Several is still one
   * statement with one order and one keyset, so a cursor pages across every workspace at
   * once — never a page per workspace glued together, which would repeat or skip rows.
   */
  listSessions(
    workspace: string | readonly string[],
    filters: SessionFilters,
    cursor: string | undefined,
    limit: number,
  ): Page<SessionRow> {
    const where: SQL[] = [
      typeof workspace === 'string'
        ? eq(sessions.workspace, workspace)
        : inArray(sessions.workspace, [...workspace]),
    ];
    if (filters.agentId) where.push(eq(sessions.agentId, filters.agentId));
    if (filters.source) where.push(eq(sessions.source, filters.source as SessionRow['source']));
    if (filters.pinned !== undefined) where.push(eq(sessions.pinned, filters.pinned));
    if (filters.categoryId === 'none') {
      where.push(isNull(sessions.categoryId));
    } else if (filters.categoryId) {
      where.push(eq(sessions.categoryId, filters.categoryId));
    }
    if (filters.archived === 'false') where.push(isNull(sessions.archivedAt));
    if (filters.archived === 'true') where.push(sql`${sessions.archivedAt} is not null`);
    if (filters.q) {
      const needle = `%${filters.q.toLowerCase()}%`;
      where.push(
        sql`(lower(coalesce(${sessions.title}, '')) like ${needle} or lower(coalesce(${sessions.preview}, '')) like ${needle} or exists (select 1 from ${messages} m where m.session_id = ${sessions.id} and lower(m.content) like ${needle}))`,
      );
    }
    const position = decodeCursor(cursor);
    if (position) {
      where.push(
        or(
          lt(sessionSortKey, position.sortValue),
          and(eq(sessionSortKey, position.sortValue), lt(sessions.id, position.id)),
        ) as SQL,
      );
    }
    const rows = this.db
      .select()
      .from(sessions)
      .where(and(...where))
      .orderBy(desc(sessionSortKey), desc(sessions.id))
      .limit(limit + 1)
      .all();
    return pageOf(rows, limit, (row) =>
      encodeCursor((row.lastMessageAt ?? row.createdAt).getTime(), row.id),
    );
  }

  /** The newest message of a session whose text matches, for `Session.match`. */
  findMatch(workspace: string, sessionId: string, q: string): MessageRow | undefined {
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspace, workspace),
          eq(messages.sessionId, sessionId),
          sql`lower(${messages.content}) like ${`%${q.toLowerCase()}%`}`,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(1)
      .get();
  }

  // ------------------------------------------------------------- messages

  appendMessage(input: NewMessage): MessageRow {
    const id = newUlid();
    const session = this.getSession(input.workspace, input.sessionId);
    const seq = (session?.messageCount ?? 0) + 1;
    this.db
      .insert(messages)
      .values({
        id,
        workspace: input.workspace,
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        runId: input.runId,
        seq,
        role: input.role,
        authorKind: input.authorKind,
        authorId: input.authorId,
        content: input.content,
        parts: input.parts,
        attachmentIds: input.attachmentIds,
      })
      .run();
    this.db
      .update(sessions)
      .set({
        messageCount: seq,
        lastMessageAt: new Date(),
        preview: preview(input.content),
        updatedAt: new Date(),
      })
      .where(and(eq(sessions.workspace, input.workspace), eq(sessions.id, input.sessionId)))
      .run();
    return this.getMessage(input.workspace, id) as MessageRow;
  }

  getMessage(workspace: string, id: string): MessageRow | undefined {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspace, workspace), eq(messages.id, id)))
      .get();
  }

  updateMessage(workspace: string, id: string, patch: Partial<MessageRow>): MessageRow | undefined {
    this.db
      .update(messages)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(messages.workspace, workspace), eq(messages.id, id)))
      .run();
    return this.getMessage(workspace, id);
  }

  /**
   * The newest `limit` messages, oldest first, or those before `beforeId`
   * (contract `sessions.listMessages`). Keyset paging on `seq`, which is unique inside a
   * session: a page is never shifted by messages written while the client reads. `null`
   * when `beforeId` is not a message of this session.
   */
  listMessages(
    workspace: string,
    sessionId: string,
    beforeId: string | undefined,
    limit: number,
  ): { items: MessageRow[]; hasMore: boolean } | null {
    const where: SQL[] = [eq(messages.workspace, workspace), eq(messages.sessionId, sessionId)];
    if (beforeId) {
      const anchor = this.getMessage(workspace, beforeId);
      if (!anchor || anchor.sessionId !== sessionId) return null;
      where.push(lt(messages.seq, anchor.seq));
    }
    const rows = this.db
      .select()
      .from(messages)
      .where(and(...where))
      .orderBy(desc(messages.seq))
      .limit(limit + 1)
      .all();
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).reverse();
    return { items, hasMore };
  }

  /**
   * Does any message in this workspace point at that attachment?
   *
   * `sessions.deleteAttachment` is documented as "delete an attachment that no message
   * references yet", so `knowledge` asks this before it removes the bytes. The column
   * is a JSON array, so the test is a substring of the serialised form — which is exact
   * here because a ULID is 26 fixed characters and cannot be a prefix of another id.
   */
  /**
   * Per workspace: runs not yet finished and conversations not archived — the Performance
   * screen's "what is each profile doing". Two grouped counts, whatever the number of rows.
   */
  activityByWorkspace(): Map<string, { activeRuns: number; sessions: number }> {
    const out = new Map<string, { activeRuns: number; sessions: number }>();
    const entry = (workspace: string) => {
      const found = out.get(workspace) ?? { activeRuns: 0, sessions: 0 };
      out.set(workspace, found);
      return found;
    };
    const live = this.db
      .select({ workspace: runs.workspace, n: sql<number>`count(*)` })
      .from(runs)
      .where(sql`${runs.status} not in ('succeeded', 'failed', 'cancelled', 'timed_out')`)
      .groupBy(runs.workspace)
      .all();
    for (const row of live) entry(row.workspace).activeRuns = Number(row.n);
    const open = this.db
      .select({ workspace: sessions.workspace, n: sql<number>`count(*)` })
      .from(sessions)
      .where(isNull(sessions.archivedAt))
      .groupBy(sessions.workspace)
      .all();
    for (const row of open) entry(row.workspace).sessions = Number(row.n);
    return out;
  }

  isAttachmentReferenced(workspace: string, attachmentId: string): boolean {
    const row = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspace, workspace),
          sql`${messages.attachmentIds} like ${`%"${attachmentId}"%`}`,
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  allMessages(workspace: string, sessionId: string): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspace, workspace), eq(messages.sessionId, sessionId)))
      .orderBy(asc(messages.seq))
      .all();
  }

  // ----------------------------------------------------------------- runs

  createRun(input: NewRun): RunRow {
    this.db
      .insert(runs)
      .values({
        id: input.id,
        workspace: input.workspace,
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        jobId: input.jobId,
        triggerMessageId: input.triggerMessageId,
        status: 'queued',
        modelLabel: input.modelLabel,
        provider: input.provider,
        reasoningEffort: input.reasoningEffort as RunRow['reasoningEffort'],
        adapterKind: input.adapterKind,
        originKind: input.originKind ?? 'user',
        originId: input.originId ?? null,
      })
      .run();
    return this.getRun(input.workspace, input.id) as RunRow;
  }

  getRun(workspace: string, id: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.workspace, workspace), eq(runs.id, id)))
      .get();
  }

  updateRun(workspace: string, id: string, patch: Partial<RunRow>): RunRow | undefined {
    this.db
      .update(runs)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(runs.workspace, workspace), eq(runs.id, id)))
      .run();
    return this.getRun(workspace, id);
  }

  listRuns(
    workspace: string,
    sessionId: string,
    status: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Page<RunRow> {
    const where: SQL[] = [eq(runs.workspace, workspace), eq(runs.sessionId, sessionId)];
    if (status) where.push(inArray(runs.status, internalStatuses(status)));
    const position = decodeCursor(cursor);
    if (position) where.push(lt(runs.id, position.id));
    const rows = this.db
      .select()
      .from(runs)
      .where(and(...where))
      .orderBy(desc(runs.id))
      .limit(limit + 1)
      .all();
    return pageOf(rows, limit, (row) => encodeCursor(row.createdAt.getTime(), row.id));
  }

  /** Every run of a session, oldest first (the trajectory reads them all). */
  allRuns(workspace: string, sessionId: string): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.workspace, workspace), eq(runs.sessionId, sessionId)))
      .orderBy(asc(runs.id))
      .all();
  }

  /** Active and queued runs of a session, in execution order (`SessionDetail.runs`). */
  liveRuns(workspace: string, sessionId: string): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspace, workspace),
          eq(runs.sessionId, sessionId),
          inArray(runs.status, [
            'queued',
            'starting',
            'streaming',
            'waiting_approval',
            'waiting_input',
          ]),
        ),
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all();
  }

  /** The oldest queued run of a session — the next one the engine should start. */
  nextQueuedRun(workspace: string, sessionId: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspace, workspace),
          eq(runs.sessionId, sessionId),
          eq(runs.status, 'queued'),
        ),
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1)
      .get();
  }

  /** True while a run of this session is past `queued` and not terminal. */
  activeRun(workspace: string, sessionId: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspace, workspace),
          eq(runs.sessionId, sessionId),
          inArray(runs.status, ['starting', 'streaming', 'waiting_approval', 'waiting_input']),
        ),
      )
      .orderBy(asc(runs.createdAt))
      .limit(1)
      .get();
  }

  /**
   * Every run left non-terminal by a crash or a restart: its adapter stream
   * is gone, so it can never continue. Failing them once on boot is the same
   * rule jobs follow for a stale heartbeat (docs/domain/README.md §job).
   */
  failStaleRuns(): number {
    const result = this.db
      .update(runs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorCode: 'stale',
        errorMessage: 'the hub restarted while this run was active',
        updatedAt: new Date(),
      })
      .where(
        inArray(runs.status, [
          'queued',
          'starting',
          'streaming',
          'waiting_approval',
          'waiting_input',
        ]),
      )
      .run();
    if (result.changes > 0) {
      this.db
        .update(approvals)
        .set({ status: 'cancelled', respondedAt: new Date(), updatedAt: new Date() })
        // A workflow step's gate has no session run: it outlives a restart on purpose.
        .where(and(eq(approvals.status, 'pending'), isNotNull(approvals.runId)))
        .run();
    }
    return result.changes;
  }

  // ----------------------------------------------------------- tool calls

  upsertToolCall(
    workspace: string,
    ownerId: string,
    runId: string,
    call: {
      id: string;
      messageId: string | null;
      seq: number;
      ref: string;
      name: string;
      kind: ToolCallRow['kind'];
      title: string | null;
      input: Record<string, unknown>;
      output: string | null;
      outputTruncated: boolean;
      subagentId: string | null;
      status: ToolCallRow['status'];
      approvalId: string | null;
      startedAt: Date;
      finishedAt: Date | null;
      exitCode: number | null;
    },
  ): ToolCallRow {
    const durationMs = call.finishedAt
      ? call.finishedAt.getTime() - call.startedAt.getTime()
      : null;
    this.db
      .insert(toolCalls)
      .values({
        id: call.id,
        workspace,
        ownerId,
        runId,
        messageId: call.messageId,
        seq: call.seq,
        agentToolCallRef: call.ref,
        name: call.name,
        kind: call.kind,
        title: call.title,
        input: call.input,
        output: call.output,
        outputTruncated: call.outputTruncated,
        subagentId: call.subagentId,
        status: call.status,
        approvalId: call.approvalId,
        startedAt: call.startedAt,
        finishedAt: call.finishedAt,
        durationMs,
        exitCode: call.exitCode,
      })
      .onConflictDoUpdate({
        target: toolCalls.id,
        set: {
          messageId: call.messageId,
          title: call.title,
          input: call.input,
          output: call.output,
          outputTruncated: call.outputTruncated,
          status: call.status,
          approvalId: call.approvalId,
          finishedAt: call.finishedAt,
          durationMs,
          exitCode: call.exitCode,
          updatedAt: new Date(),
        },
      })
      .run();
    return this.db.select().from(toolCalls).where(eq(toolCalls.id, call.id)).get() as ToolCallRow;
  }

  toolCallsForRuns(workspace: string, runIds: readonly string[]): Map<string, ToolCallRow[]> {
    const out = new Map<string, ToolCallRow[]>();
    if (runIds.length === 0) return out;
    const rows = this.db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.workspace, workspace), inArray(toolCalls.runId, [...runIds])))
      .orderBy(asc(toolCalls.runId), asc(toolCalls.seq))
      .all();
    for (const row of rows) {
      const list = out.get(row.runId) ?? [];
      list.push(row);
      out.set(row.runId, list);
    }
    return out;
  }

  // ------------------------------------------------------------ approvals

  upsertApproval(
    workspace: string,
    ownerId: string,
    runId: string | null,
    approval: {
      workflowRunId?: string | null;
      nodeId?: string | null;
      id: string;
      toolCallId: string | null;
      kind: ApprovalRow['kind'];
      status: ApprovalRow['status'];
      title: string;
      description: string | null;
      payload: Record<string, unknown>;
      response: Record<string, unknown> | null;
      respondedByUserId: string | null;
      remember: boolean;
      requestedAt: Date;
      respondedAt: Date | null;
      expiresAt: Date | null;
    },
  ): ApprovalRow {
    this.db
      .insert(approvals)
      .values({ ...approval, workspace, ownerId, runId })
      .onConflictDoUpdate({
        target: approvals.id,
        set: {
          toolCallId: approval.toolCallId,
          status: approval.status,
          response: approval.response,
          respondedByUserId: approval.respondedByUserId,
          remember: approval.remember,
          respondedAt: approval.respondedAt,
          updatedAt: new Date(),
        },
      })
      .run();
    return this.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .get() as ApprovalRow;
  }

  getApproval(workspace: string, id: string): ApprovalRow | undefined {
    return this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.workspace, workspace), eq(approvals.id, id)))
      .get();
  }

  listApprovals(
    workspace: string,
    filters: { status?: string | undefined; sessionId?: string | undefined },
    cursor: string | undefined,
    limit: number,
  ): Page<ApprovalRow> {
    const where: SQL[] = [eq(approvals.workspace, workspace)];
    where.push(eq(approvals.status, (filters.status ?? 'pending') as ApprovalRow['status']));
    if (filters.sessionId) {
      where.push(
        sql`${approvals.runId} in (select id from ${runs} where session_id = ${filters.sessionId})`,
      );
    }
    const position = decodeCursor(cursor);
    if (position) where.push(sql`${approvals.id} > ${position.id}`);
    const rows = this.db
      .select()
      .from(approvals)
      .where(and(...where))
      .orderBy(asc(approvals.requestedAt), asc(approvals.id))
      .limit(limit + 1)
      .all();
    return pageOf(rows, limit, (row) => encodeCursor(row.requestedAt.getTime(), row.id));
  }

  pendingApprovals(workspace: string, sessionId: string): ApprovalRow[] {
    return this.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspace, workspace),
          eq(approvals.status, 'pending'),
          sql`${approvals.runId} in (select id from ${runs} where session_id = ${sessionId})`,
        ),
      )
      .orderBy(asc(approvals.requestedAt))
      .all();
  }

  /** The session an approval belongs to, through its run; a workflow step's gate has none. */
  sessionIdOfApproval(workspace: string, approval: ApprovalRow): string | undefined {
    return approval.runId ? this.getRun(workspace, approval.runId)?.sessionId : undefined;
  }

  /**
   * Record an answer on an approval that is still pending — and only then. Two people
   * answering at once, or an answer racing a cancel: exactly one of them wins.
   */
  resolvePending(
    workspace: string,
    id: string,
    answer: {
      status: ApprovalRow['status'];
      response: Record<string, unknown> | null;
      respondedByUserId: string | null;
    },
  ): ApprovalRow | undefined {
    const now = new Date();
    const result = this.db
      .update(approvals)
      .set({ ...answer, respondedAt: now, updatedAt: now })
      .where(
        and(
          eq(approvals.workspace, workspace),
          eq(approvals.id, id),
          eq(approvals.status, 'pending'),
        ),
      )
      .run();
    return result.changes === 1 ? this.getApproval(workspace, id) : undefined;
  }

  /** The gates of a workflow run still waiting for someone. */
  pendingWorkflowApprovals(workspace: string, workflowRunId: string): ApprovalRow[] {
    return this.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspace, workspace),
          eq(approvals.workflowRunId, workflowRunId),
          eq(approvals.status, 'pending'),
        ),
      )
      .all();
  }
}

function pageOf<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null };
}

/** Contract `RunStatus` -> the internal states it covers (see mappers.ts). */
function internalStatuses(wire: string): RunRow['status'][] {
  switch (wire) {
    case 'queued':
      return ['queued'];
    case 'running':
      return ['starting', 'streaming'];
    case 'waiting':
      return ['waiting_approval', 'waiting_input'];
    case 'succeeded':
      return ['succeeded'];
    case 'cancelled':
      return ['cancelled'];
    case 'failed':
      return ['failed', 'timed_out'];
    default:
      return [];
  }
}

export function preview(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/**
 * `Session.match.snippet`: up to 300 characters of the matching message that show the
 * searched words (owner, 2026-09-23 — in a long message the opening lines may not contain
 * them at all). A match near the start reads like `preview`; a later one starts a little
 * before it, on a word boundary, behind an ellipsis.
 */
export function excerpt(text: string, q: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 300) return preview(flat);
  const needle = q.replace(/\s+/g, ' ').trim().toLowerCase();
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 80) return preview(flat);
  const space = flat.lastIndexOf(' ', at - 60);
  const from = space >= 0 && space >= at - 100 ? space + 1 : at - 60;
  const rest = flat.slice(from);
  return `…${rest.length > 298 ? `${rest.slice(0, 297)}…` : rest}`;
}
