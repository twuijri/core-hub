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
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
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

  listTasks(
    scope: Scope,
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
    const needle = query.q?.trim();
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace, scope.workspace),
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
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace, scope.workspace),
          eq(tasks.projectId, projectId),
          eq(tasks.status, status),
          includeArchived ? undefined : isNull(tasks.archivedAt),
        ),
      )
      .orderBy(asc(tasks.position), asc(tasks.id))
      .all();
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

  createTask(scope: Scope, actor: Actor, input: Record<string, unknown>): TaskRow {
    const project = this.project(scope, String(input.project_id));
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
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(scope, actor, id, 'status', current.status, move.status, move.reason ?? null);
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

  unassign(scope: Scope, actor: Actor, id: string): TaskRow {
    const current = this.task(scope, id);
    this.db
      .update(tasks)
      .set({
        assigneeKind: 'none',
        assigneeAgentId: null,
        assigneeUserId: null,
        status: current.status === 'ready' ? 'todo' : current.status,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(scope, actor, id, 'assignee', current.assigneeAgentId, 'none', null);
    return this.task(scope, id);
  }

  /** Stop working on a task: the run reference goes, and the task waits again. */
  stop(scope: Scope, actor: Actor, id: string): TaskRow {
    const current = this.task(scope, id);
    this.db
      .update(tasks)
      .set({
        currentRunId: null,
        status: current.status === 'running' ? 'ready' : current.status,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .run();
    this.record(scope, actor, id, 'status', current.status, 'ready', 'stopped');
    return this.task(scope, id);
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

  /**
   * Record the worktree a task works in. The hub does not create a git worktree here —
   * that belongs to the worker that runs the task — so the row is created in `creating`
   * and whoever does the work says when it is `ready`.
   */
  createWorktree(
    scope: Scope,
    taskId: string,
    input: { branch?: string | null; base_branch?: string | null },
  ): WorktreeRow {
    const task = this.task(scope, taskId);
    const existing = this.worktreeOf(taskId);
    if (existing) throw conflict({ reason: 'worktree_exists', task_id: taskId });
    const project = this.project(scope, task.projectId);
    const branch = input.branch?.trim() || `task/${project.key.toLowerCase()}-${task.number}`;
    const id = newUlid();
    this.db
      .insert(worktrees)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        projectId: project.id,
        taskId,
        path: `${project.localPath ?? ''}/../worktrees/${branch}`.replace(/\/+/g, '/'),
        branch,
        baseRef: input.base_branch ?? project.defaultBranch,
        status: 'creating',
      })
      .run();
    return this.db.select().from(worktrees).where(eq(worktrees.id, id)).get()!;
  }

  removeWorktree(scope: Scope, taskId: string): void {
    const row = this.worktreeOf(taskId);
    if (!row) throw notFound({ resource: 'worktree', id: taskId });
    this.db
      .update(worktrees)
      .set({ removedAt: new Date(), status: 'removed', updatedAt: new Date() })
      .where(eq(worktrees.id, row.id))
      .run();
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
