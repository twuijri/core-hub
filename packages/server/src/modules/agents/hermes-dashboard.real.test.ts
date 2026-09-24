/**
 * Hermes's dashboard API (ADR 0015) with **the real Hermes** from the image: the service
 * starts `hermes serve` from the image against a throwaway home, edits a card the kanban
 * CLI created — its title and body in Arabic, its priority — and the CLI reads the edit
 * back. A refusal comes back in Hermes's words, a call without the token is refused, and
 * a stopped server starts again on the next call. Name the image to run it; without one it
 * is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hermes-dashboard.real.test.ts
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import {
  HermesDashboard,
  HermesDashboardRefusal,
  type DashboardSpawner,
} from './hermes-dashboard.js';
import type { SpawnedProcess } from './hermes-runtime.js';

const image = process.env.COREHUB_HERMES_IMAGE;

interface KanbanTask {
  id: string;
  title: string;
  body: string | null;
  priority: number;
}

describe.skipIf(!image)(
  'Hermes dashboard API (real Hermes; set COREHUB_HERMES_IMAGE to run)',
  () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-dash-home-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-dash-data-'));
    // The container's user is not ours; the throwaway home must be writable by it.
    chmodSync(home, 0o777);
    const containers: string[] = [];

    /**
     * `hermes serve` inside the image, on the host's network so the port Hermes announces is
     * reachable here. The token goes by name (`-e NAME`), so it is in no command line.
     */
    const spawnImpl: DashboardSpawner = (_command, args, options) => {
      const name = `corehub-dash-real-${process.pid}-${containers.length}`;
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
          '/opt/hermes/.venv/bin/hermes',
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

    const kanban = (argv: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
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
            '/opt/hermes/.venv/bin/hermes',
            image!,
            'kanban',
            ...argv,
          ],
          { timeout: 120_000 },
          (error, stdout, stderr) =>
            error
              ? reject(new Error(`${String(stderr)}\n${error.message}`))
              : resolve(String(stdout)),
        );
      });

    const { logger, lines } = capturingLogger();
    const dashboard = new HermesDashboard({
      host: {
        status: () => ({ mode: 'managed', home }),
        executable: () => '/opt/hermes/.venv/bin/hermes',
        cliEnv: () => ({}),
      },
      dataDir,
      log: logger,
      spawnImpl,
      startTimeoutMs: 120_000,
    });

    afterAll(async () => {
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

    it('edits a card the CLI created, and the CLI reads the edit back', async () => {
      const created = JSON.parse(
        await kanban(['create', 'Draft card', '--body', 'old body', '--json']),
      ) as KanbanTask;
      expect(created.id).toBeTruthy();

      const began = Date.now();
      const patched = await dashboard.request<{ task: KanbanTask }>(
        'PATCH',
        `/api/plugins/kanban/tasks/${created.id}`,
        { title: 'مراجعة العقد مع المورّد', body: 'الوصف الجديد بالعربية', priority: 3 },
      );
      const firstCallMs = Date.now() - began;
      expect(patched.task).toMatchObject({
        id: created.id,
        title: 'مراجعة العقد مع المورّد',
        body: 'الوصف الجديد بالعربية',
        priority: 3,
      });

      const shown = JSON.parse(await kanban(['show', created.id, '--json'])) as {
        task?: KanbanTask;
      } & KanbanTask;
      const task = shown.task ?? shown;
      expect(task.title).toBe('مراجعة العقد مع المورّد');
      expect(task.body).toBe('الوصف الجديد بالعربية');
      expect(task.priority).toBe(3);

      await expect(
        dashboard.request('POST', `/api/plugins/kanban/tasks/${created.id}/comments`, {
          body: 'تعليق من المركز',
          author: 'corehub',
        }),
      ).resolves.toEqual({ ok: true });

      // Hermes's own sentence, verbatim, for a transition it does not know.
      const refusal = await dashboard
        .request('PATCH', `/api/plugins/kanban/tasks/${created.id}`, { status: 'bogus' })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(HermesDashboardRefusal);
      expect((refusal as HermesDashboardRefusal).status).toBe(400);
      expect((refusal as HermesDashboardRefusal).message).toBe('unknown status: bogus');

      // Without the token, Hermes refuses even on the loopback.
      const port = dashboard.status().port!;
      const bare = await fetch(`http://127.0.0.1:${port}/api/plugins/kanban/board`);
      expect(bare.status).toBe(401);

      const memory = execFileSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.MemUsage}}', containers[0]!],
        { encoding: 'utf8' },
      ).trim();
      console.log(`hermes serve: first call (start + PATCH) ${firstCallMs} ms, memory ${memory}`);
    }, 300_000);

    it('starts again on the next call after it was stopped', async () => {
      await dashboard.stop('test');
      expect(dashboard.status().running).toBe(false);
      const began = Date.now();
      const board = await dashboard.request<{ columns: Array<{ name: string }> }>(
        'GET',
        '/api/plugins/kanban/board',
      );
      console.log(`hermes serve: restart + GET board ${Date.now() - began} ms`);
      expect(board.columns.map((column) => column.name)).toContain('todo');
      expect(dashboard.status()).toMatchObject({ running: true, starts: 2 });
      expect(lines.filter((line) => line.msg === 'hermes: dashboard API started')).toHaveLength(2);
    }, 300_000);
  },
);
