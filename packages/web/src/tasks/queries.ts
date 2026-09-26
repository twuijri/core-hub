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
   * The board is global, so the key is the **filter**, never a profile: it holds every
   * profile the person may enter, with no profile filter (ADR 0016, owner 2026-09-24:
   * «الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون تصنيف»). Switching the top
   * selector does not change what the board shows.
   */
  board: (filter: BoardFilter) =>
    ['task-columns', filter.projectId ?? 'all', filter.agentId ?? 'all'] as const,
};

export interface Project {
  id: string;
  name: string;
  status: string;
  color: string | null;
  /** The project's git repository, inside the profile's folder; tasks get worktrees of it. */
  working_dir: string | null;
  /** The branch a task's worktree branches from. */
  default_branch?: string | null;
  counts: { total: number; by_status: Record<string, number> };
}

/** A task's own git worktree (contract `Worktree`). */
export interface Worktree {
  path: string;
  branch: string;
  base_branch: string;
  status: 'creating' | 'ready' | 'dirty' | 'merged' | 'removed' | 'error';
  ahead: number;
  behind: number;
  changed_files: number;
  /** git's own message when it refused. */
  error: string | null;
  updated_at: string;
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
  /** The profile the task is in; the board holds every profile. */
  profile?: string;
  /** The conversation the agent works the task in, once it has been started. */
  session_id?: string | null;
  /** The agent's last words when its run ended — what the card shows in Review. */
  latest_summary?: string | null;
  last_run?: { id: string | null } | null;
  /** Start a run on its own once the task is ready and given to an agent. */
  auto_start?: boolean;
  /** The task's git worktree, when its project has a repository and it was made. */
  worktree?: Worktree | null;
  /**
   * What it depends on that is not done yet (DECISIONS §93). A task set to start on its own
   * waits for all of these; a person may still start it by hand, after a warning.
   */
  waiting_on?: TaskDependencyState[];
  /** Set while it runs and its run has been silent too long: the stuck-task watchdog. */
  stuck_since?: string | null;
}

/** A dependency, as far as waiting for it goes (contract `TaskDependencyState`). */
export interface TaskDependencyState {
  id: string;
  title: string;
  status: TaskStatus;
}

/** What `tasks.assignTask` answers: real ids when the task started, `null` when it did not. */
export interface TaskAssigned {
  task_id: string;
  job_id: string | null;
  run_id: string | null;
  session_id: string | null;
}

/** What was said on a task (contract `Comment`). */
export interface TaskComment {
  id: string;
  task_id: string;
  author: { kind: 'user' | 'agent' | 'system'; id: string | null; name: string };
  content: string;
  created_at: string;
}

/** One task opened on its own (contract `TaskDetail`): the card, and what was said on it. */
export interface TaskDetail extends Task {
  comments: TaskComment[];
}

/**
 * The board holds every workspace, so a write names the workspace **the card** is in, not
 * the one in the header — a card from another workspace is acted on where it lives, as a
 * schedule on the global Schedules page is. Without it the hub looks for the card in the
 * header's workspace and answers 404.
 */
function inWorkspace(profile: string | undefined): { headers?: Record<string, string> } {
  return profile ? { headers: { 'X-Hub-Profile': profile } } : {};
}

/** A card to act on: its id, and the workspace it is in when the board said. */
export interface TaskRef {
  id: string;
  profile?: string | undefined;
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

/** What narrows the board. Never a profile: the board is every profile (ADR 0016). */
export interface BoardFilter {
  projectId?: string | undefined;
  agentId?: string | undefined;
}

/** While a card is running the board asks again this often, whatever workspace it is in. */
export const RUNNING_REFRESH_MS = 4_000;

export function useBoard(filter: BoardFilter) {
  const { client, session } = useAuth();
  return useQuery({
    // A run ends on its own time. The realtime events of every profile refresh the board
    // (`/rt/tasks` with `profiles: 'all'`); this is the net under them, and only while
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
            // Every profile the person may enter — the hub decides which (DECISIONS §32).
            profiles: 'all',
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
 *
 * Asked for only while `open` — when a person opens the archive (DECISIONS §93). Until then
 * the board's own `archived` column says how many there are, which is all the link needs.
 */
export function useArchive(filter: BoardFilter, open: boolean) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: [...taskKeys.board(filter), 'archived'] as const,
    queryFn: async () => {
      const board = (
        await client.request('get', '/task-columns', {
          query: {
            include_archived: true,
            profiles: 'all',
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
            ...(filter.agentId ? { agent_id: filter.agentId } : {}),
          },
        })
      ).data as unknown as { columns: Column[] };
      return board.columns.find((column) => column.status === 'archived')?.tasks ?? [];
    },
    enabled: !!session && open,
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
    void queryClient.invalidateQueries({ queryKey: ['task'] });
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

/** Edit a project of the profile the person is in — its repository and base branch. */
export function useUpdateProject() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      working_dir?: string | null;
      default_branch?: string | null;
    }) =>
      (
        await client.request('patch', '/projects/{project_id}', {
          params: { project_id: id },
          body,
        })
      ).data as unknown as Project,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: taskKeys.projects(profile) }),
  });
}

/**
 * A new task is made in the profile the person is in — the top selector — and nowhere else
 * (ADR 0016): the board shows every profile, but only one control decides where things are
 * made.
 */
export function useCreateTask() {
  const { client, homeProfile } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async (body: { title: string; status?: 'triage' | 'todo' | 'ready' }) =>
      (
        await client.request('post', '/tasks', {
          ...inWorkspace(homeProfile),
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
      profile,
      ...body
    }: {
      id: string;
      profile?: string | undefined;
      status: TaskStatus;
      after_task_id?: string | null;
      reason?: string | null;
    }) =>
      (
        await client.request('post', '/tasks/{task_id}/move', {
          params: { task_id: id },
          body,
          ...inWorkspace(profile),
        })
      ).data,
    onSuccess: refresh,
  });
}

export function useUpdateTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({
      id,
      profile,
      patch,
    }: {
      id: string;
      profile?: string | undefined;
      patch: Record<string, unknown>;
    }) =>
      (
        await client.request('patch', '/tasks/{task_id}', {
          params: { task_id: id },
          body: patch,
          ...inWorkspace(profile),
        })
      ).data as unknown as Task,
    onSuccess: refresh,
  });
}

/**
 * One task with what was said on it. For a card on Hermes's board the hub reads it from
 * Hermes as it answers, so this is Hermes's card and Hermes's comments.
 */
export function useTaskDetail(ref: TaskRef | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['task', ref?.id ?? '', ref?.profile ?? ''] as const,
    queryFn: async () =>
      (
        await client.request('get', '/tasks/{task_id}', {
          params: { task_id: ref!.id },
          ...inWorkspace(ref!.profile),
        })
      ).data as unknown as TaskDetail,
    enabled: !!session && !!ref,
  });
}

/** Say something on a task. On a Hermes card it is said on Hermes's card, in your name. */
export function useAddComment() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, profile, content }: TaskRef & { content: string }) =>
      (
        await client.request('post', '/tasks/{task_id}/comments', {
          params: { task_id: id },
          body: { content },
          ...inWorkspace(profile),
        })
      ).data as unknown as TaskComment,
    onSuccess: (_comment, { id }) => void queryClient.invalidateQueries({ queryKey: ['task', id] }),
  });
}

export function useDeleteTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({ id, profile }: TaskRef) => {
      await client.request('delete', '/tasks/{task_id}', {
        params: { task_id: id },
        ...inWorkspace(profile),
      });
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
      workspace,
      handTo,
      ...body
    }: {
      id: string;
      /** The workspace the card is in (the request's scope). */
      workspace?: string | undefined;
      /** A Hermes card only: the workspace whose Hermes profile takes it (contract `profile`). */
      handTo?: string | undefined;
      agent_id: string;
      start: boolean;
      instructions: string | null;
    }) =>
      (
        await client.request('post', '/tasks/{task_id}/assign', {
          params: { task_id: id },
          body: { ...body, model: null, provider: null, ...(handTo ? { profile: handTo } : {}) },
          ...inWorkspace(workspace),
        })
      ).data as unknown as TaskAssigned,
    onSuccess: refresh,
  });
}

/**
 * Remove the task's worktree; git keeps its branch. The hub answers with a job, so the
 * details are asked again once the job had time to run (and on `worktree.updated`).
 */
export function useRemoveWorktree() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({ id, profile }: TaskRef) =>
      (
        await client.request('delete', '/tasks/{task_id}/worktree', {
          params: { task_id: id },
          ...inWorkspace(profile),
        })
      ).data as unknown as { job_id: string },
    onSuccess: refresh,
  });
}

/** Stop the task's run; it stays with its agent and waits in `ready`. */
export function useStopTask() {
  const { client } = useAuth();
  const refresh = useInvalidateBoard();
  return useMutation({
    mutationFn: async ({ id, profile }: TaskRef) => {
      await client.request('post', '/tasks/{task_id}/stop', {
        params: { task_id: id },
        ...inWorkspace(profile),
      });
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
    mutationFn: async ({ id, profile }: TaskRef) => {
      await client.request('delete', '/tasks/{task_id}/assign', {
        params: { task_id: id },
        ...inWorkspace(profile),
      });
      return id;
    },
    onSuccess: refresh,
  });
}

/**
 * The board follows `/rt/tasks`: a run that ends moves its card on the hub, and the board
 * redraws when the hub says so rather than when somebody reloads. The socket hears every
 * profile the person may enter (`profiles: 'all'`, realtime/context.tsx), as the board shows.
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
      // An open task's details show its worktree, which changes on its own time (git).
      void queryClient.invalidateQueries({ queryKey: ['task'] });
    };
    for (const name of TASK_EVENTS) socket.on(name, handler);
    if (!socket.connected) socket.connect();
    return () => {
      for (const name of TASK_EVENTS) socket.off(name, handler);
    };
  }, [profile, queryClient, realtime.epoch]);
}
