/**
 * Profile export and import with **the real Hermes** from the image (ADR 0014 stage 2):
 * a profile Hermes made, with a SOUL and a memory of its own and a `.env` holding a key the
 * hub also stores, is exported through the hub's route — Hermes's own `hermes serve` writes
 * the archive (ADR 0015) — downloaded, uploaded again and imported under a new name, and
 * Hermes's new profile holds the same SOUL and memory. The key is in neither the archive
 * nor the new profile. A name Hermes already has comes back refused in Hermes's words.
 *
 * Hermes runs in the container as this user, with the home and the hub's data directory
 * mounted at the same paths, because the dashboard API exchanges paths, not bytes. Name the
 * image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=corehub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/auth/profile-transfer.real.test.ts
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { authed, capturingLogger, drainJobs, signedInHub } from '../../../tests/unit/helpers.js';
import { requireSqlite } from '../../lib/db.js';
import { HermesDashboard, type DashboardSpawner, type SpawnedProcess } from '../agents/index.js';
import { hermesArchivesOver, profileTransferPorts } from '../index.js';
import { DataKeyRing, SecretStore } from '../models/index.js';
import { registerProfileTransfer } from './index.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const KEY = 'sk-proj-real-hermes-export-0123456789';
const SOUL = 'I am Nakhla, the designer who only draws palm trees. أنا نخلة.\n';
const MEMORY = 'The owner prefers teal. المالك يفضّل اللون الأزرق المخضر.\n';

type Json = Record<string, unknown>;

describe.skipIf(!image)('profile export and import (real Hermes; set COREHUB_HERMES_IMAGE)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-transfer-home-'));
  const scratch = mkdtempSync(path.join(tmpdir(), 'corehub-transfer-scratch-'));
  const user = `${userInfo().uid}:${userInfo().gid}`;
  const containers: string[] = [];
  /** The hub's data directory, known once the hub exists; Hermes writes archives into it. */
  let dataDir = '';

  const mounts = () => [
    '-v',
    `${home}:${home}`,
    ...(dataDir ? ['-v', `${dataDir}:${dataDir}`] : []),
    '-e',
    `HERMES_HOME=${home}`,
    '-e',
    'HOME=/tmp',
    '--user',
    user,
  ];

  const hermes = (argv: readonly string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        'docker',
        ['run', '--rm', ...mounts(), '--entrypoint', HERMES, image!, ...argv],
        { timeout: 120_000 },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });

  const spawnImpl: DashboardSpawner = (_command, args, options) => {
    const name = `corehub-transfer-real-${process.pid}-${containers.length}`;
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
        ...mounts(),
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
    dataDir: scratch,
    log: capturingLogger().logger,
    spawnImpl,
    startTimeoutMs: 120_000,
  });
  const previous = registerProfileTransfer((app) =>
    profileTransferPorts(app, hermesArchivesOver(dashboard)),
  );

  afterAll(async () => {
    registerProfileTransfer(previous);
    await dashboard.close();
    for (const name of containers) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // already gone with --rm
      }
    }
    for (const dir of [home, scratch]) rmSync(dir, { recursive: true, force: true });
  });

  it('exports a profile with its SOUL and memory, and imports it under a new name', async () => {
    // A profile of Hermes's own, with a SOUL and a memory nobody else has, and a key in its
    // `.env` that the hub also stores (as the Models screen would).
    expect((await hermes(['profile', 'create', 'design', '--no-alias'])).code).toBe(0);
    const design = path.join(home, 'profiles', 'design');
    writeFileSync(path.join(design, 'SOUL.md'), SOUL);
    mkdirSync(path.join(design, 'memories'), { recursive: true });
    writeFileSync(path.join(design, 'memories', 'MEMORY.md'), MEMORY);
    writeFileSync(path.join(design, '.env'), `OPENAI_API_KEY=${KEY}\n`);
    // A name Hermes already has, for the refusal below.
    expect((await hermes(['profile', 'create', 'taken', '--no-alias'])).code).toBe(0);

    const hub = await signedInHub();
    dataDir = hub.app.hub.config.dataDir;
    try {
      const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
        const res = await authed(hub, hub.token, { method, url, ...(payload ? { payload } : {}) });
        return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
      };
      const finished = async (jobId: string) => {
        await drainJobs(hub.app);
        return (await call('GET', `/api/v1/jobs/${jobId}`)).body;
      };
      const workspaces = async () =>
        ((await call('GET', '/api/v1/profiles')).body.items as Json[]).map((p) => p.slug);
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/auth/me',
        payload: { locale: 'en' },
      });
      const def = ((await call('GET', '/api/v1/profiles')).body.items as Json[])[0]!;
      new SecretStore({
        db: requireSqlite(hub.app.hub.database),
        keys: DataKeyRing.open(dataDir),
      }).put({ workspace: def.id as string, ownerId: hub.userId }, 'openai', KEY);
      const created = await call('POST', '/api/v1/profiles', { slug: 'design', name: 'Design' });
      expect(created.status).toBe(201);

      // Export: Hermes writes its archive, the hub checks it and keeps it for download.
      const began = Date.now();
      const exported = await call('POST', `/api/v1/profiles/${String(created.body.id)}/export`);
      expect(exported.status).toBe(202);
      const exportJob = await finished(exported.body.job_id as string);
      console.log(`export job: ${Date.now() - began} ms`, JSON.stringify(exportJob.result));
      expect(exportJob, JSON.stringify(exportJob.error)).toMatchObject({
        status: 'succeeded',
        kind: 'export',
      });
      const result = exportJob.result as Json;
      const download = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/attachments/${String(result.attachment_id)}/content`,
      });
      expect(download.statusCode).toBe(200);
      const bytes = download.rawPayload;
      expect(bytes.includes(Buffer.from(KEY))).toBe(false);
      const archive = path.join(scratch, String(result.name));
      writeFileSync(archive, bytes);
      const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      expect(listing).toContain('design/SOUL.md');
      expect(listing).toContain('design/memories/MEMORY.md');
      expect(listing.some((entry) => entry.endsWith('.env'))).toBe(false);
      const unpacked = mkdtempSync(path.join(scratch, 'x-'));
      execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
      expect(readFileSync(path.join(unpacked, 'design/SOUL.md'), 'utf8')).toBe(SOUL);
      expect(readFileSync(path.join(unpacked, 'design/memories/MEMORY.md'), 'utf8')).toBe(MEMORY);
      // Nothing is left in the job's working folder.
      expect(readdirSync(path.join(dataDir, 'tmp', 'profile-transfer'))).toEqual([]);

      // The default profile is Hermes's root home: Hermes exports only its known files
      // (never `profiles/`, `state.db` or `.env`), under a folder named `default`.
      writeFileSync(path.join(home, 'SOUL.md'), 'The root home.\n');
      writeFileSync(path.join(home, '.env'), `OPENAI_API_KEY=${KEY}\n`);
      const rootJob = await finished(
        (await call('POST', `/api/v1/profiles/${String(def.id)}/export`)).body.job_id as string,
      );
      expect(rootJob, JSON.stringify(rootJob.error)).toMatchObject({ status: 'succeeded' });
      const root = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/attachments/${String((rootJob.result as Json).attachment_id)}/content`,
      });
      const rootArchive = path.join(scratch, 'root.tar.gz');
      writeFileSync(rootArchive, root.rawPayload);
      const rootListing = execFileSync('tar', ['-tzf', rootArchive], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      expect(rootListing).toContain('default/SOUL.md');
      expect(
        rootListing.some((entry) => /(^|\/)(\.env|profiles|state\.db)(\/|$)/.test(entry)),
      ).toBe(false);
      expect(root.rawPayload.includes(Buffer.from(KEY))).toBe(false);

      // Import the same archive under a new name.
      const upload = async () => {
        const boundary = '----corehubRealTransfer';
        const payload = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(result.name)}"\r\n` +
              'Content-Type: application/gzip\r\n\r\n',
          ),
          bytes,
          Buffer.from(
            `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nimport\r\n--${boundary}--\r\n`,
          ),
        ]);
        const res = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/attachments',
          payload,
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(res.statusCode).toBe(201);
        return (res.json() as { id: string }).id;
      };
      const imported = await call('POST', '/api/v1/profile-imports', {
        attachment_id: await upload(),
        slug: 'design-copy',
        name: 'نسخة المصمم',
      });
      expect(imported.status).toBe(202);
      const importJob = await finished(imported.body.job_id as string);
      expect(importJob, JSON.stringify(importJob.error)).toMatchObject({
        status: 'succeeded',
        result: { slug: 'design-copy', name: 'نسخة المصمم' },
      });
      const copy = path.join(home, 'profiles', 'design-copy');
      expect(readFileSync(path.join(copy, 'SOUL.md'), 'utf8')).toBe(SOUL);
      expect(readFileSync(path.join(copy, 'memories', 'MEMORY.md'), 'utf8')).toBe(MEMORY);
      expect(existsSync(path.join(copy, '.env'))).toBe(false);
      expect(await workspaces()).toContain('design-copy');

      // A name Hermes already has (and the hub does not): Hermes says no, in its words.
      const refused = await call('POST', '/api/v1/profile-imports', {
        attachment_id: await upload(),
        slug: 'taken',
      });
      const refusedJob = await finished(refused.body.job_id as string);
      expect(refusedJob.status).toBe('failed');
      expect((refusedJob.error as { code: string; error: string }).code).toBe('conflict');
      expect((refusedJob.error as { error: string }).error).toMatch(
        /^Hermes refused to import the archive: .*taken.*already exists/,
      );
      expect(await workspaces()).not.toContain('taken');
    } finally {
      await hub.close();
    }
  }, 600_000);
});
