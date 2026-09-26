/**
 * Installing a catalog agent that ships as a release file rather than an npm package
 * (`InstallRecipe` kind `download`, `catalog/types.ts`).
 *
 * The order is what makes it safe to run on a person's box:
 *
 * 1. pick the file for the platform the hub runs on — no file, no install;
 * 2. stream it into a staging folder beside the agent's own, hashing as it arrives and
 *    stopping at a size ceiling;
 * 3. **refuse it unless its SHA-256 is the one the catalog pins**, before a byte of it is
 *    unpacked or run;
 * 4. unpack only the one executable the recipe names, into `bin/`, and make it executable;
 * 5. only then swap the staging folder in for `<DATA_DIR>/agents/<id>`, so a failed or
 *    refused download leaves whatever was installed before exactly as it was.
 *
 * A tarball is unpacked by the host's own `tar`, called with an argv array, into a folder of
 * its own; the executable is then taken from the path the recipe names, and only if it is a
 * regular file whose real path stays inside that folder. The archive has already matched its
 * pinned hash by then, so its content is the release the owner reviewed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { agentUnavailable, HubError } from '../../lib/errors.js';
import { runCommand, whichSync, type HostEnvironment } from './adapters/host.js';
import type {
  CatalogEntry,
  DownloadAsset,
  DownloadPlatform,
  InstallRecipe,
} from './catalog/index.js';

export interface DownloadInstallOptions {
  /** `<DATA_DIR>/agents/<id>`: replaced only once everything below has succeeded. */
  prefix: string;
  platform: DownloadPlatform | null;
  report(percent: number | null, message: string): Promise<void>;
  host: HostEnvironment;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  /** Largest file accepted, compressed and unpacked alike. */
  maxBytes: number;
}

/** The executable's file name on this platform. */
export function executableName(binary: string, platform: DownloadPlatform | null): string {
  return platform?.startsWith('win32') ? `${binary}.exe` : binary;
}

/** Counts and hashes what passes through; stops the stream past `maxBytes`. */
function meter(maxBytes: number, url: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done(
          new HubError('payload_too_large', {
            message: `${url} is larger than the ${maxBytes} bytes an agent download may be`,
          }),
        );
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest('hex'), bytes: () => bytes };
}

export async function installDownload(
  entry: CatalogEntry,
  recipe: Extract<InstallRecipe, { kind: 'download' }>,
  options: DownloadInstallOptions,
): Promise<void> {
  const asset: DownloadAsset | undefined = options.platform
    ? recipe.assets[options.platform]
    : undefined;
  if (!asset) {
    throw agentUnavailable({
      agent: entry.id,
      platform: options.platform,
      reason: `${entry.name} ${recipe.version} is not published for this platform`,
    });
  }
  const staging = `${options.prefix}.staging-${randomBytes(6).toString('hex')}`;
  const archive = path.join(staging, 'download');
  const bin = path.join(staging, 'bin');
  const target = path.join(bin, executableName(entry.binary, options.platform));
  try {
    await mkdir(bin, { recursive: true });

    // 1-2. Fetch, hashing as it arrives.
    await options.report(10, `downloading ${entry.name} ${recipe.version} from ${asset.url}`);
    let response: Response;
    try {
      response = await options.fetchImpl(asset.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new HubError('service_unavailable', {
        message: `could not download ${asset.url}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!response.ok || !response.body) {
      throw new HubError('service_unavailable', {
        message: `could not download ${asset.url}: HTTP ${response.status}`,
      });
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > options.maxBytes) {
      throw new HubError('payload_too_large', {
        message: `${asset.url} is larger than the ${options.maxBytes} bytes an agent download may be`,
      });
    }
    const metered = meter(options.maxBytes, asset.url);
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      metered.stream,
      createWriteStream(archive, { mode: 0o600 }),
    );

    // 3. The pin, before anything is unpacked or run.
    const actual = metered.digest();
    if (actual !== asset.sha256) {
      throw new HubError('internal', {
        message:
          `refusing ${asset.url}: its SHA-256 is ${actual}, the catalog pins ${asset.sha256} ` +
          `for ${entry.name} ${recipe.version}`,
        details: { reason: 'checksum_mismatch', expected: asset.sha256, actual },
      });
    }

    // 4. Only the executable, into bin/.
    await options.report(50, `unpacking ${entry.binary}`);
    if (asset.format === 'raw') {
      await rename(archive, target);
    } else if (asset.format === 'gz') {
      const unpacked = meter(options.maxBytes, asset.url);
      await pipeline(
        createReadStream(archive),
        createGunzip(),
        unpacked.stream,
        createWriteStream(target, { mode: 0o700 }),
      );
    } else {
      await extractFromTarball(archive, asset.extract ?? '', staging, target, options);
    }
    await chmod(target, 0o755);
    await rm(archive, { force: true });
    await rm(path.join(staging, 'unpacked'), { recursive: true, force: true });

    // 5. Swap in: the old install goes only now.
    await options.report(70, `installing into ${options.prefix}`);
    await rm(options.prefix, { recursive: true, force: true });
    await rename(staging, options.prefix);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractFromTarball(
  archive: string,
  inner: string,
  staging: string,
  target: string,
  options: DownloadInstallOptions,
): Promise<void> {
  const tar = whichSync('tar', options.host);
  if (!tar) {
    throw new HubError('service_unavailable', {
      message: 'tar is not on this host, so the hub cannot unpack the agent',
      details: { tool: 'tar' },
    });
  }
  const unpacked = path.join(staging, 'unpacked');
  await mkdir(unpacked, { recursive: true });
  const result = await runCommand([tar, '-xzf', archive, '-C', unpacked, '--no-same-owner'], {
    timeoutMs: options.timeoutMs,
  });
  if (!result.ok) {
    throw new HubError('internal', {
      message: (result.stderr || result.error || 'tar could not unpack the download').trim(),
    });
  }
  const source = path.join(unpacked, inner);
  let stat;
  try {
    stat = await lstat(source);
  } catch {
    throw new HubError('internal', {
      message: `the download holds no ${inner}`,
      details: { reason: 'executable_missing' },
    });
  }
  const real = await realpath(source);
  const root = await realpath(unpacked);
  if (!stat.isFile() || !real.startsWith(root + path.sep)) {
    throw new HubError('internal', {
      message: `${inner} in the download is not a plain file inside it`,
      details: { reason: 'executable_not_regular' },
    });
  }
  await rename(real, target);
}
