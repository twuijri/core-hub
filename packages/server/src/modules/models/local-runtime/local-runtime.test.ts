/**
 * Local models (ADR 0032) without the network: the pieces that decide what is downloaded, the
 * zip read by ranges, and the service against a scripted Ollama.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobHandle, JobRow, JobRunner, JobWorker, NewJob } from '../../audit/index.js';
import { cudaFolderFor, detectGpu } from './gpu.js';
import { skippedForGpu } from './ollama-install.js';
import {
  assetFor,
  compareVersions,
  latestOllamaRelease,
  parseChecksums,
  runtimePlatform,
} from './ollama-release.js';
import { extractRemoteEntry, openRemoteZip, safeTarget } from './remote-zip.js';
import { LocalRuntimeService } from './service.js';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-local-runtime-'));
  dirs.push(dir);
  return dir;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/** A zip of `files`, deflated, as a byte buffer — enough of the format for the reader. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Serves `body` honouring `Range`, and counts the bytes it sent. */
async function rangeServer(body: Buffer): Promise<{ url: string; sent: () => number }> {
  let sent = 0;
  const url = await listen(
    createServer((request, response) => {
      const match = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? '');
      if (!match) {
        response.writeHead(200, { 'content-length': body.length });
        sent += body.length;
        response.end(body);
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), body.length - 1);
      const slice = body.subarray(start, end + 1);
      sent += slice.length;
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': slice.length,
      });
      response.end(slice);
    }),
  );
  return { url: `${url}/ollama-windows-amd64.zip`, sent: () => sent };
}

function inlineJobs(): { runner: JobRunner; done: Map<string, Promise<unknown>> } {
  const done = new Map<string, Promise<unknown>>();
  let next = 0;
  return {
    done,
    runner: {
      start(_job: NewJob, work: JobWorker): JobRow {
        next += 1;
        const id = `job-${next}`;
        const handle: JobHandle = { id, progress: () => undefined, cancelRequested: () => false };
        done.set(id, work(handle));
        return { id } as JobRow;
      },
      cancel: () => null,
      drain: async () => undefined,
    },
  };
}

describe('what is downloaded', () => {
  it('keeps only the CUDA folder the driver runs, and every other folder', () => {
    expect(skippedForGpu('lib/ollama/cuda_v12/ggml-cuda.dll', 'cuda_v13')).toBe(true);
    expect(skippedForGpu('lib/ollama/cuda_v13/ggml-cuda.dll', 'cuda_v13')).toBe(false);
    expect(skippedForGpu('./lib/ollama/rocm/libggml-hip.so', null)).toBe(true);
    expect(skippedForGpu('lib/ollama/cuda_v13/', null)).toBe(true);
    expect(skippedForGpu('lib/ollama/vulkan/ggml-vulkan.dll', null)).toBe(false);
    expect(skippedForGpu('lib/ollama/ggml-base.dll', null)).toBe(false);
    expect(skippedForGpu('ollama.exe', null)).toBe(false);
  });

  it('picks CUDA 13 from the r580 driver on, CUDA 12 before it', () => {
    expect(cudaFolderFor('581.15')).toBe('cuda_v13');
    expect(cudaFolderFor('580.65.06')).toBe('cuda_v13');
    expect(cudaFolderFor('550.120')).toBe('cuda_v12');
    expect(cudaFolderFor(null)).toBeNull();
    expect(cudaFolderFor('unknown')).toBeNull();
  });

  it('names the card from Linux display devices, preferring a discrete one', async () => {
    const root = tempDir();
    for (const [card, vendor] of [
      ['card0', '0x8086'],
      ['card1', '0x1002'],
    ]) {
      const device = path.join(root, card!, 'device');
      await import('node:fs/promises').then((fs) => fs.mkdir(device, { recursive: true }));
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(path.join(device, 'vendor'), `${vendor}\n`),
      );
    }
    const reading = await detectGpu({
      host: { pathValue: '' },
      platform: 'linux',
      arch: 'x64',
      drmRoot: root,
    });
    expect(reading).toMatchObject({ vendor: 'amd', cuda: null });
    const mac = await detectGpu({ host: { pathValue: '' }, platform: 'darwin', arch: 'arm64' });
    expect(mac.vendor).toBe('apple');
  });

  it('maps every platform Ollama publishes for, and nothing else', () => {
    expect(runtimePlatform('win32', 'x64')).toBe('win32-x64');
    expect(runtimePlatform('linux', 'arm64')).toBe('linux-arm64');
    expect(runtimePlatform('freebsd', 'x64')).toBeNull();
    expect(assetFor('linux-x64')).toEqual({
      name: 'ollama-linux-amd64.tar.zst',
      format: 'tar.zst',
    });
    expect(assetFor('darwin-arm64').format).toBe('tgz');
  });

  it('reads the release checksums and compares versions by number', () => {
    const sums = parseChecksums(
      `${'a'.repeat(64)}  ./ollama-darwin.tgz\n${'B'.repeat(64)}  ollama-windows-amd64.zip\nnoise\n`,
    );
    expect(sums.get('ollama-darwin.tgz')).toBe('a'.repeat(64));
    expect(sums.get('ollama-windows-amd64.zip')).toBe('b'.repeat(64));
    expect(compareVersions('0.40.13', '0.40.9')).toBe(1);
    expect(compareVersions('v0.40.13', '0.40.13')).toBe(0);
    expect(compareVersions('0.39.2', '0.40.0')).toBe(-1);
  });

  it('learns the newest release from the redirect, not the API', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/ollama/ollama/releases/tag/v0.40.13' },
      })) as unknown as typeof fetch;
    expect(await latestOllamaRelease(fetchImpl)).toEqual({ tag: 'v0.40.13', version: '0.40.13' });
  });
});

describe('a zip read by ranges', () => {
  it('fetches the index and only the entries asked for, checked against the index', async () => {
    // Random bytes do not compress, so the skipped entry is most of the zip.
    const big = randomBytes(200_000).toString('base64');
    const zip = zipOf({
      'ollama.exe': 'program',
      'lib/ollama/vulkan/ggml-vulkan.dll': 'vulkan',
      'lib/ollama/cuda_v13/ggml-cuda.dll': big,
    });
    const server = await rangeServer(zip);
    const remote = await openRemoteZip(fetch, server.url);
    expect(remote.entries.map((entry) => entry.name)).toEqual([
      'ollama.exe',
      'lib/ollama/vulkan/ggml-vulkan.dll',
      'lib/ollama/cuda_v13/ggml-cuda.dll',
    ]);
    const dest = tempDir();
    for (const entry of remote.entries.filter((item) => !skippedForGpu(item.name, null))) {
      await extractRemoteEntry(fetch, remote, entry, dest, () => undefined, 10_000);
    }
    expect(readFileSync(path.join(dest, 'ollama.exe'), 'utf8')).toBe('program');
    expect(readFileSync(path.join(dest, 'lib/ollama/vulkan/ggml-vulkan.dll'), 'utf8')).toBe(
      'vulkan',
    );
    // The CUDA entry never crossed the wire: far fewer bytes than the zip holds.
    expect(server.sent()).toBeLessThan(zip.length / 2);
  });

  it('refuses an entry whose bytes do not match its record', async () => {
    const zip = zipOf({ 'ollama.exe': 'program' });
    const server = await rangeServer(zip);
    const remote = await openRemoteZip(fetch, server.url);
    const entry = { ...remote.entries[0]!, crc32: 1234 };
    await expect(
      extractRemoteEntry(fetch, remote, entry, tempDir(), () => undefined, 10_000),
    ).rejects.toMatchObject({ details: { reason: 'checksum_mismatch' } });
  });

  it('never writes outside the install folder', () => {
    expect(safeTarget('/data/app', '../evil')).toBeNull();
    expect(safeTarget('/data/app', '/etc/passwd')).toBeNull();
    expect(safeTarget('/data/app', 'C:/Windows/x')).toBeNull();
    expect(safeTarget('/data/app', 'lib/ollama/x.dll')).toBe(
      path.resolve('/data/app/lib/ollama/x.dll'),
    );
  });
});

/** A scripted Ollama: version, tags, ps, pull (streamed), delete. */
async function fakeOllama(): Promise<{ url: string; models: Set<string> }> {
  const models = new Set<string>(['llama3.2:3b']);
  const url = await listen(
    createServer((request, response) => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
        if (request.url === '/api/version') return send(200, { version: '0.40.9' });
        if (request.url === '/api/tags') {
          return send(200, {
            models: [...models].map((name) => ({
              name,
              size: 2_000_000_000,
              modified_at: '2026-10-30T10:00:00Z',
              details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
            })),
          });
        }
        if (request.url === '/api/ps') return send(200, { models: [] });
        if (request.url === '/api/pull') {
          if (body.model === 'nope:1b') {
            response.writeHead(200, { 'content-type': 'application/x-ndjson' });
            response.end(
              `${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`,
            );
            return;
          }
          response.writeHead(200, { 'content-type': 'application/x-ndjson' });
          response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
          response.write(
            `${JSON.stringify({ status: 'pulling abc', total: 100, completed: 50 })}\n`,
          );
          models.add(body.model ?? '');
          response.end(`${JSON.stringify({ status: 'success' })}\n`);
          return;
        }
        if (request.url === '/api/delete') {
          if (!models.delete(body.model ?? '')) return send(404, { error: 'model not found' });
          return send(200, {});
        }
        send(404, { error: 'not found' });
      });
    }),
  );
  return { url, models };
}

function service(options: Partial<ConstructorParameters<typeof LocalRuntimeService>[0]> = {}) {
  const jobs = inlineJobs();
  const addresses: string[] = [];
  let changed = 0;
  // GitHub is unreachable in unit tests: every release question answers "unknown".
  const offline = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const runtime = new LocalRuntimeService({
    available: true,
    dataDir: tempDir(),
    host: { pathValue: '' },
    env: {},
    log: pino({ level: 'silent' }),
    jobs: jobs.runner,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async (input, init) => {
      const url = String(input);
      return url.startsWith('http://127.0.0.1') ? fetch(input, init) : offline(input, init);
    },
    onAddress: async (url) => {
      addresses.push(url);
    },
    onModelsChanged: () => {
      changed += 1;
    },
    ...options,
  });
  return { runtime, jobs, addresses, changed: () => changed };
}

describe('the local runtime service', () => {
  it('reports itself unavailable outside the desktop app and refuses every action', async () => {
    const { runtime } = service({ available: false });
    expect(await runtime.view()).toMatchObject({ available: false, mode: 'none' });
    await expect(runtime.models()).rejects.toMatchObject({
      details: { reason: 'local_runtime_unavailable' },
    });
    expect(() => runtime.installOrUpdate({ workspace: 'w', userId: 'u' }, 'install')).toThrow();
  });

  it('manages the models of an Ollama already on the computer, never the program', async () => {
    const ollama = await fakeOllama();
    const { runtime, jobs, addresses, changed } = service({ externalUrl: ollama.url });
    const view = await runtime.view();
    expect(view).toMatchObject({
      mode: 'external',
      state: 'running',
      version: '0.40.9',
      base_url: ollama.url,
    });

    await runtime.boot();
    expect(addresses).toEqual([ollama.url]);

    const models = await runtime.models();
    expect(models.installed.map((model) => model.name)).toEqual(['llama3.2:3b']);
    expect(models.suggested.find((model) => model.name === 'llama3.2:3b')?.installed).toBe(true);

    const pull = runtime.pull({ workspace: 'w', userId: 'u' }, 'qwen3:4b');
    await jobs.done.get(pull.id);
    expect(ollama.models.has('qwen3:4b')).toBe(true);
    expect(changed()).toBe(1);

    const failed = runtime.pull({ workspace: 'w', userId: 'u' }, 'nope:1b');
    await expect(jobs.done.get(failed.id)).rejects.toThrow(/file does not exist/);

    await runtime.deleteModel('qwen3:4b');
    expect(ollama.models.has('qwen3:4b')).toBe(false);
    await expect(runtime.deleteModel('qwen3:4b')).rejects.toMatchObject({ code: 'not_found' });

    for (const action of [
      () => runtime.stop(),
      () => runtime.start(),
      () => runtime.remove(true),
    ]) {
      await expect(action()).rejects.toMatchObject({
        details: { reason: 'local_runtime_not_managed' },
      });
    }
  });

  it('refuses a model name that is not one', () => {
    const { runtime } = service();
    expect(() => runtime.pull({ workspace: 'w', userId: 'u' }, 'rm -rf /')).toThrow();
  });

  it('says Ollama is absent, and that its models need it running', async () => {
    const { runtime } = service({ externalUrl: 'http://127.0.0.1:9' });
    expect(await runtime.view()).toMatchObject({
      mode: 'none',
      state: 'stopped',
      latest_version: null,
    });
    await expect(runtime.models()).rejects.toMatchObject({
      details: { reason: 'local_runtime_stopped' },
    });
  });
});
