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
  board: (profile: string, projectId: string) => ['task-columns', profile, projectId] as const,
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

export function useBoard(projectId: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: taskKeys.board(profile, projectId ?? 'none'),
    queryFn: async () =>
      (
        await client.request('get', '/task-columns', {
          query: { project_id: projectId as string },
        })
      ).data as unknown as { project_id: string; columns: Column[]; counts: { total: number } },
    enabled: !!session && !!projectId,
  });
}

/** Everything the board changes goes through here, so it is refetched once per change. */
function useInvalidateBoard(projectId: string | null): () => void {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: taskKeys.board(profile, projectId ?? 'none'),
    });
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

export function useCreateTask(projectId: string | null) {
  const { client } = useAuth();
  const refresh = useInvalidateBoard(projectId);
  return useMutation({
    mutationFn: async (body: { title: string; status?: 'triage' | 'todo' | 'ready' }) =>
      (
        await client.request('post', '/tasks', {
          // `auto_start` and `status` carry defaults in the contract and are required on
          // the wire, so the client sends them rather than relying on the server's.
          body: {
            project_id: projectId as string,
            auto_start: false,
            status: body.status ?? 'triage',
            title: body.title,
          },
        })
      ).data,
    onSuccess: refresh,
  });
}

export function useMoveTask(projectId: string | null) {
  const { client } = useAuth();
  const refresh = useInvalidateBoard(projectId);
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

export function useUpdateTask(projectId: string | null) {
  const { client } = useAuth();
  const refresh = useInvalidateBoard(projectId);
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      (await client.request('patch', '/tasks/{task_id}', { params: { task_id: id }, body: patch }))
        .data,
    onSuccess: refresh,
  });
}

export function useDeleteTask(projectId: string | null) {
  const { client } = useAuth();
  const refresh = useInvalidateBoard(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/tasks/{task_id}', { params: { task_id: id } });
      return id;
    },
    onSuccess: refresh,
  });
}
