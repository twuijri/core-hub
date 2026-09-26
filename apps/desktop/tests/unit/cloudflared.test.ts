// Fetching cloudflared (DECISIONS §92) from a fake release server: the pinned SHA-256 decides,
// the macOS archive is unpacked, a checked copy is reused, and nothing half-written is left.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudflaredError,
  cloudflaredPath,
  ensureCloudflared,
  fileFromTar,
} from '../../src/main/cloudflared.js';
import {
  CLOUDFLARED_VERSION,
  cloudflaredAsset,
  cloudflaredUrl,
  type CloudflaredAsset,
} from '../../src/shared/relay.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** A one-file ustar archive, as `tar czf` makes the macOS release. */
function tarOf(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000755\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A release server: `/<version>/<name>` answers the given bytes and counts the calls. */
async function releases(files: Record<string, Buffer>) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    const name = (request.url ?? '').split('/').at(-1) ?? '';
    const body = files[name];
    if (!request.url?.startsWith(`/${CLOUDFLARED_VERSION}/`) || !body) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, hits };
}

const tools = () => mkdtempSync(path.join(os.tmpdir(), 'corehub-tools-'));
const PROGRAM = Buffer.from('#!/bin/sh\necho cloudflared version test\n');

describe('the pinned release', () => {
  it('has a checksum for every computer the app is built for, from Cloudflare’s own list', () => {
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['win32', 'x64'],
      ['linux', 'x64'],
    ] as const) {
      const asset = cloudflaredAsset(platform, arch);
      expect(asset, `${platform}-${arch}`).not.toBeNull();
      expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cloudflaredUrl(asset!)).toBe(
        `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset!.name}`,
      );
    }
    expect(cloudflaredAsset('win32', 'x64')!.program).toBe('cloudflared.exe');
    expect(cloudflaredAsset('freebsd', 'x64')).toBeNull();
  });
});

describe('ensureCloudflared', () => {
  it('downloads the program, checks it and keeps it executable in the tools folder', async () => {
    const asset: CloudflaredAsset = {
      name: 'cloudflared-linux-amd64',
      sha256: sha(PROGRAM),
      kind: 'binary',
      program: 'cloudflared',
    };
    const server = await releases({ [asset.name]: PROGRAM });
    const dir = tools();
    const program = await ensureCloudflared({
      toolsDir: dir,
      platform: 'linux',
      arch: 'x64',
      releasesBase: server.base,
      asset,
    });
    expect(program).toBe(path.join(dir, `cloudflared-${CLOUDFLARED_VERSION}`, 'cloudflared'));
    expect(program).toBe(cloudflaredPath(dir, 'linux', 'x64'));
    expect(readFileSync(program)).toEqual(PROGRAM);
    if (process.platform !== 'win32') expect(statSync(program).mode & 0o111).not.toBe(0);
    expect(server.hits).toEqual([`/${CLOUDFLARED_VERSION}/${asset.name}`]);

    // A checked copy is used as it is; a changed one is fetched again.
    await ensureCloudflared({
      toolsDir: dir,
      platform: 'linux',
      arch: 'x64',
      releasesBase: server.base,
      asset,
    });
    expect(server.hits).toHaveLength(1);
    writeFileSync(program, 'tampered');
    await ensureCloudflared({
      toolsDir: dir,
      platform: 'linux',
      arch: 'x64',
      releasesBase: server.base,
      asset,
    });
    expect(server.hits).toHaveLength(2);
    expect(readFileSync(program)).toEqual(PROGRAM);
  });

  it('unpacks the macOS archive after checking the archive itself', async () => {
    const archive = gzipSync(tarOf('cloudflared', PROGRAM));
    const asset: CloudflaredAsset = {
      name: 'cloudflared-darwin-arm64.tgz',
      sha256: sha(archive),
      kind: 'tgz',
      program: 'cloudflared',
    };
    const server = await releases({ [asset.name]: archive });
    const program = await ensureCloudflared({
      toolsDir: tools(),
      platform: 'darwin',
      arch: 'arm64',
      releasesBase: server.base,
      asset,
    });
    expect(readFileSync(program)).toEqual(PROGRAM);
    expect(fileFromTar(tarOf('./cloudflared', PROGRAM), 'cloudflared')).toEqual(PROGRAM);
    expect(fileFromTar(tarOf('other', PROGRAM), 'cloudflared')).toBeNull();
  });

  it('refuses a file whose checksum is not the pinned one, and keeps nothing of it', async () => {
    const asset: CloudflaredAsset = {
      name: 'cloudflared-linux-amd64',
      sha256: sha(PROGRAM),
      kind: 'binary',
      program: 'cloudflared',
    };
    const server = await releases({ [asset.name]: Buffer.from('something else entirely') });
    const dir = tools();
    const error = await ensureCloudflared({
      toolsDir: dir,
      platform: 'linux',
      arch: 'x64',
      releasesBase: server.base,
      asset,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflaredError);
    expect((error as CloudflaredError).code).toBe('checksum_mismatch');
    expect(existsSync(path.join(dir, `cloudflared-${CLOUDFLARED_VERSION}`))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('says a failed download, and a computer with no release, as such', async () => {
    const server = await releases({});
    const missing = await ensureCloudflared({
      toolsDir: tools(),
      platform: 'linux',
      arch: 'x64',
      releasesBase: server.base,
    }).catch((e: unknown) => e);
    expect((missing as CloudflaredError).code).toBe('download_failed');
    expect((missing as CloudflaredError).message).toContain('HTTP 404');
    const unsupported = await ensureCloudflared({
      toolsDir: tools(),
      platform: 'freebsd',
      arch: 'x64',
    }).catch((e: unknown) => e);
    expect((unsupported as CloudflaredError).code).toBe('unsupported_platform');
  });
});
