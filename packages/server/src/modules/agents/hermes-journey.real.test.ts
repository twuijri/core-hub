/**
 * The Journey with **the real Hermes** from the image: `hermes serve` runs against a throwaway
 * home whose `work` profile has skills, Hermes's usage file and memories, and the hub's
 * `readJourney` reads the graph through Hermes's own server, in that profile and in the root.
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hermes-journey.real.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import { HermesDashboard, type DashboardSpawner } from './hermes-dashboard.js';
import { readJourney } from './hermes-journey.js';
import type { SpawnedProcess } from './hermes-runtime.js';
import type { HermesApiCall } from './hermes-tools.js';

const image = process.env.COREHUB_HERMES_IMAGE;

function skill(home: string, category: string, name: string, extra = ''): void {
  const dir = path.join(home, 'skills', category, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n\nSteps.\n`,
  );
}

describe.skipIf(!image)('Journey (real Hermes; set COREHUB_HERMES_IMAGE to run)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-journey-home-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-journey-data-'));
  const containers: string[] = [];

  const work = path.join(home, 'profiles', 'work');
  skill(work, 'research', 'web-research', 'related_skills: [summarize-pdf]\n');
  skill(work, 'research', 'summarize-pdf');
  skill(work, 'misc', 'never-used');
  writeFileSync(
    path.join(work, 'skills', '.usage.json'),
    JSON.stringify({
      'web-research': { use_count: 12, last_used_at: '2026-09-20T10:00:00Z', pinned: true },
      'summarize-pdf': { created_by: 'agent', use_count: 0 },
    }),
  );
  mkdirSync(path.join(work, 'memories'), { recursive: true });
  writeFileSync(
    path.join(work, 'memories', 'MEMORY.md'),
    'The person likes web research summaries\n§\nيفضّل الشخص الردود القصيرة بالعربية\n',
  );
  writeFileSync(path.join(work, 'memories', 'USER.md'), 'Name: Test Owner\n');
  execFileSync('chmod', ['-R', 'a+rwX', home]);
  chmodSync(home, 0o777);

  const spawnImpl: DashboardSpawner = (_command, args, options) => {
    const name = `corehub-journey-real-${process.pid}-${containers.length}`;
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

  const { logger } = capturingLogger();
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
  const api: HermesApiCall = (method, route, body, options) =>
    dashboard.request(method, route, body, options);

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

  it("reads the profile's learned skills and memories the way Hermes draws them", async () => {
    const journey = await readJourney(api, 'work');
    const byId = new Map(journey.nodes.map((node) => [node.id, node]));

    // Only what the agent wrote or used: `never-used` is not a node.
    expect([...byId.keys()].sort()).toEqual([
      'memory:memory:0',
      'memory:memory:1',
      'memory:profile:2',
      'summarize-pdf',
      'web-research',
    ]);
    expect(byId.get('web-research')).toMatchObject({
      kind: 'skill',
      category: 'research',
      use_count: 12,
      pinned: true,
      agent_created: false,
      memory_source: null,
      learned_at: '2026-09-20T10:00:00Z',
    });
    expect(byId.get('summarize-pdf')).toMatchObject({ agent_created: true, use_count: 0 });
    expect(byId.get('memory:memory:1')).toMatchObject({
      kind: 'memory',
      label: 'يفضّل الشخص الردود القصيرة بالعربية',
      memory_source: 'memory',
    });
    expect(byId.get('memory:profile:2')).toMatchObject({ memory_source: 'user' });
    for (const node of journey.nodes) expect(node.learned_at).toMatch(/Z$/);

    expect(journey.edges).toContainEqual({ source: 'summarize-pdf', target: 'web-research' });
    // Hermes links a memory to skills by Latin words only: the English one links, the Arabic
    // one does not.
    expect(journey.edges.some((edge) => edge.source === 'memory:memory:0')).toBe(true);
    expect(journey.edges.some((edge) => edge.source === 'memory:memory:1')).toBe(false);
    expect(journey.clusters).toEqual([
      { category: 'memory', count: 3 },
      { category: 'research', count: 2 },
    ]);
  }, 300_000);

  it('the root profile has its own, empty, journey', async () => {
    const journey = await readJourney(api, 'default');
    expect(journey).toEqual({ nodes: [], edges: [], clusters: [] });
  }, 120_000);
});
