/**
 * Cloudflare's `cloudflared`, fetched the first time a person opens a Cloudflare way in
 * (DECISIONS §95): the release asset for this computer from Cloudflare's GitHub releases, at the
 * version pinned in `shared/relay.ts`, refused unless its SHA-256 is the one Cloudflare published
 * for it. It lives in the app's data folder (`<userData>/tools/cloudflared-<version>/`), apart
 * from anything the person installed themselves, and is never updated by itself
 * (`--no-autoupdate`): a new version comes with a new app.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  CLOUDFLARED_RELEASES,
  CLOUDFLARED_VERSION,
  cloudflaredAsset,
  cloudflaredUrl,
  type CloudflaredAsset,
} from '../shared/relay.js';

export class CloudflaredError extends Error {
  constructor(
    readonly code: 'download_failed' | 'checksum_mismatch' | 'unsupported_platform',
    message: string,
  ) {
    super(message);
    this.name = 'CloudflaredError';
  }
}

export interface EnsureOptions {
  /** `<userData>/tools`. */
  toolsDir: string;
  platform: string;
  arch: string;
  fetchImpl?: typeof fetch;
  /** Test seam: a fake release server. */
  releasesBase?: string;
  /** Test seam: the pinned asset for a fake release. */
  asset?: CloudflaredAsset;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * The single regular file named `name` in a tar archive (the macOS release is `cloudflared` in a
 * gzipped tar). Plain ustar reading: 512-byte headers, the size in octal, data padded to 512.
 */
export function fileFromTar(tar: Buffer, name: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
        .trim();
    const prefix = field(345, 155);
    const entry = (prefix ? `${prefix}/` : '') + field(0, 100);
    const size = parseInt(field(124, 12) || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if ((type === '0' || type === '\0') && entry.replace(/^\.\//, '') === name)
      return Buffer.from(tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Where the program is (or will be) for this computer, or null when there is no release for it. */
export function cloudflaredPath(toolsDir: string, platform: string, arch: string): string | null {
  const asset = cloudflaredAsset(platform, arch);
  return asset ? path.join(toolsDir, `cloudflared-${CLOUDFLARED_VERSION}`, asset.program) : null;
}

/**
 * The program, downloaded and checked on first use. A file already there is used only when its
 * hash is the one written beside it when it was checked; anything else is fetched again.
 */
export async function ensureCloudflared(options: EnsureOptions): Promise<string> {
  const asset = options.asset ?? cloudflaredAsset(options.platform, options.arch);
  if (!asset)
    throw new CloudflaredError(
      'unsupported_platform',
      `No cloudflared release for ${options.platform}-${options.arch}`,
    );
  const dir = path.join(options.toolsDir, `cloudflared-${CLOUDFLARED_VERSION}`);
  const program = path.join(dir, asset.program);
  const marker = `${program}.sha256`;
  if (existsSync(program) && existsSync(marker)) {
    try {
      if (readFileSync(marker, 'utf8').trim() === sha256(readFileSync(program))) return program;
    } catch {
      // Unreadable: fetch it again.
    }
  }

  const url = cloudflaredUrl(asset, options.releasesBase ?? CLOUDFLARED_RELEASES);
  let body: Buffer;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new CloudflaredError(
      'download_failed',
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const got = sha256(body);
  if (got !== asset.sha256)
    throw new CloudflaredError(
      'checksum_mismatch',
      `${asset.name}: SHA-256 ${got}, expected ${asset.sha256}`,
    );

  let bytes = body;
  if (asset.kind === 'tgz') {
    const inner = fileFromTar(gunzipSync(body), 'cloudflared');
    if (!inner)
      throw new CloudflaredError('download_failed', `${asset.name} has no cloudflared inside`);
    bytes = inner;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${program}.${process.pid}.download`;
  try {
    writeFileSync(temp, bytes, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, program);
    writeFileSync(marker, `${sha256(bytes)}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(temp, { force: true });
    throw new CloudflaredError(
      'download_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  return program;
}
