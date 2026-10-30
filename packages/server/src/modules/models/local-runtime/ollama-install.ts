/**
 * Downloading and unpacking Ollama into the hub's own folder (ADR 0032 §3).
 *
 * - **Mac** (`.tgz`, ~180 MB) and **Linux** (`.tar.zst`, ~1.5 GB): the whole file is fetched,
 *   refused unless its SHA-256 is the one the release publishes, and unpacked by the host's own
 *   `tar`. On Linux the CUDA folders this computer does not need are left out of the unpacking,
 *   so they never reach the disk.
 * - **Windows** (`.zip`): only the entries this computer needs are fetched (`remote-zip.ts`);
 *   without an NVIDIA card that is ~40 MB of the 1.5 GB.
 *
 * Everything lands in a staging folder that replaces `<prefix>` only once complete, so a failed
 * or refused download leaves the previous install exactly as it was.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createZstdDecompress } from 'node:zlib';
import { HubError } from '../../../lib/errors.js';
import { runCommand, whichSync, type HostEnvironment } from '../../agents/adapters/host.js';
import type { GpuReading } from './gpu.js';
import {
  assetFor,
  assetUrl,
  releaseChecksum,
  type OllamaAsset,
  type OllamaRelease,
  type RuntimePlatform,
} from './ollama-release.js';
import { extractRemoteEntry, openRemoteZip, type RemoteZip, type ZipEntry } from './remote-zip.js';

/** The largest single download accepted (the Linux file is ~1.5 GB). */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

/** A folder of `lib/ollama/` that only one family of graphics card uses. */
const GPU_FOLDER = /^(cuda_v\d+|rocm[^/]*|mlx[^/]*)$/i;

/** True when `name` (a path inside the archive) belongs to a GPU folder this computer skips. */
export function skippedForGpu(name: string, keep: string | null): boolean {
  const match = /(?:^|\/)lib\/ollama\/([^/]+)(?:\/|$)/.exec(name.replace(/^\.\//, ''));
  const folder = match?.[1];
  if (!folder || !GPU_FOLDER.test(folder)) return false;
  return folder !== keep;
}

export interface InstallPlan {
  release: OllamaRelease;
  platform: RuntimePlatform;
  asset: OllamaAsset;
  url: string;
  /** The CUDA folder kept, or null for none. */
  keep: string | null;
  /** What will cross the network. */
  downloadBytes: number;
  /** Windows only: the entries to fetch, from the zip's own index. */
  zip?: { remote: RemoteZip; entries: ZipEntry[] };
}

async function remoteSize(fetchImpl: typeof fetch, url: string): Promise<number> {
  const response = await fetchImpl(url, {
    headers: { Range: 'bytes=0-0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new HubError('service_unavailable', {
      message: `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
  await response.body?.cancel().catch(() => undefined);
  const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? NaN);
  if (Number.isFinite(total)) return total;
  const length = Number(response.headers.get('content-length') ?? NaN);
  if (response.ok && Number.isFinite(length)) return length;
  throw new HubError('service_unavailable', {
    message: `${url} did not say how large it is (HTTP ${response.status})`,
  });
}

export async function planInstall(
  fetchImpl: typeof fetch,
  release: OllamaRelease,
  platform: RuntimePlatform,
  gpu: GpuReading,
): Promise<InstallPlan> {
  const asset = assetFor(platform);
  const url = assetUrl(release, asset.name);
  const keep = gpu.cuda;
  if (asset.format === 'zip') {
    const remote = await openRemoteZip(fetchImpl, url);
    const entries = remote.entries.filter((entry) => !skippedForGpu(entry.name, keep));
    const downloadBytes = entries.reduce((sum, entry) => sum + entry.compressedSize, 0);
    return { release, platform, asset, url, keep, downloadBytes, zip: { remote, entries } };
  }
  return { release, platform, asset, url, keep, downloadBytes: await remoteSize(fetchImpl, url) };
}

export interface InstallOptions {
  /** `<DATA_DIR>/runtimes/ollama/app`: replaced only once everything has succeeded. */
  prefix: string;
  fetchImpl: typeof fetch;
  host: HostEnvironment;
  /** `done` and `total` in bytes of the download. */
  progress(done: number, total: number): void;
  timeoutMs?: number;
}

/** Where the `ollama` program is inside an unpacked release, or null when it is missing. */
export async function ollamaExecutable(
  prefix: string,
  platform: RuntimePlatform,
): Promise<string | null> {
  const name = platform.startsWith('win32') ? 'ollama.exe' : 'ollama';
  for (const candidate of [path.join(prefix, name), path.join(prefix, 'bin', name)]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

async function downloadVerified(
  plan: InstallPlan,
  file: string,
  expected: string,
  options: InstallOptions,
): Promise<void> {
  let response: Response;
  try {
    response = await options.fetchImpl(plan.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 60 * 60_000),
    });
  } catch (error) {
    throw new HubError('service_unavailable', {
      message: `could not download ${plan.url}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!response.ok || !response.body) {
    throw new HubError('service_unavailable', {
      message: `could not download ${plan.url}: HTTP ${response.status}`,
    });
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        done(new HubError('payload_too_large', { message: `${plan.url} is larger than expected` }));
        return;
      }
      hash.update(chunk);
      options.progress(bytes, plan.downloadBytes);
      done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    meter,
    createWriteStream(file, { mode: 0o600 }),
  );
  const actual = hash.digest('hex');
  if (actual !== expected) {
    throw new HubError('internal', {
      message: `refusing ${plan.asset.name}: its SHA-256 is ${actual}, the release publishes ${expected}`,
      details: { reason: 'checksum_mismatch', expected, actual },
    });
  }
}

async function untar(
  archive: string,
  dest: string,
  gzip: boolean,
  keep: string | null,
  options: InstallOptions,
): Promise<void> {
  const tar = whichSync('tar', options.host);
  if (!tar) {
    throw new HubError('service_unavailable', {
      message: 'tar is not on this computer, so the hub cannot unpack Ollama',
      details: { tool: 'tar' },
    });
  }
  const list = await runCommand([tar, gzip ? '-tzf' : '-tf', archive], { timeoutMs: 10 * 60_000 });
  if (!list.ok) {
    throw new HubError('internal', {
      message: (list.stderr || list.error || 'tar could not read Ollama').trim(),
    });
  }
  const excluded = new Set<string>();
  for (const name of list.stdout.split('\n')) {
    const match = /^((?:\.\/)?lib\/ollama\/[^/]+)\/?/.exec(name.trim());
    if (match?.[1] && skippedForGpu(name.trim(), keep)) excluded.add(match[1]);
  }
  const argv = [tar, gzip ? '-xzf' : '-xf', archive, '-C', dest, '--no-same-owner'];
  for (const folder of excluded) argv.push(`--exclude=${folder}`);
  const result = await runCommand(argv, { timeoutMs: 20 * 60_000 });
  if (!result.ok) {
    throw new HubError('internal', {
      message: (result.stderr || result.error || 'tar could not unpack Ollama').trim(),
    });
  }
}

export async function installOllama(plan: InstallPlan, options: InstallOptions): Promise<string> {
  const staging = `${options.prefix}.staging-${randomBytes(6).toString('hex')}`;
  const work = `${staging}.download`;
  try {
    await mkdir(staging, { recursive: true });
    await mkdir(work, { recursive: true });
    if (plan.zip) {
      let done = 0;
      for (const entry of plan.zip.entries) {
        await extractRemoteEntry(
          options.fetchImpl,
          plan.zip.remote,
          entry,
          staging,
          (bytes) => {
            done += bytes;
            options.progress(done, plan.downloadBytes);
          },
          options.timeoutMs ?? 30 * 60_000,
        );
      }
    } else {
      const expected = await releaseChecksum(options.fetchImpl, plan.release, plan.asset.name);
      const archive = path.join(work, plan.asset.name);
      await downloadVerified(plan, archive, expected, options);
      if (plan.asset.format === 'tar.zst') {
        const tarFile = path.join(work, 'ollama.tar');
        await pipeline(
          createReadStream(archive),
          createZstdDecompress(),
          createWriteStream(tarFile, { mode: 0o600 }),
        );
        await rm(archive, { force: true });
        await untar(tarFile, staging, false, plan.keep, options);
      } else {
        await untar(archive, staging, true, plan.keep, options);
      }
    }
    const executable = await ollamaExecutable(staging, plan.platform);
    if (!executable) {
      throw new HubError('internal', {
        message: `Ollama ${plan.release.tag} for ${plan.platform} holds no ollama program`,
        details: { reason: 'executable_missing' },
      });
    }
    if (!plan.platform.startsWith('win32')) await chmod(executable, 0o755);
    await rm(options.prefix, { recursive: true, force: true });
    await rename(staging, options.prefix);
    return path.join(options.prefix, path.relative(staging, executable));
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
