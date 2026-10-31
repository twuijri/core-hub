/**
 * Against the real Ollama releases (ADR 0032), off unless `COREHUB_REAL_OLLAMA=1`:
 *
 * - the Windows plan reads the real zip's index and fetches only what a card needs;
 * - on this computer, the whole round: install the newest Ollama into a folder of its own, run
 *   it, pull a small model, list it, delete it, stop it, remove it.
 *
 * `COREHUB_REAL_OLLAMA_DIR` is where it installs (the Linux download is ~1.5 GB; keep it off a
 * small `/tmp`). Run: `COREHUB_REAL_OLLAMA=1 COREHUB_REAL_OLLAMA_DIR=~/x pnpm vitest run <file>`.
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { JobHandle, JobRow, JobRunner, JobWorker, NewJob } from '../../audit/index.js';
import { planInstall } from './ollama-install.js';
import { latestOllamaRelease } from './ollama-release.js';
import { LocalRuntimeService } from './service.js';

const enabled = process.env.COREHUB_REAL_OLLAMA === '1';
const dir = process.env.COREHUB_REAL_OLLAMA_DIR
  ? path.resolve(process.env.COREHUB_REAL_OLLAMA_DIR.replace(/^~/, os.homedir()))
  : null;

function inlineJobs(log: string[]): { runner: JobRunner; done: Map<string, Promise<unknown>> } {
  const done = new Map<string, Promise<unknown>>();
  let next = 0;
  const runner: JobRunner = {
    start(job: NewJob, work: JobWorker): JobRow {
      next += 1;
      const id = `job-${next}`;
      const handle: JobHandle = {
        id,
        progress: (percent, message) => log.push(`${job.kind} ${percent ?? '-'} ${message ?? ''}`),
        cancelRequested: () => false,
      };
      done.set(id, work(handle));
      return { id } as JobRow;
    },
    cancel: () => null,
    drain: async () => undefined,
  };
  return { runner, done };
}

describe.skipIf(!enabled)('local runtime against the real Ollama', () => {
  it('plans a Windows install that skips the CUDA folders a card does not need', async () => {
    const release = await latestOllamaRelease(fetch);
    const none = await planInstall(fetch, release, 'win32-x64', {
      vendor: 'amd',
      name: null,
      driver: null,
      cuda: null,
    });
    const nvidia = await planInstall(fetch, release, 'win32-x64', {
      vendor: 'nvidia',
      name: null,
      driver: '581.15',
      cuda: 'cuda_v13',
    });
    console.log(
      `Ollama ${release.version} on Windows: ${(none.downloadBytes / 1048576).toFixed(1)} MB without NVIDIA, ` +
        `${(nvidia.downloadBytes / 1048576).toFixed(1)} MB with CUDA 13`,
    );
    expect(none.downloadBytes).toBeLessThan(200 * 1024 * 1024);
    expect(nvidia.downloadBytes).toBeGreaterThan(none.downloadBytes);
    expect(none.zip?.entries.some((entry) => /(^|\/)ollama\.exe$/.test(entry.name))).toBe(true);
    expect(none.zip?.entries.some((entry) => entry.name.includes('/cuda_v'))).toBe(false);
  }, 120_000);

  it.skipIf(!dir)(
    'installs, runs, pulls, deletes, stops and removes on this computer',
    async () => {
      const dataDir = dir!;
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true });
      const log: string[] = [];
      const jobs = inlineJobs(log);
      const addresses: string[] = [];
      const runtime = new LocalRuntimeService({
        available: true,
        dataDir,
        host: { pathValue: process.env.PATH, inherited: process.env },
        env: process.env,
        log: pino({ level: 'warn' }),
        jobs: jobs.runner,
        // Nothing "already on this computer": the hub installs its own.
        externalUrl: 'http://127.0.0.1:9',
        onAddress: async (url) => {
          addresses.push(url);
        },
        onModelsChanged: () => undefined,
      });
      try {
        const before = await runtime.view(true);
        console.log('before', JSON.stringify(before));
        expect(before.mode).toBe('none');

        const install = runtime.installOrUpdate({ workspace: 'w', userId: 'u' }, 'install');
        const started = Date.now();
        await jobs.done.get(install.id);
        console.log(`installed in ${Math.round((Date.now() - started) / 1000)} s`);
        const after = await runtime.view();
        console.log('after', JSON.stringify(after));
        expect(after.mode).toBe('managed');
        expect(after.state).toBe('running');
        expect(addresses.length).toBeGreaterThan(0);

        const pull = runtime.pull({ workspace: 'w', userId: 'u' }, 'smollm2:135m');
        await jobs.done.get(pull.id);
        const models = await runtime.models();
        expect(models.installed.map((model) => model.name)).toContain('smollm2:135m');

        // A chat on it through the OpenAI-compatible endpoint the gateway uses.
        const answer = await fetch(`${after.base_url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'smollm2:135m',
            messages: [{ role: 'user', content: 'Say hi.' }],
          }),
        });
        expect(answer.ok).toBe(true);

        await runtime.deleteModel('smollm2:135m');
        expect((await runtime.models()).installed).toHaveLength(0);

        const stopped = await runtime.stop();
        expect(stopped.state).toBe('stopped');
        await runtime.remove(false);
        expect((await runtime.view()).mode).toBe('none');
      } finally {
        await runtime.close();
        console.log(log.filter((_, i) => i % 20 === 0).join('\n'));
      }
    },
    60 * 60_000,
  );
});
