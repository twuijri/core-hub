/**
 * The Tasks section's reads and writes.
 *
 * The board is **one call** (`tasks.getColumns`): nine columns with their ordered tasks
 * and the counts, so the screen draws without asking nine times. Every write invalidates
 * that one key, which is why a move, a rename and a new task all reach the board the same
 * way and none of them needs its own refresh.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';

/** The nine columns, in workflow order — the contract's `TaskStatus`. */
export const TASK_STATUSES = [
  'triage',
  'todo',
  'ready',
  'scheduled',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const taskKeys = {
  projects: (profile: string) => ['projects', profile] as const,
  /**
   * The board is global, so the key is the **filter**, not the workspace. Switching the
   * workspace chip no longer changes what the board shows — one page holds every
   * workspace (owner decision, 2026-09-23) — so the profile is only in the key when it
   * is the filter the person chose.
   */
  board: (filter: BoardFilter) =>
    [
      'task-columns',
      filter.profile ?? 'all',
      filter.projectId ?? 'all',
      filter.agentId ?? 'all',
    ] as const,
};

export interface Project {
  id: string;
  name: string;
  status: string;
  color: string | null;
  working_dir: string | null;
  counts: { total: number; by_status: Record<string, number> };
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: string;
  tags: string[];
  assignee: { kind: string; id: string; name: string } | null;
  position: string;
  blocked_reason: string | null;
  subtask_counts: { total: number; done: number };
  depends_on: string[];
  due_at: string | null;
}

export interface Column {
  status: TaskStatus;
  count: number;
  tasks: Task[];
}

export function useProjects() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: taskKeys.projects(profile),
    queryFn: async () =>
      (await client.request('get', '/projects')).data as unknown as { items: Project[] },
    enabled: !!session,
  });
}

export interface BoardFilter {
  profile?: string | undefined;
  projectId?: string | undefined;
  agentId?: string | undefined;
}

export function useBoard(filter: BoardFilter) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: taskKeys.board(filter),
    queryFn: async () =>
      (
        await client.request('get', '/task-columns', {
          query: {
            ...(filter.profile ? { profile: filter.profile } : {}),
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
            ...(filter.agentId ? { agent_id: filter.agentId } : {}),
          },
        })
      ).data as unknown as {
        project_id: string | null;
        columns: Column[];
        counts: { total: number };
      },
    enabled: !!session,
  });
}

/**
 * Every write refreshes every view of the board.
 *
 * The board is one page with filters, so a task created while a filter is on still
 * changes what the unfiltered board holds — invalidating only the current filter would
 * leave the other views stale behind it.
 */
function useInvalidateBoard(): () => void {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['task-columns'] });
    void queryClient.invalidateQueries({ queryKey: taskKeys.projects(profile) });
  };
}

export function useCreateProject() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; working_dir?: string | null }) =>
      (await client.request('post', '/projects', { body })).data as unknown as Project,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: taskKeys.projects(profile) }),
  });
}

export function useCreateTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async (body: { title: string; status?: 'triage' | 'todo' | 'ready' }) =>
      (
        await client.request('post', '/tasks', {
          // `auto_start` and `status` carry defaults in the contract and are required on
          // the wire, so the client sends them rather than relying on the server's.
          // No `project_id`: the hub puts it in the workspace's own project, so writing
          // something down never starts with inventing a container for it.
          body: {
            auto_start: false,
            status: body.status ?? 'triage',
            title: body.title,
          },
        })
      ).data,
    onSuccess: refresh,
  });
}

export function useMoveTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      status: TaskStatus;
      after_task_id?: string | null;
      reason?: string | null;
    }) =>
      (await client.request('post', '/tasks/{task_id}/move', { params: { task_id: id }, body }))
        .data,
    onSuccess: refresh,
  });
}

export function useUpdateTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      (await client.request('patch', '/tasks/{task_id}', { params: { task_id: id }, body: patch }))
        .data,
    onSuccess: refresh,
  });
}

export function useDeleteTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/tasks/{task_id}', { params: { task_id: id } });
      return id;
    },
    onSuccess: refresh,
  });
}
