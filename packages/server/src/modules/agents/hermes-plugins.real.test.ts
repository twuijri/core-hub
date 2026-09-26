/**
 * The Plugins page and the category skills against **the real Hermes** from the image:
 *
 * - `hermes plugins …`, run the way the hub runs it (`hermes-plugins.ts`) against a profile's
 *   home, lists what Hermes ships (`disk-cleanup` among them; its kanban is a dashboard page,
 *   not an agent plugin) with Hermes's own status; switching
 *   one on in a named profile leaves the default profile's lists alone; a plugin installed from a
 *   local Git repository arrives switched off, `user`, removable, and is removed again; what
 *   Hermes ships is never removed.
 * - A profile Hermes makes (`hermes profile create`) holds Hermes's built-in skills in category
 *   folders; the hub lists every one of them with its category, marks exactly the ones Hermes
 *   calls bundled as `builtin`, and agrees with Hermes's own `/api/skills` (ADR 0015) skill by
 *   skill.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=corehub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hermes-plugins.real.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import type { JobHandle } from '../audit/index.js';
import { HermesDashboard, type DashboardSpawner } from './hermes-dashboard.js';
import type { SpawnedProcess } from './hermes-runtime.js';
import {
  installPlugin,
  listPlugins,
  removePlugin,
  setPluginEnabled,
  type HermesCli,
} from './hermes-plugins.js';
import { getSkill, listSkills, setSkillEnabled } from './skills.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';

describe.skipIf(!image)(
  'plugins and category skills (real Hermes; set COREHUB_HERMES_IMAGE)',
  () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-plugins-home-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-plugins-data-'));
    chmodSync(home, 0o777);
    const containers: string[] = [];
    const { uid, gid } = userInfo();
    /** The host path of a home, as the container sees it. */
    const inside = (hostPath: string) => `/hh${hostPath.slice(home.length)}`;

    const dockerArgs = (name: string, hermesHome: string) => [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'host',
      '--user',
      `${uid}:${gid}`,
      '-v',
      `${home}:/hh`,
      '-e',
      `HERMES_HOME=${hermesHome}`,
      '-e',
      'HOME=/tmp',
      '-e',
      'COLUMNS=1000',
      '-e',
      'NO_COLOR=1',
    ];

    /** The hub's `HermesCli`, with `hermes` inside the image instead of beside the hub. */
    const cli: HermesCli = (hermesHome, argv, options) =>
      new Promise((resolve) => {
        const name = `corehub-plugins-real-${process.pid}-${containers.length}`;
        containers.push(name);
        const child = spawn(
          'docker',
          [...dockerArgs(name, inside(hermesHome)), '--entrypoint', HERMES, image!, ...argv],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        const timer = setTimeout(() => child.kill('SIGKILL'), options?.timeoutMs ?? 120_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });

    /** `hermes serve` in the image, for Hermes's own `/api/skills`. */
    const spawnImpl: DashboardSpawner = (_command, args, options) => {
      const name = `corehub-plugins-serve-${process.pid}-${containers.length}`;
      containers.push(name);
      const child = spawn(
        'docker',
        [
          ...dockerArgs(name, '/hh'),
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
    const { logger } = capturingLogger();
    const dashboard = new HermesDashboard({
      host: {
        status: () => ({ mode: 'managed', home }),
        executable: () => HERMES,
        cliEnv: () => ({}),
      },
      dataDir,
      log: logger,
      spawnImpl,
      startTimeoutMs: 120_000,
    });

    const work = path.join(home, 'profiles', 'work');

    afterAll(async () => {
      await dashboard.close();
      for (const name of containers) {
        try {
          execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
        } catch {
          // already gone with --rm
        }
      }
      for (const dir of [home, dataDir]) rmSync(dir, { recursive: true, force: true });
    });

    it('Hermes makes a profile, with its built-in skills in category folders', async () => {
      const made = await cli(home, ['profile', 'create', 'work', '--no-alias'], {
        timeoutMs: 180_000,
      });
      expect(made.code, `${made.stdout}\n${made.stderr}`).toBe(0);
    }, 240_000);

    it("lists Hermes's category skills as Hermes does: every one, its category, bundled or not", async () => {
      const ours = listSkills(work);
      console.log(
        `category skills: ${ours.length} listed, ${ours.filter((s) => s.category).length} in categories, ${ours.filter((s) => s.bundled).length} built-in`,
      );
      expect(ours.filter((skill) => skill.category !== null).length).toBeGreaterThan(10);

      const theirs = await dashboard.request<
        Array<{ name: string; category: string | null; provenance: string }>
      >('GET', '/api/skills?profile=work', undefined, { timeoutMs: 120_000 });
      const byName = new Map(ours.map((skill) => [skill.name, skill]));
      const missing: string[] = [];
      for (const skill of theirs) {
        const mine = byName.get(skill.name);
        if (!mine) {
          missing.push(skill.name);
          continue;
        }
        expect(mine.category, skill.name).toBe(skill.category ?? null);
        expect(mine.bundled, skill.name).toBe(skill.provenance === 'bundled');
      }
      expect(missing).toEqual([]);
      // And nothing Hermes would not list: skills for another system are left out, as Hermes
      // leaves them out (§102). The one difference is on purpose: a skill Hermes offers only
      // inside one of its own contexts (`environments:`, such as a kanban worker) is still this
      // profile's skill, listed here to be switched, though Hermes's dashboard leaves it out.
      const listed = new Set(theirs.map((skill) => skill.name));
      const extra = ours.filter((skill) => !listed.has(skill.name));
      console.log(`listed here only: ${extra.map((skill) => skill.name).join(', ')}`);
      for (const skill of extra) {
        expect(getSkill(work, skill.key)?.content ?? '', skill.name).toMatch(/^environments:/m);
      }
      expect(ours.length).toBe(theirs.length + extra.length);
    }, 300_000);

    it('switches a skill where Hermes keeps the switch, both ways (§102)', async () => {
      type Theirs = Array<{ name: string; enabled: boolean; provenance: string }>;
      const theirs = () =>
        dashboard.request<Theirs>('GET', '/api/skills?profile=work', undefined, {
          timeoutMs: 120_000,
        });
      const before = await theirs();
      const [builtIn, other] = before.filter(
        (skill) => skill.provenance === 'bundled' && skill.enabled && skill.name !== 'hermes-agent',
      );
      expect(builtIn && other).toBeTruthy();
      // Off from the hub: Hermes's own list says so, and the skill's files are untouched.
      const key = listSkills(work).find((skill) => skill.name === builtIn!.name)!.key;
      expect(setSkillEnabled(work, key, false).enabled).toBe(false);
      expect((await theirs()).find((skill) => skill.name === builtIn!.name)?.enabled).toBe(false);
      // Off from Hermes's own dashboard: the hub reads it off.
      await dashboard.request(
        'PUT',
        '/api/skills/toggle?profile=work',
        { name: other!.name, enabled: false, profile: 'work' },
        { timeoutMs: 120_000 },
      );
      expect(listSkills(work).find((skill) => skill.name === other!.name)?.enabled).toBe(false);
      // Back on from the hub, and Hermes agrees again.
      setSkillEnabled(work, key, true);
      const otherKey = listSkills(work).find((skill) => skill.name === other!.name)!.key;
      setSkillEnabled(work, otherKey, true);
      const after = await theirs();
      expect(after.find((skill) => skill.name === builtIn!.name)?.enabled).toBe(true);
      expect(after.find((skill) => skill.name === other!.name)?.enabled).toBe(true);
      // Hermes's manual stays on.
      const manual = listSkills(work).find((skill) => skill.name === 'hermes-agent');
      if (manual) expect(() => setSkillEnabled(work, manual.key, false)).toThrow(/skill_essential/);
    }, 300_000);

    it("lists Hermes's plugins in Hermes's words, and switches one on in one profile only", async () => {
      const root = await listPlugins(cli, home);
      console.log(
        `plugins: ${root.items.map((p) => `${p.name}(${p.source},${p.status})`).join(', ')}`,
      );
      // Hermes's kanban is a dashboard page, not an agent plugin: its list does not name it.
      expect(root.items.some((item) => item.key === 'kanban')).toBe(false);
      // A few names Hermes ships twice, in two categories: listed once, and said so.
      expect(new Set(root.items.map((item) => item.key)).size).toBe(root.items.length);
      console.log(`warnings: ${root.warnings.join(' | ')}`);
      const cleanup = root.items.find((item) => item.key === 'disk-cleanup');
      expect(cleanup).toMatchObject({ source: 'bundled', removable: false });
      expect(cleanup?.status).not.toBe('enabled');

      const on = await setPluginEnabled(cli, work, 'disk-cleanup', true);
      expect(on).toMatchObject({ key: 'disk-cleanup', status: 'enabled', enabled: true });
      expect(
        (await listPlugins(cli, home)).items.find((i) => i.key === 'disk-cleanup')?.status,
      ).toBe(cleanup?.status);
      const off = await setPluginEnabled(cli, work, 'disk-cleanup', false);
      expect(off.status).toBe('disabled');

      await expect(removePlugin(cli, work, 'disk-cleanup')).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'plugin_bundled' },
      });
    }, 300_000);

    it('installs a plugin from a Git repository switched off, then removes it', async () => {
      const source = path.join(home, 'plugin-src');
      mkdirSync(source, { recursive: true });
      writeFileSync(
        path.join(source, 'plugin.yaml'),
        'name: corehub-probe\nversion: 0.1.0\ndescription: A probe plugin for the hub test\n',
      );
      writeFileSync(path.join(source, '__init__.py'), 'def register(ctx):\n    pass\n');
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', source, ...args], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.invalid',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.invalid',
          },
        });
      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'probe');
      chmodSync(source, 0o777);

      const progress: string[] = [];
      const handle: JobHandle = {
        id: 'job',
        progress: (_percent, message) => void (message && progress.push(message)),
        cancelRequested: () => false,
      };
      const result = await installPlugin(cli, handle, {
        home: work,
        identifier: `file://${inside(source)}`,
        language: 'en',
      });
      console.log(`install output:\n${String(result.output)}`);
      expect(result.name).toBe('corehub-probe');
      const listed = (await listPlugins(cli, work)).items.find((i) => i.key === 'corehub-probe');
      expect(listed).toMatchObject({ source: 'user', status: 'not_enabled', removable: true });
      // Installed into the profile, not into the default one.
      expect((await listPlugins(cli, home)).items.some((i) => i.key === 'corehub-probe')).toBe(
        false,
      );

      await removePlugin(cli, work, 'corehub-probe');
      expect((await listPlugins(cli, work)).items.some((i) => i.key === 'corehub-probe')).toBe(
        false,
      );
    }, 300_000);

    it("fails an install in Hermes's own words", async () => {
      const handle: JobHandle = { id: 'job', progress: () => {}, cancelRequested: () => false };
      await expect(
        installPlugin(cli, handle, {
          home: work,
          identifier: `file://${inside(path.join(home, 'no-such-repo'))}`,
          language: 'en',
        }),
      ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'hermes_refused' } });
    }, 300_000);
  },
);
