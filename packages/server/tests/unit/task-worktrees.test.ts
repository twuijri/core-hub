/**
 * Tasks, stage 2: a git worktree per task and `auto_start` — against a **real** git
 * repository in the profile's folder, with the scripted runner playing the agent.
 *
 * What these prove: starting a task of a project with a repository makes a real worktree on
 * the task's own branch and the run works in it; git's refusal is kept word for word and
 * stops the start; Remove, delete and archive take the folder and keep the branch; a task
 * set to start on its own does, and no more of them at once than the setting allows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { taskRunsFor } from '../../src/modules/tasks/index.js';
import { authed, drainJobs, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';
const UNKNOWN_AGENT = '01KAGENTZZZZ00000000000000';

const finishes: ScriptStep[] = [{ type: 'message_delta', text: 'تم.' }, { type: 'completed' }];
/** A run that works until somebody stops it. */
const waits: ScriptStep[] = [{ type: 'message_delta', text: 'أعمل…' }, { type: 'await_input' }];

async function hubWith(script: ScriptStep[], env: Record<string, string> = {}) {
  const runner = new FakeAgentRunner({ script });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  const hub = await signedInHub(env, { modules });
  return { hub, runner };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const profileDir = (hub: Hub) => path.join(hub.dataDir, 'workspaces', 'default');

/** A real repository with one commit on `trunk`, inside the default profile's folder. */
function makeRepo(hub: Hub, name = 'repo'): string {
  const repo = path.join(profileDir(hub), name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'trunk');
  writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

async function newTask(hub: Hub, title: string, extra: Json = {}) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { title, status: 'ready', auto_start: false, ...extra },
  });
  expect(created.statusCode).toBe(201);
  return created.json() as Json & { id: string; project_id: string };
}

const patchProject = (hub: Hub, id: string, payload: Json) =>
  authed(hub, hub.token, { method: 'PATCH', url: `/api/v1/projects/${id}`, payload });

async function getTask(hub: Hub, id: string) {
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${id}` })
  ).json() as Json;
}

/** A task in a project whose repository is set. */
async function repoTask(hub: Hub, title: string, extra: Json = {}) {
  const repo = makeRepo(hub);
  const task = await newTask(hub, title, extra);
  const set = await patchProject(hub, task.project_id, { working_dir: 'repo' });
  expect(set.statusCode).toBe(200);
  return { repo, task };
}

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("tasks: a project's repository", () => {
  it('is a git work tree inside the profile, stored as its path with its branch', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const repo = makeRepo(hub);
      mkdirSync(path.join(profileDir(hub), 'plain'), { recursive: true });
      const task = await newTask(hub, 'x');

      const outside = await patchProject(hub, task.project_id, { working_dir: '/etc' });
      expect(outside.statusCode).toBe(400);
      expect(outside.json()).toMatchObject({
        details: { field: 'working_dir', reason: 'outside_root' },
      });
      const escape = await patchProject(hub, task.project_id, { working_dir: '../../..' });
      expect(escape.json()).toMatchObject({ details: { reason: 'outside_root' } });
      const plain = await patchProject(hub, task.project_id, { working_dir: 'plain' });
      expect(plain.statusCode).toBe(400);
      expect(plain.json()).toMatchObject({ details: { reason: 'not_a_git_repo' } });
      const missing = await patchProject(hub, task.project_id, { working_dir: 'nowhere' });
      expect(missing.json()).toMatchObject({ details: { reason: 'not_found' } });

      const ok = await patchProject(hub, task.project_id, { working_dir: 'repo' });
      expect(ok.statusCode).toBe(200);
      // The branch checked out there is the base, since none was given with it.
      expect(ok.json()).toMatchObject({ working_dir: repo, default_branch: 'trunk' });

      const cleared = await patchProject(hub, task.project_id, { working_dir: '' });
      expect(cleared.json()).toMatchObject({ working_dir: null });
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: a git worktree per task', () => {
  it('starting the task makes a real worktree on its own branch, and the run works in it', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const { repo, task } = await repoTask(hub, 'Settings page');
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      expect(started.statusCode).toBe(202);
      await taskRunsFor(hub.app).settled();

      const after = await getTask(hub, task.id);
      const worktree = after.worktree as Json;
      expect(worktree).toMatchObject({ status: 'ready', base_branch: 'trunk', error: null });
      expect(worktree.branch).toMatch(/^task\/[a-z0-9-]+-settings-page$/);
      expect(worktree.path).toBe(
        path.join(profileDir(hub), 'worktrees', String(worktree.branch).slice('task/'.length)),
      );
      expect(existsSync(path.join(String(worktree.path), 'README.md'))).toBe(true);
      expect(git(repo, 'worktree', 'list')).toContain(String(worktree.path));
      expect(git(String(worktree.path), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
        worktree.branch,
      );

      // The agent's working directory is the worktree, and so is the session's.
      expect(runner.started[0]?.workingDir).toBe(worktree.path);
      const session = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/sessions/${after.session_id as string}`,
        })
      ).json() as Json;
      expect(session.working_dir).toBe(worktree.path);
      // The run's own files are not the task's work: the worktree is not dirty because of them.
      expect(git(String(worktree.path), 'status', '--porcelain').trim()).toBe('');
    } finally {
      await hub.close();
    }
  });

  it("git's refusal is kept word for word, and the task does not start", async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const { task } = await repoTask(hub, 'Settings page');
      await patchProject(hub, task.project_id, { default_branch: 'no-such-branch' });
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      expect(started.statusCode).toBe(409);
      const body = started.json() as { details: { reason: string; message: string } };
      expect(body.details.reason).toBe('worktree_failed');
      expect(body.details.message).toMatch(/no-such-branch/);

      const after = await getTask(hub, task.id);
      expect(after).toMatchObject({ status: 'ready', session_id: null, assignee: null });
      expect(after.worktree).toMatchObject({ status: 'error' });
      expect(String((after.worktree as Json).error)).toBe(body.details.message);
      expect(runner.started).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it('Remove takes the folder and keeps the branch; not while the task runs', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const { repo, task } = await repoTask(hub, 'Settings page');
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      await until(() => runner.started.length === 1);
      const worktree = (await getTask(hub, task.id)).worktree as Json;

      const busy = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${task.id}/worktree`,
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ details: { reason: 'task_running' } });

      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${task.id}/stop` });
      await taskRunsFor(hub.app).settled();
      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${task.id}/worktree`,
      });
      expect(removed.statusCode).toBe(202);
      await drainJobs(hub.app);

      expect(existsSync(String(worktree.path))).toBe(false);
      expect(git(repo, 'worktree', 'list')).not.toContain(String(worktree.path));
      expect(git(repo, 'branch', '--list', String(worktree.branch))).toContain(
        String(worktree.branch),
      );
      expect((await getTask(hub, task.id)).worktree).toBeNull();
      const gone = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${task.id}/worktree`,
      });
      expect(gone.statusCode).toBe(404);

      // Made again from the details: the same branch, which git kept, continues.
      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/worktree`,
        payload: {},
      });
      expect(again.statusCode).toBe(202);
      await drainJobs(hub.app);
      expect((await getTask(hub, task.id)).worktree).toMatchObject({
        status: 'ready',
        branch: worktree.branch,
        path: worktree.path,
      });
    } finally {
      await hub.close();
    }
  });

  it('deleting or archiving the task removes its worktree and keeps the branch', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const { repo, task } = await repoTask(hub, 'First');
      const second = await newTask(hub, 'Second');
      for (const id of [task.id, second.id]) {
        await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${id}/assign`,
          payload: { agent_id: AGENT, start: true },
        });
      }
      await taskRunsFor(hub.app).settled();
      const first = (await getTask(hub, task.id)).worktree as Json;
      const other = (await getTask(hub, second.id)).worktree as Json;
      expect(existsSync(String(first.path))).toBe(true);
      expect(existsSync(String(other.path))).toBe(true);

      const deleted = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${task.id}`,
      });
      expect(deleted.statusCode).toBe(204);
      expect(existsSync(String(first.path))).toBe(false);

      const archived = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${second.id}/move`,
        payload: { status: 'archived' },
      });
      expect(archived.statusCode).toBe(200);
      expect(existsSync(String(other.path))).toBe(false);
      expect((await getTask(hub, second.id)).worktree).toBeNull();

      const branches = git(repo, 'branch', '--list', 'task/*');
      expect(branches).toContain(String(first.branch));
      expect(branches).toContain(String(other.branch));
    } finally {
      await hub.close();
    }
  });

  it('a task whose project has no repository keeps the session’s own folder', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'No repository');
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      await taskRunsFor(hub.app).settled();
      const after = await getTask(hub, task.id);
      expect(after.worktree).toBeNull();
      expect(runner.started[0]?.workingDir).toBe(
        path.join(profileDir(hub), String(after.session_id)),
      );
      const make = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/worktree`,
        payload: {},
      });
      expect(make.statusCode).toBe(409);
      expect(make.json()).toMatchObject({ details: { reason: 'no_repository' } });
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: auto_start', () => {
  it('a task created ready, assigned and set to start on its own starts by itself', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'Auto', { assignee_agent_id: AGENT, auto_start: true });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(1);
      const after = await getTask(hub, task.id);
      expect(after).toMatchObject({ status: 'review', attempt_count: 1 });
      expect(after.session_id).toMatch(/^[0-9A-Z]{26}$/);
    } finally {
      await hub.close();
    }
  });

  it('starts when it becomes ready and assigned — by an assignment or a move to Ready', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const assigned = await newTask(hub, 'Assigned later', { status: 'todo', auto_start: true });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(0);
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${assigned.id}/assign`,
        payload: { agent_id: AGENT, start: false },
      });
      expect(response.json()).toMatchObject({ run_id: null });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(1);
      expect((await getTask(hub, assigned.id)).status).toBe('review');

      const moved = await newTask(hub, 'Moved later', {
        status: 'todo',
        assignee_agent_id: AGENT,
        auto_start: true,
      });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(1);
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${moved.id}/move`,
        payload: { status: 'ready' },
      });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(2);

      // A task without auto_start is only assigned, as before.
      const manual = await newTask(hub, 'Manual', { assignee_agent_id: AGENT });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(2);
      expect((await getTask(hub, manual.id)).status).toBe('ready');
    } finally {
      await hub.close();
    }
  });

  it('never more at once per profile than the setting; the next starts when a place frees', async () => {
    const { hub, runner } = await hubWith(waits, { COREHUB_TASK_AUTO_START_MAX: '2' });
    try {
      const ids: string[] = [];
      for (const title of ['One', 'Two', 'Three']) {
        ids.push((await newTask(hub, title, { assignee_agent_id: AGENT, auto_start: true })).id);
      }
      await until(() => runner.started.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runner.started).toHaveLength(2);
      const statuses = await Promise.all(ids.map(async (id) => (await getTask(hub, id)).status));
      expect(statuses).toEqual(['running', 'running', 'ready']);

      // A person's "assign and start" is never held back by the setting.
      const manual = await newTask(hub, 'Manual');
      const now = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${manual.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      expect(now.statusCode).toBe(202);
      await until(() => runner.started.length === 3);

      // Stopping one frees its place: the third starts. The stopped one does not restart.
      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${ids[0]}/stop` });
      await until(() => runner.started.length === 4);
      const first = await getTask(hub, ids[0]!);
      expect(first).toMatchObject({ status: 'ready', auto_start: false });
      expect((await getTask(hub, ids[2]!)).status).toBe('running');

      for (const id of [ids[1]!, ids[2]!, manual.id]) {
        await authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${id}/stop` });
      }
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(4);
    } finally {
      await hub.close();
    }
  });

  it('a task that cannot start on its own goes to blocked, saying why', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'Nobody', {
        assignee_agent_id: UNKNOWN_AGENT,
        auto_start: true,
      });
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(0);
      const after = await getTask(hub, task.id);
      expect(after.status).toBe('blocked');
      expect(String(after.blocked_reason)).toMatch(
        /^(The task could not start automatically|تعذّر بدء المهمة تلقائيًا): /,
      );
    } finally {
      await hub.close();
    }
  });
});
