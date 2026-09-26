/**
 * The tables' vocabulary turned into the contract's.
 *
 * Two things are resolved from outside and passed in rather than looked up here: the name
 * of an assignee (the `agents` and `auth` modules own those) and the counts of a project.
 * A serializer that reached into another module's tables would be the end of the module
 * boundary, so it asks instead.
 */
import type { projects, subtasks, taskComments, tasks, worktrees } from './schema.js';

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SubtaskRow = typeof subtasks.$inferSelect;
export type CommentRow = typeof taskComments.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;

/** How a name is found for an id. Returns `null` for someone the hub no longer knows. */
export type NameOf = (kind: 'agent' | 'user', id: string) => string | null;

/** A dependency not done yet, as a card shows it (contract `TaskDependencyState`). */
export interface WaitingOn {
  id: string;
  title: string;
  status: string;
}

export interface Counts {
  total: number;
  by_status: Record<string, number>;
}

export function toProject(
  row: ProjectRow,
  profile: string,
  counts: Counts,
): Record<string, unknown> {
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    name: row.name,
    description: row.description,
    status: row.status,
    color: row.color,
    repo_url: row.repoUrl,
    // `local_path` in the table is the checkout on the hub host; the contract calls the
    // same thing `working_dir`, which is what a person types.
    working_dir: row.localPath,
    default_branch: row.defaultBranch,
    default_agent_id: row.defaultAgentId,
    report_room_id: row.reportRoomId,
    auto_dispatch: row.autoDispatch,
    counts,
  };
}

export function toWorktree(row: WorktreeRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    path: row.path,
    branch: row.branch,
    base_branch: row.baseRef ?? '',
    // The table has a `failed` state; the contract calls it `error`.
    status: row.status === 'failed' ? 'error' : row.status,
    ahead: row.stats.ahead ?? 0,
    behind: row.stats.behind ?? 0,
    changed_files: row.stats.changedFiles ?? 0,
    error: row.error,
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toTask(
  row: TaskRow,
  profile: string,
  extras: {
    nameOf: NameOf;
    subtaskCounts?: { total: number; done: number };
    dependsOn?: string[];
    /** The dependencies not done yet (`TasksService.waitingOn`). */
    waitingOn?: WaitingOn[];
    worktree?: WorktreeRow | undefined;
  },
): Record<string, unknown> {
  const assigneeId = row.assigneeKind === 'agent' ? row.assigneeAgentId : row.assigneeUserId;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    project_id: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: row.tags,
    assignee:
      row.assigneeKind === 'none' || !assigneeId
        ? null
        : {
            kind: row.assigneeKind,
            id: assigneeId,
            // A name the registry no longer knows is the id itself, never an invention.
            name: extras.nameOf(row.assigneeKind, assigneeId) ?? assigneeId,
          },
    auto_start: row.autoStart,
    position: row.position,
    blocked_reason: row.blockedReason,
    status_reason: row.statusReason,
    subtask_counts: extras.subtaskCounts ?? { total: 0, done: 0 },
    depends_on: extras.dependsOn ?? [],
    worktree: toWorktree(extras.worktree),
    session_id: row.sessionId,
    /**
     * What the task row remembers about its run. The run's *state* belongs to the
     * `sessions` module, which owns the runs table; the board shows the id it has and
     * the chat screen shows the rest.
     */
    last_run: { id: row.currentRunId, status: null, finished_at: null },
    attempt_count: row.attemptCount,
    latest_summary: row.latestSummary,
    due_at: row.dueAt?.toISOString() ?? null,
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    external:
      row.externalSource && row.externalId
        ? { source: row.externalSource, id: row.externalId }
        : null,
    archived_at: row.archivedAt?.toISOString() ?? null,
    attachment_ids: row.attachmentIds,
    waiting_on: extras.waitingOn ?? [],
    // Only a running task can be stuck; a marker left on any other is not shown.
    stuck_since: row.status === 'running' ? (row.stuckAt?.toISOString() ?? null) : null,
    definition_of_done: row.definitionOfDone ?? [],
    constraints: row.constraints ?? [],
  };
}

export function toSubtask(row: SubtaskRow): Record<string, unknown> {
  return {
    id: row.id,
    task_id: row.taskId,
    index: row.index,
    title: row.title,
    status: row.status,
    note: row.note,
    blocked_reason: row.blockedReason,
    completed_at: row.completedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toComment(row: CommentRow, nameOf: NameOf): Record<string, unknown> {
  const kind = row.authorKind === 'agent' ? 'agent' : row.authorKind === 'user' ? 'user' : 'system';
  return {
    id: row.id,
    task_id: row.taskId,
    author: {
      kind,
      id: row.authorId,
      name:
        row.authorName ??
        (row.authorId && (kind === 'agent' || kind === 'user')
          ? (nameOf(kind, row.authorId) ?? row.authorId)
          : 'system'),
      avatar: null,
    },
    content: row.body,
    created_at: row.createdAt.toISOString(),
  };
}
