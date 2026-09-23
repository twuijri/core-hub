/**
 * The Tasks section's reads and writes.
 *
 * The board is **one call** (`tasks.getColumns`): nine columns with their ordered tasks
 * and the counts, so the screen draws without asking nine times. Every write invalidates
 * that one key, which is why a move, a rename and a new task all reach the board the same
 * way and none of them needs its own refresh.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { TASK_EVENTS, isEnvelope } from '../realtime/envelope.js';

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
  /** Set when the card reflects one on an agent's own board (Hermes's kanban). */
  external?: { source: 'hermes'; id: string } | null;
  /** The workspace the task is in; the board holds every workspace. */
  profile?: string;
  /** The conversation the agent works the task in, once it has been started. */
  session_id?: string | null;
  /** The agent's last words when its run ended — what the card shows in Review. */
  latest_summary?: string | null;
  last_run?: { id: string | null } | null;
}

/** What `tasks.assignTask` answers: real ids when the task started, `null` when it did not. */
export interface TaskAssigned {
  task_id: string;
  job_id: string | null;
  run_id: string | null;
  session_id: string | null;
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

/** While a card is running the board asks again this often, whatever workspace it is in. */
export const RUNNING_REFRESH_MS = 4_000;

export function useBoard(filter: BoardFilter) {
  const { client, session } = useAuth();
  return useQuery({
    // A run ends on its own time. The realtime events refresh the board for the workspace
    // in the header; a card from another workspace is caught by this, and only while
    // something is actually running.
    refetchInterval: (query) =>
      query.state.data?.columns.some((column) => column.status === 'running' && column.count > 0)
        ? RUNNING_REFRESH_MS
        : false,
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
 * The archive behind Done: the same one call with `include_archived`, keeping only the
 * archived column. A separate query on purpose — the board is asked again every few
 * seconds while something runs, and the archive only grows, so it is not dragged along on
 * every one of those. Its key starts with the board's, so every write refreshes it too.
 */
export function useArchive(filter: BoardFilter) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: [...taskKeys.board(filter), 'archived'] as const,
    queryFn: async () => {
      const board = (
        await client.request('get', '/task-columns', {
          query: {
            include_archived: true,
            ...(filter.profile ? { profile: filter.profile } : {}),
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
            ...(filter.agentId ? { agent_id: filter.agentId } : {}),
          },
        })
      ).data as unknown as { columns: Column[] };
      return board.columns.find((column) => column.status === 'archived')?.tasks ?? [];
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

/**
 * Give a task to an agent, and — with `start` — have it start now: the hub opens the
 * task's conversation, queues the run and answers with its ids.
 */
export function useAssignTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      agent_id: string;
      start: boolean;
      instructions: string | null;
    }) =>
      (
        await client.request('post', '/tasks/{task_id}/assign', {
          params: { task_id: id },
          body: { ...body, model: null, provider: null },
        })
      ).data as unknown as TaskAssigned,
    onSuccess: refresh,
  });
}

/** Stop the task's run; it stays with its agent and waits in `ready`. */
export function useStopTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('post', '/tasks/{task_id}/stop', { params: { task_id: id } });
      return id;
    },
    onSuccess: refresh,
  });
}

/** Take the task away from its agent, stopping its run if it has one. */
export function useUnassignTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/tasks/{task_id}/assign', { params: { task_id: id } });
      return id;
    },
    onSuccess: refresh,
  });
}

/**
 * The board follows `/rt/tasks`: a run that ends moves its card on the hub, and the board
 * redraws when the hub says so rather than when somebody reloads.
 */
export function useTaskEvents(): void {
  const realtime = useRealtime();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = realtime.socket('tasks');
    const handler = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      void queryClient.invalidateQueries({ queryKey: ['task-columns'] });
    };
    for (const name of TASK_EVENTS) socket.on(name, handler);
    if (!socket.connected) socket.connect();
    return () => {
      for (const name of TASK_EVENTS) socket.off(name, handler);
    };
  }, [profile, queryClient, realtime.epoch]);
}
