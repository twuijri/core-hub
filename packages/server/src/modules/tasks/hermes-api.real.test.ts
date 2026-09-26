/**
 * Hermes's cards edited from the hub with **the real Hermes** from the image: a card the
 * kanban CLI created is edited through the hub's own routes — title and description in
 * Arabic, priority, a comment, a reassignment, deletion — and every write is checked with
 * `hermes kanban show --json`, Hermes's own reading of its board. The routes reach Hermes
 * the way the running hub does: the CLI for reads and moves, `hermes serve` for the rest
 * (ADR 0015). Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server exec \
 *     vitest run src/modules/tasks/hermes-api.real.test.ts
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { authed, capturingLogger, signedInHub } from '../../../tests/unit/helpers.js';
import {
  HermesDashboard,
  HermesDashboardRefusal,
  HermesDashboardUnavailable,
  type DashboardSpawner,
  type SpawnedProcess,
} from '../agents/index.js';
import { requireSqlite } from '../../lib/db.js';
import { listWorkspacesFor } from '../auth/index.js';
import { HermesApiUnavailable, createHermesCardApi } from './hermes-api.js';
import { HermesRefusal, createHermesKanban, type KanbanRunner } from './hermes-kanban.js';
import { registerHermesBoard } from './index.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';

interface Shown {
  task: { id: string; title: string; body: string | null; priority: number; assignee: string };
  comments: Array<{ author: string; body: string }>;
}

type Json = Record<string, unknown>;

describe.skipIf(!image)(
  "Hermes's cards edited through Hermes's API (real Hermes; set COREHUB_HERMES_IMAGE to run)",
  () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-kanban-api-home-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-kanban-api-data-'));
    chmodSync(home, 0o777);
    const containers: string[] = [];

    /** `hermes …` in the image against the throwaway home. */
    const hermes = (argv: readonly string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${home}:/hh`,
            '-e',
            'HERMES_HOME=/hh',
            '--entrypoint',
            HERMES,
          ].concat(image!, ...argv),
          { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0,
              stdout: String(stdout),
              stderr: String(stderr),
            }),
        );
      });
    const run: KanbanRunner = (argv) => hermes(['kanban', ...argv]);
    const show = async (id: string): Promise<Shown | null> => {
      const result = await run(['show', id, '--json']);
      return result.code === 0 ? (JSON.parse(result.stdout) as Shown) : null;
    };

    const spawnImpl: DashboardSpawner = (_command, args, options) => {
      const name = `corehub-kanban-api-real-${process.pid}-${containers.length}`;
      containers.push(name);
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'host',
          '-v',
          `${home}:/hh`,
          '-e',
          'HERMES_HOME=/hh',
          '-e',
          'HERMES_DASHBOARD_SESSION_TOKEN',
          '--entrypoint',
          HERMES,
          image!,
          ...args,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HERMES_DASHBOARD_SESSION_TOKEN: options.env.HERMES_DASHBOARD_SESSION_TOKEN,
          },
        },
      );
      return child as unknown as SpawnedProcess;
    };

    const dashboard = new HermesDashboard({
      host: {
        status: () => ({ mode: 'managed', home }),
        executable: () => HERMES,
        cliEnv: () => ({}),
      },
      dataDir,
      log: capturingLogger().logger,
      spawnImpl,
      startTimeoutMs: 120_000,
    });

    // The composition root's port, with the image standing in for the host's `hermes`.
    const kanban = createHermesKanban(run);
    const api = createHermesCardApi({
      warm: () => dashboard.warm(),
      request: async <T>(method: string, route: string, body?: unknown): Promise<T> => {
        try {
          return await dashboard.request<T>(method, route, body);
        } catch (error) {
          if (error instanceof HermesDashboardRefusal)
            throw new HermesRefusal(error.verb, error.message);
          if (error instanceof HermesDashboardUnavailable)
            throw new HermesApiUnavailable(error.message);
          throw error;
        }
      },
    });
    const previous = registerHermesBoard((app) => ({
      kanban: () => kanban,
      agentId: () => null,
      throttleMs: 0,
      api: () => api,
      profiles: () =>
        listWorkspacesFor(requireSqlite(app.hub.database), { id: '', role: 'owner' }).map(
          (row) => ({
            workspace: row.id,
            slug: row.slug,
            profile: row.isDefault ? 'default' : row.slug,
          }),
        ),
    }));

    afterAll(async () => {
      registerHermesBoard(previous);
      await dashboard.close();
      for (const name of containers) {
        try {
          execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
        } catch {
          // already gone with --rm
        }
      }
      for (const dir of [home, dataDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // written by the container's user; the OS reclaims the temp dir
        }
      }
    });

    it('edits, comments on, reassigns and deletes a card the CLI created', async () => {
      const created = JSON.parse(
        (await run(['create', 'Draft card', '--body', 'old body', '--json'])).stdout,
      ) as { id: string };
      // A Hermes profile of its own for the second workspace, as creating one in the hub does.
      await hermes(['profile', 'create', 'design', '--no-alias']);

      const hub = await signedInHub();
      try {
        await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/profiles',
          payload: { slug: 'design', name: 'Design' },
        });
        const board = await authed(hub, hub.token, {
          method: 'GET',
          url: '/api/v1/task-columns',
        });
        const reflection = (board.json() as { columns: Array<{ tasks: Json[] }> }).columns
          .flatMap((column) => column.tasks)
          .find((task) => (task.external as Json | null)?.id === created.id);
        expect(reflection).toBeTruthy();
        const id = reflection!.id as string;

        // Title and description, in Arabic.
        const began = Date.now();
        const edited = await authed(hub, hub.token, {
          method: 'PATCH',
          url: `/api/v1/tasks/${id}`,
          payload: { title: 'مراجعة العقد مع المورّد', description: 'الوصف الجديد بالعربية' },
        });
        console.log(`tasks → hermes serve: first edit ${Date.now() - began} ms`);
        expect(edited.statusCode).toBe(200);
        expect(edited.json()).toMatchObject({
          title: 'مراجعة العقد مع المورّد',
          description: 'الوصف الجديد بالعربية',
        });
        let shown = await show(created.id);
        expect(shown?.task).toMatchObject({
          title: 'مراجعة العقد مع المورّد',
          body: 'الوصف الجديد بالعربية',
        });

        // Priority, on Hermes's scale.
        const urgent = await authed(hub, hub.token, {
          method: 'PATCH',
          url: `/api/v1/tasks/${id}`,
          payload: { priority: 'urgent' },
        });
        expect(urgent.statusCode).toBe(200);
        expect((urgent.json() as Json).priority).toBe('urgent');
        expect((await show(created.id))?.task.priority).toBe(2);

        // A comment, in the person's name, read back from Hermes on the card.
        const said = await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${id}/comments`,
          payload: { content: 'تعليق من المركز' },
        });
        expect(said.statusCode).toBe(201);
        shown = await show(created.id);
        expect(shown?.comments).toContainEqual(
          expect.objectContaining({ author: 'Admin', body: 'تعليق من المركز' }),
        );
        const opened = await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${id}` });
        expect((opened.json() as { comments: Json[] }).comments.map((c) => c.content)).toContain(
          'تعليق من المركز',
        );

        // Hermes's own history of the card, read as it opens (§102): its event log, newest
        // first, and no attempt yet — nobody has run it.
        const history = (opened.json() as { hermes: { events: Json[]; runs: Json[] } | null })
          .hermes;
        console.log(`hermes events: ${history?.events.map((e) => e.kind).join(', ')}`);
        expect(history?.runs).toEqual([]);
        const kinds = history?.events.map((event) => event.kind) ?? [];
        expect(kinds).toContain('created');
        expect(kinds).toContain('commented');
        expect(kinds.at(-1)).toBe('created');

        // Several cards at once (§102): a priority and a comment, on Hermes first.
        const bulk = await authed(hub, hub.token, {
          method: 'PATCH',
          url: '/api/v1/tasks',
          payload: { task_ids: [id], patch: { priority: 'high', comment: 'تعليق جماعي' } },
        });
        expect(bulk.statusCode).toBe(200);
        expect((bulk.json() as { results: Json[] }).results).toEqual([
          { id, ok: true, error: null },
        ]);
        shown = await show(created.id);
        expect(shown?.task.priority).toBe(1);
        expect(shown?.comments).toContainEqual(
          expect.objectContaining({ author: 'Admin', body: 'تعليق جماعي' }),
        );

        // A refusal, in Hermes's words, changes nothing.
        const empty = await authed(hub, hub.token, {
          method: 'PATCH',
          url: `/api/v1/tasks/${id}`,
          payload: { title: '   ' },
        });
        expect(empty.statusCode).toBe(409);
        expect((empty.json() as Json).details).toMatchObject({
          reason: 'hermes_refused',
          message: 'title cannot be empty',
        });
        expect((await show(created.id))?.task.title).toBe('مراجعة العقد مع المورّد');

        // Handed to the design workspace: Hermes's assignee is the design profile.
        const handed = await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${id}/assign`,
          payload: { agent_id: '01KHERMESAGENT000000000000', profile: 'design' },
        });
        expect(handed.statusCode).toBe(202);
        expect((await show(created.id))?.task.assignee).toBe('design');

        // Deleted on Hermes, from the workspace it now lives in.
        const deleted = await authed(hub, hub.token, {
          method: 'DELETE',
          url: `/api/v1/tasks/${id}`,
          profile: 'design',
        });
        expect(deleted.statusCode).toBe(204);
        expect(await show(created.id)).toBeNull();
      } finally {
        await hub.close();
      }
    }, 600_000);
  },
);
