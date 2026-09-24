/**
 * A session's working directory: created for real, kept inside the workspace
 * root, and refused with the contract's envelope when it points anywhere else.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HubError } from '../../lib/errors.js';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';
import {
  ensureWorkingDir,
  listWorkingDirs,
  resolveWorkingDir,
  workspaceRoot,
} from './working-dir.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

describe('working-dir (pure)', () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'corehub-wd-'));
    root = workspaceRoot(base, 'work');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('puts the root under <dataDir>/workspaces/<profile>', () => {
    expect(root).toBe(path.join(base, 'workspaces', 'work'));
  });

  it('accepts a relative name and an absolute path inside the root', () => {
    expect(resolveWorkingDir(root, 'corehub')).toBe(path.join(root, 'corehub'));
    expect(resolveWorkingDir(root, path.join(root, 'deep', 'er'))).toBe(
      path.join(root, 'deep', 'er'),
    );
    expect(resolveWorkingDir(root, '.')).toBe(root);
  });

  it('creates the folder, and the generated fallback is the session id', () => {
    const made = ensureWorkingDir(root, null, '01J8QK3ZR2W7M5N4P6T8V9X0YA');
    expect(made).toBe(path.join(root, '01J8QK3ZR2W7M5N4P6T8V9X0YA'));
    expect(statSync(made).isDirectory()).toBe(true);
  });

  it('refuses an escape, whatever shape it takes', () => {
    for (const bad of ['../outside', '../../etc', '/etc', path.join(base, 'elsewhere'), '', ' ']) {
      let thrown: unknown;
      try {
        resolveWorkingDir(root, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `"${bad}" was accepted`).toBeInstanceOf(HubError);
      expect((thrown as HubError).code).toBe('validation_failed');
      expect((thrown as HubError).status).toBe(400);
    }
  });

  it('refuses a symlink inside the root instead of following it out', () => {
    mkdirSync(root, { recursive: true });
    const outside = path.join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(root, 'link'));
    expect(() => resolveWorkingDir(root, 'link')).toThrow(HubError);
    expect(() => resolveWorkingDir(root, path.join('link', 'deeper'))).toThrow(HubError);
  });

  it('refuses a path whose segment is a file, not a folder', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'notes.md'), 'hi');
    expect(() => resolveWorkingDir(root, 'notes.md')).toThrow(HubError);
  });

  it('lists the folders under the root and nothing else', () => {
    mkdirSync(path.join(root, 'alpha'), { recursive: true });
    mkdirSync(path.join(root, 'beta'), { recursive: true });
    writeFileSync(path.join(root, 'loose.txt'), 'x');
    const listed = listWorkingDirs(root);
    expect(listed.items.map((item) => item.name).sort()).toEqual(['alpha', 'beta']);
    expect(listed.items.every((item) => item.path.startsWith(listed.root))).toBe(true);
  });
});

describe('sessions: the working directory over HTTP', () => {
  let hub: TestHub;
  beforeEach(async () => {
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({
        script: [{ type: 'message_delta', text: 'ok' }, { type: 'completed' }],
      }),
    });
    hub = await testHub(
      {},
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
  });
  afterEach(async () => hub.close());

  const call = (
    app: FastifyInstance,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-hub-profile': 'default' },
      ...(body === undefined ? {} : { payload: body as object }),
    });

  it('reports the root and creates a folder named after the session when nobody chose one', async () => {
    const roots = await call(hub.app, 'GET', '/sessions/working-dirs');
    expect(roots.statusCode).toBe(200);
    const root = (roots.json() as { root: string }).root;
    expect(root.startsWith(hub.dataDir)).toBe(true);

    const created = await call(hub.app, 'POST', '/sessions', { agent_id: AGENT_ID });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string; working_dir: string };
    expect(session.working_dir).toBe(path.join(root, session.id));
    expect(statSync(session.working_dir).isDirectory()).toBe(true);

    const listed = await call(hub.app, 'GET', '/sessions/working-dirs');
    expect(
      (listed.json() as { items: Array<{ name: string }> }).items.map((i) => i.name),
    ).toContain(session.id);
  });

  it('creates the folder the client named, and finds it again on the next session', async () => {
    const first = await call(hub.app, 'POST', '/sessions', {
      agent_id: AGENT_ID,
      working_dir: 'corehub',
    });
    expect(first.statusCode).toBe(201);
    const dir = (first.json() as { working_dir: string }).working_dir;
    expect(path.basename(dir)).toBe('corehub');
    expect(statSync(dir).isDirectory()).toBe(true);

    const second = await call(hub.app, 'POST', '/sessions', {
      agent_id: AGENT_ID,
      working_dir: dir,
    });
    expect((second.json() as { working_dir: string }).working_dir).toBe(dir);
  });

  it('refuses a path outside the root with { error, code } and mints no session', async () => {
    const before = await call(hub.app, 'GET', '/sessions');
    const refused = await call(hub.app, 'POST', '/sessions', {
      agent_id: AGENT_ID,
      working_dir: '../../etc',
    });
    expect(refused.statusCode).toBe(400);
    const envelope = refused.json() as { error: string; code: string; details?: unknown };
    expect(envelope.code).toBe('validation_failed');
    expect(typeof envelope.error).toBe('string');
    expect(envelope.details).toMatchObject({ field: 'working_dir', reason: 'outside_root' });
    const after = await call(hub.app, 'GET', '/sessions');
    expect((after.json() as { items: unknown[] }).items.length).toBe(
      (before.json() as { items: unknown[] }).items.length,
    );
  });

  it('lets the folder change while the session has no runs, and refuses once it has one', async () => {
    const created = await call(hub.app, 'POST', '/sessions', { agent_id: AGENT_ID });
    const id = (created.json() as { id: string }).id;
    const moved = await call(hub.app, 'PATCH', `/sessions/${id}`, { working_dir: 'second-try' });
    expect(moved.statusCode).toBe(200);
    expect(path.basename((moved.json() as { working_dir: string }).working_dir)).toBe('second-try');

    const run = await call(hub.app, 'POST', `/sessions/${id}/runs`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(run.statusCode).toBe(202);
    const late = await call(hub.app, 'PATCH', `/sessions/${id}`, { working_dir: 'too-late' });
    expect(late.statusCode).toBe(409);
    expect((late.json() as { code: string }).code).toBe('state_invalid');
  });

  it('hands the directory to the runner as its cwd', async () => {
    const runner = new FakeAgentRunner({
      script: [{ type: 'message_delta', text: 'ok' }, { type: 'completed' }],
    });
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner,
    });
    const own = await testHub(
      {},
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    try {
      const created = await call(own.app, 'POST', '/sessions', {
        agent_id: AGENT_ID,
        working_dir: 'runs-here',
      });
      const session = created.json() as { id: string; working_dir: string };
      await call(own.app, 'POST', `/sessions/${session.id}/runs`, {
        content: [{ type: 'text', text: 'hello' }],
      });
      await vi.waitFor(() => expect(runner.started.length).toBeGreaterThan(0));
      expect(runner.started[0]?.workingDir).toBe(session.working_dir);
    } finally {
      await own.close();
    }
  });
});
