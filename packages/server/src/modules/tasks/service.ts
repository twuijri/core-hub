/**
 * The Tasks section: projects, the nine columns, and everything that happens to a task.
 *
 * The rules this file exists to keep:
 *
 * - **A column is an order, not a set.** Every task carries a `position` (`position.ts`),
 *   so moving one writes one row and never renumbers a column.
 * - **A move is recorded.** Every status change, assignment and edit writes a transition,
 *   which is what the activity list reads. Nothing changes a task quietly.
 * - **`running` belongs to the worker.** A person moves a task to `ready`; the hub moves
 *   it to `running` when a run starts and out of it when one ends.
 * - **A task number is a project's, and never repeats.** `HUB-12` is the twelfth task of
 *   the project keyed `HUB`, handed out in the same transaction as the insert.
 */
import { and, asc, desc, eq, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import { newUlid } from '../../db/ids.js';
import type { ModuleDb } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { append, between } from './position.js';
import type { TASK_STATUSES } from './schema.js';
import {
  projects,
  subtasks,
  taskComments,
  taskDependencies,
  taskTransitions,
  tasks,
  worktrees,
} from './schema.js';
import type { CommentRow, ProjectRow, SubtaskRow, TaskRow, WorktreeRow } from './serialize.js';

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Scope {
  workspace: string;
  profile: string;
  userId: string;
}

export interface Actor {
  kind: 'user' | 'agent' | 'system' | 'schedule' | 'workflow';
  id: string | null;
  name?: string | null;
}

export class TasksService {
  constructor(private readonly db: ModuleDb) {}

  // ------------------------------------------------------------- projects

  listProjects(scope: Scope, includeArchived: boolean): ProjectRow[] {
    return this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspace, scope.workspace),
          includeArchived ? undefined : isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(projects.name))
      .all();
  }

  project(scope: Scope, id: string): ProjectRow {
    const row = this.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspace, scope.workspace), eq(projects.id, id)))
      .get();
    if (!row) throw notFound({ resource: 'project', id });
    return row;
  }

  /** `HUB` from "Hub", `PRO` from "Project"; unique in the workspace, so it can be shown. */
  private freeKey(scope: Scope, name: string): string {
    const base =
      name
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .map((word) => word[0] ?? '')
        .join('')
        .toUpperCase()
        .slice(0, 4) || 'P';
    for (let i = 0; ; i += 1) {
      const key = i === 0 ? base : `${base}${i}`;
      const taken = this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspace, scope.workspace), eq(projects.key, key)))
        .get();
      if (!taken) return key;
    }
  }

  createProject(scope: Scope, input: Record<string, unknown>): ProjectRow {
    const name = String(input.name ?? '').trim();
    if (name === '') throw conflict({ reason: 'name_required' });
    const id = newUlid();
    this.db
      .insert(projects)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        name,
        key: this.freeKey(scope, name),
        description: (input.description as string | null) ?? null,
        color: (input.color as string | null) ?? null,
        repoUrl: (input.repo_url as string | null) ?? null,
        localPath: (input.working_dir as string | null) ?? null,
        defaultBranch: (input.default_branch as string | null) ?? 'main',
        defaultAgentId: (input.default_agent_id as string | null) ?? null,
        reportRoomId: (input.report_room_id as string | null) ?? null,
        autoDispatch: (input.auto_dispatch as boolean | undefined) ?? false,
        status: (input.status as ProjectRow['status'] | undefined) ?? 'active',
      })
      .run();
    return this.project(scope, id);
  }

  updateProject(scope: Scope, id: string, patch: Record<string, unknown>): ProjectRow {
    this.project(scope, id);
    const values: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = String(patch.name);
    if (patch.description !== undefined) values.description = patch.description as string | null;
    if (patch.status !== undefined) {
      values.status = patch.status as ProjectRow['status'];
      values.archivedAt = patch.status === 'archived' ? new Date() : null;
    }
    if (patch.color !== undefined) values.color = patch.color as string | null;
    if (patch.repo_url !== undefined) values.repoUrl = patch.repo_url as string | null;
    if (patch.working_dir !== undefined) values.localPath = patch.working_dir as string | null;
    if (patch.default_branch !== undefined)
      values.defaultBranch = (patch.default_branch as string | null) ?? 'main';
    if (patch.default_agent_id !== undefined)
      values.defaultAgentId = patch.default_agent_id as string | null;
    if (patch.report_room_id !== undefined)
      values.reportRoomId = patch.report_room_id as string | null;
    if (patch.auto_dispatch !== undefined) values.autoDispatch = patch.auto_dispatch as boolean;
    this.db.update(projects).set(values).where(eq(projects.id, id)).run();
    return this.project(scope, id);
  }

  deleteProject(scope: Scope, id: string): void {
    this.project(scope, id);
    // Cascades to tasks, worktrees, transitions and dependencies (schema.ts).
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }

  countsFor(
    scope: Scope,
    projectId: string | null,
  ): { total: number; by_status: Record<string, number> } {
    const rows = this.db
      .select({ status: tasks.status, n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace, scope.workspace),
          projectId ? eq(tasks.projectId, projectId) : undefined,
        ),
      )
      .groupBy(tasks.status)
      .all();
    const by_status: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      by_status[row.status] = row.n;
      total += row.n;
    }
    return { total, by_status };
  }

  // ---------------------------------------------------------------- tasks

  task(scope: Scope, id: string): TaskRow {
    const row = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspace, scope.workspace), eq(tasks.id, id)))
      .get();
    if (!row) throw notFound({ resource: 'task', id });
    return row;
  }

  listTasks(scope: Scope, query: Parameters<TasksService['listTasksAcross']>[1]): TaskRow[] {
    return this.listTasksAcross([scope.workspace], query);
  }

  /**
   * Tasks of several workspaces in one statement (`tasks.listTasks?profiles=all`, ADR 0016):
   * one keyset, `id desc`, over all of them — so a page never repeats or skips a task from
   * another workspace. Which workspaces is the caller's business (`auth`'s rule), not this one's.
   */
  listTasksAcross(
    workspaces: readonly string[],
    query: {
      projectId?: string | undefined;
      status?: TaskStatus | undefined;
      assigneeId?: string | undefined;
      tag?: string | undefined;
      q?: string | undefined;
      includeArchived?: boolean;
      cursor?: string | null;
      limit: number;
    },
  ): TaskRow[] {
    if (workspaces.length === 0) return [];
    const needle = query.q?.trim();
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.workspace, [...workspaces]),
          query.projectId ? eq(tasks.projectId, query.projectId) : undefined,
          query.status ? eq(tasks.status, query.status) : undefined,
          query.includeArchived ? undefined : isNull(tasks.archivedAt),
          query.assigneeId
            ? or(
                eq(tasks.assigneeAgentId, query.assigneeId),
                eq(tasks.assigneeUserId, query.assigneeId),
              )
            : undefined,
          // Tags are a JSON array; a quoted match is the honest `LIKE` for one element.
          query.tag ? like(tasks.tags, `%"${query.tag}"%`) : undefined,
          needle
            ? or(like(tasks.title, `%${needle}%`), like(tasks.description, `%${needle}%`))
            : undefined,
          query.cursor ? sql`${tasks.id} < ${query.cursor}` : undefined,
        ),
      )
      .orderBy(desc(tasks.id))
      .limit(query.limit)
      .all();
  }

  /** The tasks of one column, in `position` order — what the board draws. */
  column(scope: Scope, projectId: string, status: TaskStatus, includeArchived: boolean): TaskRow[] {
    return this.columnAcross([scope.workspace], { projectId }, status, includeArchived);
  }

  /**
   * One column of the **whole** board: every workspace the person may enter, narrowed by
   * whatever they asked for.
   *
   * The board is one page for every workspace and every agent (owner decision,
   * 2026-09-23) — so the query takes a set of workspaces rather than one, and a project
   * is a filter rather than the thing that makes the query possible.
   *
   * Order within a column stays `position`, then id. Two workspaces' fractional keys are
   * not comparable in any meaningful way, so the tie-break is the id — which is a ULID,
   * so cards from different workspaces interleave by age rather than by accident.
   */
  columnAcross(
    workspaces: readonly string[],
    filter: { projectId?: string | undefined; agentId?: string | undefined },
    status: TaskStatus,
    includeArchived: boolean,
  ): TaskRow[] {
    if (workspaces.length === 0) return [];
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.workspace, [...workspaces]),
          filter.projectId ? eq(tasks.projectId, filter.projectId) : undefined,
          filter.agentId ? eq(tasks.assigneeAgentId, filter.agentId) : undefined,
          eq(tasks.status, status),
          includeArchived ? undefined : isNull(tasks.archivedAt),
        ),
      )
      .orderBy(asc(tasks.position), asc(tasks.id))
      .all();
  }

  /**
   * How many tasks are in the archive of these workspaces, narrowed like `columnAcross` —
   * what the board says behind Done without sending the archive itself (DECISIONS §93).
   */
  archivedCount(
    workspaces: readonly string[],
    filter: { projectId?: string | undefined; agentId?: string | undefined },
  ): number {
    if (workspaces.length === 0) return 0;
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          inArray(tasks.workspace, [...workspaces]),
          filter.projectId ? eq(tasks.projectId, filter.projectId) : undefined,
          filter.agentId ? eq(tasks.assigneeAgentId, filter.agentId) : undefined,
          eq(tasks.status, 'archived'),
        ),
      )
      .get();
    return Number(row?.count ?? 0);
  }

  private lastPosition(scope: Scope, projectId: string, status: TaskStatus): string | null {
    const row = this.db
      .select({ position: tasks.position })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace, scope.workspace),
          eq(tasks.projectId, projectId),
          eq(tasks.status, status),
        ),
      )
      .orderBy(desc(tasks.position))
      .limit(1)
      .get();
    return row?.position ?? null;
  }

  /**
   * The workspace's own project, made the first time somebody needs one.
   *
   * A person writing down something to do should not have to invent a container for it
   * first (owner decision, 2026-09-23). A task still belongs to a project — the schema
   * and every count depend on it — so the hub supplies one instead of asking.
   */
  defaultProject(scope: Scope): ProjectRow {
    const existing = this.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspace, scope.workspace), isNull(projects.archivedAt)))
      .orderBy(asc(projects.id))
      .get();
    if (existing) return existing;
    return this.createProject(scope, { name: 'المهام' });
  }

  /**
   * The reflection of a Hermes card, created or refreshed. **Hermes wins**: title, body,
   * status and result are overwritten with Hermes's on every call, whatever the hub had.
   *
   * Position is the one field that stays the hub's — Hermes has no order within a column,
   * and a card a person dragged to the top should not jump back down on the next read.
   */
  reflectExternal(
    scope: Scope,
    card: {
      source: 'hermes';
      id: string;
      title: string;
      body: string | null;
      status: TaskStatus;
      result: string | null;
      agentId: string | null;
      /** When the card reached `done` on its own board; `null` when that board did not say. */
      completedAt?: Date | null;
      /** Hermes's priority, when the hub can write it back (`hermes-api.ts`); absent: the hub's stays. */
      priority?: TaskRow['priority'];
      /**
       * The workspace of the profile Hermes gave the card to (ADR 0014), when there is one:
       * the card moves there. Absent or `null`: it stays where it is.
       */
      workspace?: string | null;
    },
    now: Date = new Date(),
  ): { row: TaskRow; created: boolean } {
    // Hermes keeps one board, so a card is one row wherever it was made: a task given to
    // Hermes from the design workspace stays there; only a card Hermes made itself lands
    // in `scope` (the default workspace).
    const existing = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.externalSource, card.source), eq(tasks.externalId, card.id)))
      .get();
    if (existing) {
      const moved = existing.status !== card.status;
      // Hermes handed the card to another profile: it goes to that profile's workspace.
      const current =
        card.workspace && card.workspace !== existing.workspace
          ? this.moveToWorkspace(existing, { ...scope, workspace: card.workspace }, now)
          : existing;
      // The card's own workspace, not the one the board is being read from.
      const own = { ...scope, workspace: current.workspace };
      this.db
        .update(tasks)
        .set({
          title: card.title,
          description: card.body,
          status: card.status,
          ...(card.priority ? { priority: card.priority } : {}),
          latestSummary: card.result ?? current.latestSummary,
          // A card Hermes moved lands at the top of its new column, as a person's move does.
          position: moved
            ? between(
                null,
                this.column(own, current.projectId, card.status, true)[0]?.position ?? null,
              )
            : current.position,
          archivedAt: card.status === 'archived' ? (current.archivedAt ?? now) : null,
          completedAt:
            card.status === 'done' ? (card.completedAt ?? current.completedAt ?? now) : null,
          externalSyncedAt: now,
          updatedAt: moved ? now : current.updatedAt,
        })
        .where(eq(tasks.id, current.id))
        .run();
      if (moved) {
        this.record(
          own,
          { kind: 'agent', id: card.agentId, name: 'Hermes' },
          current.id,
          'status',
          current.status,
          card.status,
          null,
        );
      }
      return { row: this.task(own, current.id), created: false };
    }
    // A card Hermes gave to a profile lands in that profile's workspace.
    const home = card.workspace ? { ...scope, workspace: card.workspace } : scope;
    const project = this.defaultProject(home);
    const id = newUlid();
    const number = project.taskCounter + 1;
    this.db.update(projects).set({ taskCounter: number }).where(eq(projects.id, project.id)).run();
    this.db
      .insert(tasks)
      .values({
        id,
        ownerId: scope.userId,
        workspace: home.workspace,
        projectId: project.id,
        number,
        title: card.title,
        description: card.body,
        status: card.status,
        priority: card.priority ?? 'normal',
        tags: [],
        assigneeKind: card.agentId ? 'agent' : 'none',
        assigneeAgentId: card.agentId,
        position: append(this.lastPosition(home, project.id, card.status)),
        latestSummary: card.result,
        archivedAt: card.status === 'archived' ? now : null,
        completedAt: card.status === 'done' ? (card.completedAt ?? now) : null,
        externalSource: card.source,
        externalId: card.id,
        externalSyncedAt: now,
      })
      .run();
    return { row: this.task(home, id), created: true };
  }

  /**
   * Done for longer than the cutoff: archived, so the Done column shows the recent week
   * and not the whole history (owner decision, 2026-09-23). Only the hub's own cards —
   * a card on Hermes's board is archived *on Hermes* (`HermesMirror.sync`).
   */
  archiveDoneBefore(workspaces: readonly string[], cutoff: Date, now: Date = new Date()): number {
    if (workspaces.length === 0) return 0;
    const stale = this.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.workspace, [...workspaces]),
          eq(tasks.status, 'done'),
          isNull(tasks.externalSource),
          lt(tasks.completedAt, cutoff),
        ),
      )
      .all();
    for (const row of stale) {
      this.db
        .update(tasks)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(eq(tasks.id, row.id))
        .run();
      this.record(
        { workspace: row.workspace, profile: '', userId: row.ownerId },
        { kind: 'system', id: null, name: null },
        row.id,
        'status',
        'done',
        'archived',
        'done for a week',
      );
    }
    return stale.length;
  }

  /**
   * Move a task to another workspace: into that workspace's own project, at the end of its
   * column, with a number of that project's. What was said and done on it goes along, so
   * the card reads the same wherever it is.
   */
  private moveToWorkspace(row: TaskRow, target: Scope, now: Date): TaskRow {
    const project = this.defaultProject(target);
    const number = project.taskCounter + 1;
    this.db.update(projects).set({ taskCounter: number }).where(eq(projects.id, project.id)).run();
    this.db
      .update(tasks)
      .set({
        workspace: target.workspace,
        projectId: project.id,
        number,
        position: append(this.lastPosition(target, project.id, row.status)),
        updatedAt: now,
      })
      .where(eq(tasks.id, row.id))
      .run();
    for (const table of [subtasks, taskComments, taskTransitions, worktrees]) {
      this.db
        .update(table)
        .set({ workspace: target.workspace })
        .where(eq(table.taskId, row.id))
        .run();
    }
    return this.db.select().from(tasks).where(eq(tasks.id, row.id)).get()!;
  }

  /** Every reflection of `source` in this workspace, so a sync can see what went missing. */
  externalRows(_scope: Scope, source: 'hermes'): TaskRow[] {
    // Every workspace: Hermes's one board may hold a card given from any of them.
    return this.db.select().from(tasks).where(eq(tasks.externalSource, source)).all();
  }

  /** Link an existing row to the card it was just created as. */
  linkExternal(scope: Scope, id: string, source: 'hermes', externalId: string): TaskRow {
    this.db
      .update(tasks)
      .set({ externalSource: source, externalId, externalSyncedAt: new Date() })
      .where(and(eq(tasks.workspace, scope.workspace), eq(tasks.id, id)))
      .run();
    return this.task(scope, id);
  }

  createTask(scope: Scope, actor: Actor, input: Record<string, unknown>): TaskRow {
    const asked = input.project_id;
    const project =
      typeof asked === 'string' && asked !== ''
        ? this.project(scope, asked)
        : this.defaultProject(scope);
    const title = String(input.title ?? '').trim();
    if (title === '') throw conflict({ reason: 'title_required' });
    const status = (input.status as TaskStatus | undefined) ?? 'triage';
    const id = newUlid();
    const number = project.taskCounter + 1;
    this.db.update(projects).set({ taskCounter: number }).where(eq(projects.id, project.id)).run();
    const agentId = (input.assignee_agent_id as string | null) ?? null;
    this.db
      .insert(tasks)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        projectId: project.id,
        number,
        title,
        description: (input.description as string | null) ?? null,
        status,
        priority: (input.priority as TaskRow['priority'] | undefined) ?? 'normal',
        tags: (input.tags as string[] | undefined) ?? [],
        assigneeKind: agentId ? 'agent' : 'none',
        assigneeAgentId: agentId,
        autoStart: (input.auto_start as boolean | undefined) ?? false,
        position: append(this.lastPosition(scope, project.id, status)),
        dueAt: input.due_at ? new Date(String(input.due_at)) : null,
        attachmentIds: (input.attachment_ids as string[] | undefined) ?? [],
      })
      .run();
    this.record(scope, actor, id, 'status', null, status, null);
    for (const [index, sub] of (
      (input.subtasks as Array<{ title: string }> | undefined) ?? []
    ).entries()) {
      this.createSubtask(scope, id, { title: sub.title, index });
    }
    return this.task(scope, id);
  }

  updateTask(scope: Scope, actor: Actor, id: string, patch: Record<string, unknown>): TaskRow {
    const current = this.task(scope, id);
    const values: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    if (patch.title !== undefined) values.title = String(patch.title);
    if (patch.description !== undefined) values.description = patch.description as string | null;
    if (patch.priority !== undefined) values.priority = patch.priority as TaskRow['priority'];
    if (patch.tags !== undefined) values.tags = patch.tags as string[];
    if (patch.auto_start !== undefined) values.autoStart = patch.auto_start as boolean;
    if (patch.due_at !== undefined)
      values.dueAt = patch.due_at ? new Date(String(patch.due_at)) : null;
    if (patch.attachment_ids !== undefined) values.attachmentIds = patch.attachment_ids as string[];
    if (patch.project_id !== undefined && patch.project_id !== current.projectId) {
      const target = this.project(scope, String(patch.project_id));
      values.projectId = target.id;
      // A task that moves project joins the end of its column there.
      values.position = append(this.lastPosition(scope, target.id, current.status));
      this.record(scope, actor, id, 'project', current.projectId, target.id, null);
    }
    this.db.update(tasks).set(values).where(eq(tasks.id, id)).run();
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      this.record(scope, actor, id, 'priority', current.priority, String(patch.priority), null);
    }
    return this.task(scope, id);
  }

  deleteTask(scope: Scope, id: string): void {
    this.task(scope, id);
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  /**
   * Move a task to a column, and to a place inside it.
   *
   * `blocked` demands a reason: a column that says "blocked" and nothing else is a column
   * nobody can act on. `done` and `archived` stamp their times, and leaving them clears
   * the stamp — a task that comes back from `done` was not done.
   */
  moveTask(
    scope: Scope,
    actor: Actor,
    id: string,
    move: {
      status: TaskStatus;
      reason?: string | null;
      summary?: string | null;
      after_task_id?: string | null;
      /** The run this move belongs to, written on the transition. */
      runId?: string | null;
    },
  ): TaskRow {
    const current = this.task(scope, id);
    if (move.status === 'blocked' && !move.reason?.trim()) {
      throw conflict({ reason: 'blocked_needs_reason', field: 'reason' });
    }
    const column = this.column(scope, current.projectId, move.status, true).filter(
      (row) => row.id !== id,
    );
    let position: string;
    if (move.after_task_id) {
      const index = column.findIndex((row) => row.id === move.after_task_id);
      if (index < 0) throw notFound({ resource: 'task', id: move.after_task_id });
      position = between(column[index]!.position, column[index + 1]?.position ?? null);
    } else {
      // No anchor means the top of the column: that is where a person drops a task they
      // just decided is next.
      position = between(null, column[0]?.position ?? null);
    }
    const now = new Date();
    this.db
      .update(tasks)
      .set({
        status: move.status,
        position,
        blockedReason: move.status === 'blocked' ? (move.reason ?? null) : null,
        statusReason: move.reason ?? null,
        latestSummary: move.summary ?? current.latestSummary,
        startedAt: move.status === 'running' ? (current.startedAt ?? now) : current.startedAt,
        completedAt: move.status === 'done' ? now : null,
        archivedAt: move.status === 'archived' ? now : null,
        // A move is news about the task: whatever the watchdog said about the last run is over.
        stuckAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(
      scope,
      actor,
      id,
      'status',
      current.status,
      move.status,
      move.reason ?? null,
      move.runId ?? null,
    );
    return this.task(scope, id);
  }

  bulkUpdate(scope: Scope, actor: Actor, ids: string[], patch: Record<string, unknown>): TaskRow[] {
    const out: TaskRow[] = [];
    for (const id of ids) {
      if (patch.archived !== undefined) {
        const current = this.task(scope, id);
        // `archived` is a column, so archiving is a move — and it is recorded as one.
        out.push(
          this.moveTask(scope, actor, id, {
            status: patch.archived ? 'archived' : 'done',
            reason: null,
          }),
        );
        if (current.status === (patch.archived ? 'archived' : 'done')) out.pop();
        else continue;
      }
      const rest = { ...patch };
      delete rest.archived;
      if (Object.keys(rest).length > 0) out.push(this.updateTask(scope, actor, id, rest));
    }
    return out;
  }

  bulkDelete(scope: Scope, ids: string[]): number {
    let removed = 0;
    for (const id of ids) {
      const row = this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.workspace, scope.workspace), eq(tasks.id, id)))
        .get();
      if (!row) continue;
      this.db.delete(tasks).where(eq(tasks.id, id)).run();
      removed += 1;
    }
    return removed;
  }

  // ----------------------------------------------------------- assignment

  assign(
    scope: Scope,
    actor: Actor,
    id: string,
    input: { agent_id: string; instructions?: string | null },
  ): TaskRow {
    const current = this.task(scope, id);
    const now = new Date();
    this.db
      .update(tasks)
      .set({
        assigneeKind: 'agent',
        assigneeAgentId: input.agent_id,
        assigneeUserId: null,
        // An assigned task is `ready`: the worker is what moves it to `running`.
        status: current.status === 'triage' || current.status === 'todo' ? 'ready' : current.status,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(
      scope,
      actor,
      id,
      'assignee',
      current.assigneeAgentId,
      input.agent_id,
      input.instructions ?? null,
    );
    return this.task(scope, id);
  }

  /**
   * Take the task away from its agent. A task that was running goes back to `ready` (its
   * run is stopped by the caller, which owns that); one that was only `ready` goes back to
   * `todo`, because nobody is going to pick it up.
   */
  unassign(scope: Scope, actor: Actor, id: string): TaskRow {
    const current = this.task(scope, id);
    const status =
      current.status === 'running' ? 'ready' : current.status === 'ready' ? 'todo' : current.status;
    this.db
      .update(tasks)
      .set({
        assigneeKind: 'none',
        assigneeAgentId: null,
        assigneeUserId: null,
        currentRunId: null,
        status,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(scope, actor, id, 'assignee', current.assigneeAgentId, 'none', null);
    if (current.status === 'running') {
      this.record(
        scope,
        actor,
        id,
        'status',
        'running',
        status,
        'unassigned',
        current.currentRunId,
      );
    }
    return this.task(scope, id);
  }

  /** Stop working on a task: the run reference goes, and the task waits again. */
  stop(scope: Scope, actor: Actor, id: string, note = 'stopped'): TaskRow {
    const current = this.task(scope, id);
    this.db
      .update(tasks)
      .set({
        currentRunId: null,
        status: current.status === 'running' ? 'ready' : current.status,
        // A person who stops a task wants it stopped: it waits in `ready` and does not start
        // again by itself (DECISIONS §47). A reassignment is not a stop — the new agent's
        // start follows.
        ...(note === 'reassigned' ? {} : { autoStart: false }),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(scope, actor, id, 'status', current.status, 'ready', note, current.currentRunId);
    return this.task(scope, id);
  }

  // ------------------------------------------------------------------ runs

  /**
   * The worker took the task: it is `running`, in this session, on this run. A new
   * attempt, so the count goes up — a task that went round twice says so.
   */
  startRun(scope: Scope, actor: Actor, id: string, run: { sessionId: string; runId: string }) {
    const current = this.task(scope, id);
    this.moveTask(scope, actor, id, { status: 'running', reason: null, runId: run.runId });
    this.db
      .update(tasks)
      .set({
        sessionId: run.sessionId,
        currentRunId: run.runId,
        attemptCount: current.attemptCount + 1,
      })
      .where(eq(tasks.id, id))
      .run();
    return { row: this.task(scope, id), from: current.status };
  }

  /**
   * The run ended; the task goes where the ending says. Only while the task is still
   * `running` **on that run**: a task somebody stopped, unassigned or gave to another run
   * has already been moved by whoever did that, and moving it again would undo them.
   *
   * - `succeeded` → `review`, with the agent's last words as the progress summary;
   * - `cancelled` → `ready` (stopped from the chat, say), still assigned;
   * - anything else → `blocked`, with the reason — `blocked` refuses to exist without one.
   */
  finishRun(
    scope: Scope,
    actor: Actor,
    id: string,
    runId: string,
    outcome: { status: string; summary: string | null; reason: string },
  ): { row: TaskRow; from: TaskStatus } | null {
    const current = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspace, scope.workspace), eq(tasks.id, id)))
      .get();
    if (!current || current.status !== 'running' || current.currentRunId !== runId) return null;
    const move =
      outcome.status === 'succeeded'
        ? { status: 'review' as const, reason: null, summary: outcome.summary }
        : outcome.status === 'cancelled'
          ? { status: 'ready' as const, reason: outcome.reason }
          : { status: 'blocked' as const, reason: outcome.reason };
    this.moveTask(scope, actor, id, { ...move, runId });
    this.db
      .update(tasks)
      // Stopped from the chat is a stop like the board's: back in `ready`, not started again.
      .set(
        outcome.status === 'cancelled'
          ? { currentRunId: null, autoStart: false }
          : { currentRunId: null },
      )
      .where(eq(tasks.id, id))
      .run();
    return { row: this.task(scope, id), from: current.status };
  }

  /** Forget the run a task was on, without moving it (the caller already has). */
  detachRun(scope: Scope, id: string): TaskRow {
    this.db
      .update(tasks)
      .set({ currentRunId: null })
      .where(and(eq(tasks.workspace, scope.workspace), eq(tasks.id, id)))
      .run();
    return this.task(scope, id);
  }

  /** Every task of the hub's own left `running` — what a restart has to settle. */
  runningEverywhere(): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'running'), isNull(tasks.externalSource)))
      .all();
  }

  /** The `ready` tasks an auto-dispatch would take, oldest first. */
  dispatchable(scope: Scope, projectId: string, max: number): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace, scope.workspace),
          eq(tasks.projectId, projectId),
          eq(tasks.status, 'ready'),
          isNull(tasks.archivedAt),
        ),
      )
      .orderBy(asc(tasks.position), asc(tasks.id))
      .limit(max)
      .all();
  }

  // ------------------------------------------------------------- subtasks

  subtasksOf(taskId: string): SubtaskRow[] {
    return this.db
      .select()
      .from(subtasks)
      .where(eq(subtasks.taskId, taskId))
      .orderBy(asc(subtasks.index))
      .all();
  }

  subtaskCounts(taskId: string): { total: number; done: number } {
    const rows = this.subtasksOf(taskId);
    return { total: rows.length, done: rows.filter((row) => row.status === 'done').length };
  }

  createSubtask(
    scope: Scope,
    taskId: string,
    input: { title: string; index?: number },
  ): SubtaskRow {
    const id = newUlid();
    const existing = this.subtasksOf(taskId);
    this.db
      .insert(subtasks)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        taskId,
        index: input.index ?? existing.length,
        title: input.title,
      })
      .run();
    return this.db.select().from(subtasks).where(eq(subtasks.id, id)).get()!;
  }

  updateSubtask(scope: Scope, id: string, patch: Record<string, unknown>): SubtaskRow {
    const current = this.db
      .select()
      .from(subtasks)
      .where(and(eq(subtasks.workspace, scope.workspace), eq(subtasks.id, id)))
      .get();
    if (!current) throw notFound({ resource: 'subtask', id });
    const values: Partial<typeof subtasks.$inferInsert> = { updatedAt: new Date() };
    if (patch.title !== undefined) values.title = String(patch.title);
    if (patch.note !== undefined) values.note = patch.note as string | null;
    if (patch.blocked_reason !== undefined)
      values.blockedReason = patch.blocked_reason as string | null;
    if (patch.index !== undefined) values.index = Number(patch.index);
    if (patch.status !== undefined) {
      values.status = patch.status as SubtaskRow['status'];
      // A line ticked has a time; a line un-ticked loses it.
      values.completedAt = patch.status === 'done' ? new Date() : null;
    }
    this.db.update(subtasks).set(values).where(eq(subtasks.id, id)).run();
    return this.db.select().from(subtasks).where(eq(subtasks.id, id)).get()!;
  }

  deleteSubtask(scope: Scope, id: string): void {
    const current = this.db
      .select({ id: subtasks.id })
      .from(subtasks)
      .where(and(eq(subtasks.workspace, scope.workspace), eq(subtasks.id, id)))
      .get();
    if (!current) throw notFound({ resource: 'subtask', id });
    this.db.delete(subtasks).where(eq(subtasks.id, id)).run();
  }

  // --------------------------------------------------------- dependencies

  dependenciesOf(taskId: string): string[] {
    return this.db
      .select({ id: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((row) => row.id);
  }

  /**
   * The dependencies of a task that are not done yet, oldest first — what a
   * card says it waits for, and what keeps `auto_start` from starting it (DECISIONS §93).
   * `done` is done; `archived` is done only when it was done first (the weekly archive
   * keeps `completed_at`, a task archived by hand has none).
   */
  waitingOn(taskId: string): Array<{ id: string; title: string; status: TaskStatus }> {
    return this.db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        completedAt: tasks.completedAt,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(eq(taskDependencies.taskId, taskId))
      .orderBy(asc(tasks.createdAt), asc(tasks.number), asc(tasks.id))
      .all()
      .filter((row) => !isDone(row))
      .map(({ id, title, status }) => ({ id, title, status }));
  }

  /**
   * Replace what a task waits for. A task may not wait for itself, and may not wait for
   * something that already waits for it — a cycle is a board nobody can finish.
   */
  setDependencies(scope: Scope, taskId: string, dependsOn: string[]): string[] {
    this.task(scope, taskId);
    const unique = [...new Set(dependsOn)];
    if (unique.includes(taskId)) throw conflict({ reason: 'self_dependency', task_id: taskId });
    for (const other of unique) {
      this.task(scope, other);
      if (this.dependsOn(other, taskId, new Set())) {
        throw conflict({ reason: 'dependency_cycle', task_id: other });
      }
    }
    this.db.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId)).run();
    for (const other of unique) {
      this.db
        .insert(taskDependencies)
        .values({
          id: newUlid(),
          ownerId: scope.userId,
          workspace: scope.workspace,
          taskId,
          dependsOnTaskId: other,
        })
        .run();
    }
    return unique;
  }

  private dependsOn(from: string, target: string, seen: Set<string>): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.dependenciesOf(from).some((next) => this.dependsOn(next, target, seen));
  }

  // -------------------------------------------------- comments & activity

  comment(scope: Scope, actor: Actor, taskId: string, body: string): CommentRow {
    this.task(scope, taskId);
    const id = newUlid();
    this.db
      .insert(taskComments)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        taskId,
        authorKind: actor.kind,
        authorId: actor.id,
        authorName: actor.name ?? null,
        body,
      })
      .run();
    return this.db.select().from(taskComments).where(eq(taskComments.id, id)).get()!;
  }

  /**
   * Comments kept elsewhere (Hermes's), reflected on the task: each one the hub does not
   * have yet — the same author, words and second — is added with its own time. Answers the
   * task's comments, oldest first.
   */
  reflectComments(
    row: TaskRow,
    comments: ReadonlyArray<{
      author: string;
      authorKind: 'user' | 'agent';
      authorId: string | null;
      body: string;
      createdAt: Date;
    }>,
  ): CommentRow[] {
    const keyOf = (author: string | null, body: string, at: Date) =>
      `${Math.floor(at.getTime() / 1000)}\u0000${author ?? ''}\u0000${body}`;
    const known = new Set(
      this.commentsOf(row.id).map((comment) =>
        keyOf(comment.authorName, comment.body, comment.createdAt),
      ),
    );
    for (const comment of comments) {
      const key = keyOf(comment.author, comment.body, comment.createdAt);
      if (known.has(key)) continue;
      known.add(key);
      this.db
        .insert(taskComments)
        .values({
          id: newUlid(),
          ownerId: row.ownerId,
          workspace: row.workspace,
          taskId: row.id,
          authorKind: comment.authorKind,
          authorId: comment.authorId,
          authorName: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.createdAt,
        })
        .run();
    }
    return this.commentsOf(row.id);
  }

  commentsOf(taskId: string): CommentRow[] {
    return this.db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt))
      .all();
  }

  /** Every transition and comment of a task, newest first — the contract's `Activity`. */
  activity(scope: Scope, taskId: string, limit: number): Array<Record<string, unknown>> {
    this.task(scope, taskId);
    const transitions = this.db
      .select()
      .from(taskTransitions)
      .where(eq(taskTransitions.taskId, taskId))
      .orderBy(desc(taskTransitions.createdAt))
      .limit(limit)
      .all();
    const comments = this.commentsOf(taskId);
    const entries = [
      ...transitions.map((row) => ({
        id: row.id,
        task_id: taskId,
        kind:
          row.field === 'status'
            ? row.fromValue === null
              ? 'created'
              : 'moved'
            : row.field === 'assignee'
              ? row.toValue === 'none'
                ? 'unassigned'
                : 'assigned'
              : 'updated',
        actor: { kind: row.actorKind, id: row.actorId, name: row.actorKind, avatar: null },
        data: { field: row.field, from: row.fromValue, to: row.toValue, note: row.note },
        created_at: row.createdAt.toISOString(),
      })),
      ...comments.map((row) => ({
        id: row.id,
        task_id: taskId,
        kind: 'comment',
        actor: {
          kind: row.authorKind,
          id: row.authorId,
          name: row.authorName ?? row.authorKind,
          avatar: null,
        },
        data: { content: row.body },
        created_at: row.createdAt.toISOString(),
      })),
    ];
    return entries
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  /** Every change to a task is written down; the activity list is this table read back. */
  private record(
    scope: Scope,
    actor: Actor,
    taskId: string,
    field: 'status' | 'assignee' | 'priority' | 'project',
    from: string | null,
    to: string,
    note: string | null,
    runId: string | null = null,
  ): void {
    this.db
      .insert(taskTransitions)
      .values({
        id: newUlid(),
        ownerId: scope.userId,
        workspace: scope.workspace,
        taskId,
        field,
        fromValue: from,
        toValue: to,
        actorKind: actor.kind,
        actorId: actor.id,
        runId,
        note,
      })
      .run();
  }

  // ------------------------------------------------------------ worktrees

  worktreeOf(taskId: string): WorktreeRow | undefined {
    return this.db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.taskId, taskId), isNull(worktrees.removedAt)))
      .get();
  }

  worktreeById(id: string): WorktreeRow | undefined {
    return this.db.select().from(worktrees).where(eq(worktrees.id, id)).get();
  }

  /**
   * The row for a worktree about to be made, in `creating`. A task that had one before (it
   * was removed, or making it failed) gets the same row back — the same folder and the same
   * branch, which git kept — so a task has one worktree history, not a pile of rows.
   */
  beginWorktree(
    scope: Scope,
    task: TaskRow,
    input: { path: string; branch: string; base: string },
  ): WorktreeRow {
    const previous = this.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.taskId, task.id))
      .orderBy(desc(worktrees.createdAt))
      .get();
    const now = new Date();
    if (previous) {
      this.db
        .update(worktrees)
        .set({
          status: 'creating',
          removedAt: null,
          error: null,
          baseRef: previous.removedAt ? input.base : (previous.baseRef ?? input.base),
          workspace: task.workspace,
          updatedAt: now,
        })
        .where(eq(worktrees.id, previous.id))
        .run();
      return this.worktreeById(previous.id)!;
    }
    // A folder another row still names (a task deleted long ago) is not taken over.
    const taken = this.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(eq(worktrees.path, input.path))
      .get();
    const id = newUlid();
    this.db
      .insert(worktrees)
      .values({
        id,
        ownerId: scope.userId,
        workspace: task.workspace,
        projectId: task.projectId,
        taskId: task.id,
        path: taken ? `${input.path}-${id.slice(-6).toLowerCase()}` : input.path,
        branch: input.branch,
        baseRef: input.base,
        status: 'creating',
      })
      .run();
    return this.worktreeById(id)!;
  }

  /** What git answered: `ready`/`dirty` with its numbers, or `failed` with git's message. */
  settleWorktree(
    id: string,
    outcome:
      | {
          status: 'ready' | 'dirty';
          stats: { changedFiles: number; ahead: number; behind: number; head: string | null };
        }
      | { status: 'failed'; error: string },
  ): WorktreeRow {
    const now = new Date();
    this.db
      .update(worktrees)
      .set(
        outcome.status === 'failed'
          ? { status: 'failed', error: outcome.error, updatedAt: now }
          : {
              status: outcome.status,
              error: null,
              headSha: outcome.stats.head,
              stats: {
                changedFiles: outcome.stats.changedFiles,
                ahead: outcome.stats.ahead,
                behind: outcome.stats.behind,
              },
              lastSyncedAt: now,
              updatedAt: now,
            },
      )
      .where(eq(worktrees.id, id))
      .run();
    return this.worktreeById(id)!;
  }

  /** The folder is gone and git forgot it; the branch stays. */
  worktreeRemoved(id: string): void {
    const now = new Date();
    this.db
      .update(worktrees)
      .set({ removedAt: now, status: 'removed', error: null, updatedAt: now })
      .where(eq(worktrees.id, id))
      .run();
  }

  /** Every live worktree of a project, for deleting the project. */
  liveWorktreesOfProject(scope: Scope, projectId: string): WorktreeRow[] {
    return this.db
      .select()
      .from(worktrees)
      .where(
        and(
          eq(worktrees.workspace, scope.workspace),
          eq(worktrees.projectId, projectId),
          isNull(worktrees.removedAt),
        ),
      )
      .all();
  }

  /** Live worktrees whose task is archived (or gone): what the weekly archive leaves behind. */
  orphanedWorktrees(workspaces: readonly string[]): WorktreeRow[] {
    if (workspaces.length === 0) return [];
    return this.db
      .select({ worktree: worktrees })
      .from(worktrees)
      .leftJoin(tasks, eq(tasks.id, worktrees.taskId))
      .where(
        and(
          inArray(worktrees.workspace, [...workspaces]),
          isNull(worktrees.removedAt),
          or(isNull(tasks.id), eq(tasks.status, 'archived')),
        ),
      )
      .all()
      .map((row) => row.worktree);
  }

  // ------------------------------------------------------------ auto_start

  /**
   * The tasks waiting to start on their own in one workspace, top of the column first:
   * `auto_start`, `ready`, given to an agent, on no run, and the hub's own card.
   */
  autoStartable(workspace: string): TaskRow[] {
    return (
      this.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.workspace, workspace),
            eq(tasks.autoStart, true),
            eq(tasks.status, 'ready'),
            eq(tasks.assigneeKind, 'agent'),
            isNull(tasks.currentRunId),
            isNull(tasks.externalSource),
            isNull(tasks.archivedAt),
          ),
        )
        .orderBy(asc(tasks.position), asc(tasks.id))
        .all()
        // A task that depends on others waits for all of them to be done (DECISIONS §93);
        // the move of the last one to `done` looks again.
        .filter((row) => this.waitingOn(row.id).length === 0)
    );
  }

  // ------------------------------------------------------------- watchdog

  /**
   * Set or clear the stuck marker (DECISIONS §93). Not an edit: `updated_at` stays, and no
   * transition is written — the task has not moved, its run has gone quiet.
   */
  markStuck(id: string, since: Date | null): TaskRow | undefined {
    this.db.update(tasks).set({ stuckAt: since }).where(eq(tasks.id, id)).run();
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  /** The workspaces that have a task waiting to start on its own — what a restart looks at. */
  autoStartWorkspaces(): string[] {
    return this.db
      .selectDistinct({ workspace: tasks.workspace })
      .from(tasks)
      .where(
        and(
          eq(tasks.autoStart, true),
          eq(tasks.status, 'ready'),
          eq(tasks.assigneeKind, 'agent'),
          isNull(tasks.currentRunId),
          isNull(tasks.externalSource),
        ),
      )
      .all()
      .map((row) => row.workspace);
  }

  /** Tasks by id, for the bulk endpoints. */
  many(scope: Scope, ids: string[]): TaskRow[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspace, scope.workspace), inArray(tasks.id, ids)))
      .all();
  }
}

/** Whether a task counts as done for the tasks that depend on it. */
function isDone(row: { status: TaskStatus; completedAt: Date | null }): boolean {
  return row.status === 'done' || (row.status === 'archived' && row.completedAt !== null);
}
