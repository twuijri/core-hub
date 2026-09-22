/**
 * The Tasks section: the board a person drives, and the rules that keep it honest.
 */
import { describe, expect, it } from 'vitest';
import {
  authed,
  drainJobs,
  expectModuleRegistered,
  signedInHub,
} from '../../../tests/unit/helpers.js';
import { tasksModule } from './index.js';

type Json = Record<string, unknown>;

async function boardHub() {
  const hub = await signedInHub();
  const project = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: 'Hub Rewrite', working_dir: '/srv/hub' },
  });
  return { hub, project: project.json() as Json };
}

const newTask = (
  hub: Awaited<ReturnType<typeof boardHub>>['hub'],
  projectId: string,
  title: string,
) =>
  authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { project_id: projectId, title },
  });

describe('module: tasks', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(tasksModule);
  });
});

describe('tasks: projects', () => {
  it('gives a project a short key of its own, and counts its tasks', async () => {
    const { hub, project } = await boardHub();
    try {
      expect(project).toMatchObject({
        name: 'Hub Rewrite',
        working_dir: '/srv/hub',
        status: 'active',
      });
      expect(project.counts).toEqual({ total: 0, by_status: {} });

      await newTask(hub, project.id as string, 'First');
      const again = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/projects/${project.id as string}`,
      });
      expect((again.json() as Json).counts).toEqual({ total: 1, by_status: { triage: 1 } });
    } finally {
      await hub.close();
    }
  });

  it('never gives two projects the same key', async () => {
    const { hub, project } = await boardHub();
    try {
      const second = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/projects',
        payload: { name: 'Hub Rewrite' },
      });
      expect((second.json() as Json).id).not.toBe(project.id);
    } finally {
      await hub.close();
    }
  });

  it('deleting a project takes its tasks with it', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Doomed')).json() as Json;
      await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/projects/${project.id as string}`,
      });
      const gone = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${task.id as string}`,
      });
      expect(gone.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: the board', () => {
  it('opens with nine columns, every one of them named', async () => {
    const { hub, project } = await boardHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/task-columns?project_id=${project.id as string}`,
      });
      expect(response.statusCode).toBe(200);
      const board = response.json() as { columns: Array<{ status: string; tasks: unknown[] }> };
      expect(board.columns.map((column) => column.status)).toEqual([
        'triage',
        'todo',
        'ready',
        'scheduled',
        'running',
        'blocked',
        'review',
        'done',
        'archived',
      ]);
    } finally {
      await hub.close();
    }
  });

  it('keeps a column in the order a person dropped things into, not in id order', async () => {
    const { hub, project } = await boardHub();
    try {
      const a = (await newTask(hub, project.id as string, 'A')).json() as Json;
      const b = (await newTask(hub, project.id as string, 'B')).json() as Json;
      const c = (await newTask(hub, project.id as string, 'C')).json() as Json;

      // Move C to the top of `todo`, then A after it.
      for (const [id, after] of [
        [c.id, null],
        [a.id, c.id],
        [b.id, a.id],
      ] as Array<[string, string | null]>) {
        await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${id}/move`,
          payload: { status: 'todo', after_task_id: after },
        });
      }

      const board = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/task-columns?project_id=${project.id as string}`,
        })
      ).json() as { columns: Array<{ status: string; tasks: Array<{ title: string }> }> };
      const todo = board.columns.find((column) => column.status === 'todo');
      expect(todo?.tasks.map((task) => task.title)).toEqual(['C', 'A', 'B']);
    } finally {
      await hub.close();
    }
  });

  it('refuses to block a task without saying why', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Stuck')).json() as Json;
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id as string}/move`,
        payload: { status: 'blocked' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ details: { reason: 'blocked_needs_reason' } });
    } finally {
      await hub.close();
    }
  });

  it('stamps done and un-stamps it when a task comes back', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Ship')).json() as Json;
      const done = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${task.id as string}/move`,
          payload: { status: 'done', summary: 'shipped' },
        })
      ).json() as Json;
      expect(done.completed_at).not.toBeNull();
      expect(done.latest_summary).toBe('shipped');

      const back = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${task.id as string}/move`,
          payload: { status: 'review' },
        })
      ).json() as Json;
      // A task that comes back from `done` was not done.
      expect(back.completed_at).toBeNull();
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: assignment', () => {
  it('assigns, moves the task to ready, and says plainly that nothing started', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Work')).json() as Json;
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id as string}/assign`,
        payload: { agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0AC' },
      });
      expect(response.statusCode).toBe(202);
      // No invented ids: the worker that would open a session is not built.
      expect(response.json()).toEqual({
        job_id: null,
        run_id: null,
        session_id: null,
        task_id: task.id,
      });

      const after = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${task.id as string}` })
      ).json() as Json;
      expect(after.status).toBe('ready');
      expect(after.assignee).toMatchObject({ kind: 'agent', id: '01J8QK3ZR2W7M5N4P6T8V9X0AC' });
    } finally {
      await hub.close();
    }
  });

  it('unassigning sends a ready task back to todo', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Work')).json() as Json;
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id as string}/assign`,
        payload: { agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0AC' },
      });
      await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${task.id as string}/assign`,
      });
      const after = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${task.id as string}` })
      ).json() as Json;
      expect(after.status).toBe('todo');
      expect(after.assignee).toBeNull();
    } finally {
      await hub.close();
    }
  });

  it('dispatch assigns the ready tasks to the project default, and starts nothing', async () => {
    const { hub, project } = await boardHub();
    try {
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/projects/${project.id as string}`,
        payload: { default_agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0AC' },
      });
      const task = (await newTask(hub, project.id as string, 'Ready one')).json() as Json;
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id as string}/move`,
        payload: { status: 'ready' },
      });
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/task-dispatches',
        payload: { project_id: project.id, max: 5 },
      });
      expect(response.statusCode).toBe(202);
      await drainJobs(hub.app);
      const after = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${task.id as string}` })
      ).json() as Json;
      expect(after.assignee).toMatchObject({ id: '01J8QK3ZR2W7M5N4P6T8V9X0AC' });
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: what a task is made of', () => {
  it('counts its checklist, and a ticked line has a time', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'With a list')).json() as Json;
      const sub = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${task.id as string}/subtasks`,
          payload: { title: 'First step' },
        })
      ).json() as Json;
      expect(sub).toMatchObject({ index: 0, status: 'todo', completed_at: null });

      const done = (
        await authed(hub, hub.token, {
          method: 'PATCH',
          url: `/api/v1/tasks/${task.id as string}/subtasks/${sub.id as string}`,
          payload: { status: 'done' },
        })
      ).json() as Json;
      expect(done.completed_at).not.toBeNull();

      const detail = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${task.id as string}` })
      ).json() as Json;
      expect(detail.subtask_counts).toEqual({ total: 1, done: 1 });
    } finally {
      await hub.close();
    }
  });

  it('refuses a dependency cycle, because a board nobody can finish is not a board', async () => {
    const { hub, project } = await boardHub();
    try {
      const a = (await newTask(hub, project.id as string, 'A')).json() as Json;
      const b = (await newTask(hub, project.id as string, 'B')).json() as Json;
      await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/tasks/${b.id as string}/dependencies`,
        payload: { depends_on: [a.id] },
      });
      const cycle = await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/tasks/${a.id as string}/dependencies`,
        payload: { depends_on: [b.id] },
      });
      expect(cycle.statusCode).toBe(409);
      expect(cycle.json()).toMatchObject({ details: { reason: 'dependency_cycle' } });
    } finally {
      await hub.close();
    }
  });

  it('refuses to let a task wait for itself', async () => {
    const { hub, project } = await boardHub();
    try {
      const a = (await newTask(hub, project.id as string, 'A')).json() as Json;
      const response = await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/tasks/${a.id as string}/dependencies`,
        payload: { depends_on: [a.id] },
      });
      expect(response.json()).toMatchObject({ details: { reason: 'self_dependency' } });
    } finally {
      await hub.close();
    }
  });

  it('writes down every move, and a comment, in one activity list', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Talkative')).json() as Json;
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id as string}/move`,
        payload: { status: 'todo' },
      });
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id as string}/comments`,
        payload: { content: 'starting on this' },
      });
      const activity = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/tasks/${task.id as string}/activity`,
        })
      ).json() as { items: Array<{ kind: string }> };
      expect(activity.items.map((item) => item.kind)).toEqual(['comment', 'moved', 'created']);
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: a task never leaks out of its workspace', () => {
  it('does not find another workspace’s task', async () => {
    const { hub, project } = await boardHub();
    try {
      const task = (await newTask(hub, project.id as string, 'Private')).json() as Json;
      const response = await hub.app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${task.id as string}`,
        headers: { authorization: `Bearer ${hub.token}`, 'x-hub-profile': 'nope' },
      });
      // The workspace does not exist for this caller, so neither does the task.
      expect([403, 404]).toContain(response.statusCode);
    } finally {
      await hub.close();
    }
  });
});
