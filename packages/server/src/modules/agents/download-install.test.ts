/**
 * Pinned-download recipes (`catalog/types.ts` kind `download`), against a fake release server:
 * the hub takes exactly the pinned file, refuses one whose SHA-256 differs before unpacking a
 * byte of it, unpacks only the named executable, and leaves a previous install alone when a
 * download fails.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG,
  assertCatalogIsWellFormed,
  catalogEntry,
  downloadPlatform,
  type CatalogEntry,
  type DownloadAsset,
} from './catalog/index.js';
import { createNpmInstaller } from './installer.js';

const posix = process.platform !== 'win32';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const script = (version: string) => Buffer.from(`#!/bin/sh\necho "tool ${version}"\n`);

let server: Server;
let base = '';
const files = new Map<string, Buffer>();
const requested: string[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    requested.push(request.url ?? '');
    const body = files.get(request.url ?? '');
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': String(body.length) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // One release, three packings of the same executable.
  files.set('/v1.2.3/tool-raw', script('1.2.3'));
  files.set('/v1.2.3/tool.gz', gzipSync(script('1.2.3')));
  const stage = mkdtempSync(path.join(tmpdir(), 'corehub-release-'));
  dirs.push(stage);
  mkdirSync(path.join(stage, 'pkg'));
  writeFileSync(path.join(stage, 'pkg', 'tool'), script('1.2.3'));
  writeFileSync(path.join(stage, 'pkg', 'README'), 'not the executable');
  chmodSync(path.join(stage, 'pkg', 'tool'), 0o755);
  if (posix) {
    execFileSync('tar', ['-czf', path.join(stage, 'tool.tar.gz'), '-C', stage, 'pkg']);
    files.set('/v1.2.3/tool.tar.gz', readFileSync(path.join(stage, 'tool.tar.gz')));
  }
  files.set('/v1.3.0/tool.gz', gzipSync(script('1.3.0')));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const asset = (file: string, extra: Partial<DownloadAsset> = {}): DownloadAsset => {
  const body = files.get(file)!;
  const format = file.endsWith('.tar.gz') ? 'tar.gz' : file.endsWith('.gz') ? 'gz' : 'raw';
  return {
    url: `${base}${file}`,
    sha256: sha256(body),
    format,
    ...(format === 'tar.gz' ? { extract: 'pkg/tool' } : {}),
    ...extra,
  };
};

const entry = (install: CatalogEntry['install']): CatalogEntry => ({
  id: 'tool',
  name: 'Tool',
  vendor: null,
  licence: 'MIT',
  adapter: 'acp',
  binary: 'tool',
  protocolArgs: ['acp'],
  versionArgs: ['--version'],
  install,
  credentials: {},
  health: { kind: 'command', args: ['--version'] },
  capabilities: [],
  sections: [],
  subagents: 'none',
});

const setup = (options: { maxDownloadBytes?: number } = {}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-download-'));
  dirs.push(dataDir);
  const installer = createNpmInstaller({
    dataDir,
    host: { pathValue: process.env.PATH },
    platform: 'linux-x64',
    fetchImpl: fetch,
    ...options,
  });
  const messages: string[] = [];
  const report = async (_percent: number | null, message: string) => {
    messages.push(message);
  };
  return { dataDir, installer, messages, report, bin: path.join(dataDir, 'agents', 'tool', 'bin') };
};

describe.runIf(posix)('download recipes: install from a fake release server', () => {
  it('unpacks only the named executable from a tarball and reports its version', async () => {
    const { installer, report, bin } = setup();
    const tool = entry({
      kind: 'download',
      version: '1.2.3',
      assets: { 'linux-x64': asset('/v1.2.3/tool.tar.gz') },
    });
    const outcome = await installer.install(tool, report);
    expect(outcome).toEqual({ version: '1.2.3', executablePath: path.join(bin, 'tool') });
    expect(readFileSync(path.join(bin, 'tool'), 'utf8')).toContain('tool 1.2.3');
    // The README, the archive and the unpacking folder are gone; the agent folder is its bin.
    expect(existsSync(path.join(bin, '..', 'download'))).toBe(false);
    expect(existsSync(path.join(bin, '..', 'unpacked'))).toBe(false);
    expect(installer.isPresent(tool)).toBe(true);
  });

  it('gunzips a gzipped executable and takes a bare one as it is', async () => {
    for (const file of ['/v1.2.3/tool.gz', '/v1.2.3/tool-raw']) {
      const { installer, report, bin } = setup();
      const tool = entry({
        kind: 'download',
        version: '1.2.3',
        assets: { 'linux-x64': asset(file) },
      });
      await expect(installer.install(tool, report)).resolves.toMatchObject({ version: '1.2.3' });
      expect(readFileSync(path.join(bin, 'tool'), 'utf8')).toContain('tool 1.2.3');
    }
  });

  it('refuses a file whose SHA-256 is not the pinned one, and keeps the previous install', async () => {
    const { installer, report, bin } = setup();
    // What an earlier install left: it must survive a refused download untouched.
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'tool'), script('1.0.0'));
    const tool = entry({
      kind: 'download',
      version: '1.2.3',
      assets: {
        'linux-x64': asset('/v1.2.3/tool.gz', { sha256: 'a'.repeat(64) }),
      },
    });
    const refused = installer.install(tool, report);
    await expect(refused).rejects.toThrow(/SHA-256 is [0-9a-f]{64}, the catalog pins a{64}/);
    await expect(refused).rejects.toMatchObject({ details: { reason: 'checksum_mismatch' } });
    expect(readFileSync(path.join(bin, 'tool'), 'utf8')).toContain('tool 1.0.0');
    // No staging folder is left behind beside it.
    expect(readdirSync(path.join(bin, '..', '..'))).toEqual(['tool']);
  });

  it('takes the pinned version only, even when an update names a newer one', async () => {
    const { installer, report, bin } = setup();
    requested.length = 0;
    const tool = entry({
      kind: 'download',
      version: '1.2.3',
      assets: { 'linux-x64': asset('/v1.2.3/tool.gz') },
    });
    await installer.install(tool, report, { tool: '1.3.0' });
    expect(requested).toEqual(['/v1.2.3/tool.gz']);
    expect(readFileSync(path.join(bin, 'tool'), 'utf8')).toContain('tool 1.2.3');
  });

  it('refuses a platform the release is not published for, and a download past the ceiling', async () => {
    const { installer, report } = setup();
    const macOnly = entry({
      kind: 'download',
      version: '1.2.3',
      assets: { 'darwin-arm64': asset('/v1.2.3/tool.gz') },
    });
    await expect(installer.install(macOnly, report)).rejects.toMatchObject({
      code: 'agent_unavailable',
    });
    const small = setup({ maxDownloadBytes: 8 });
    const tool = entry({
      kind: 'download',
      version: '1.2.3',
      assets: { 'linux-x64': asset('/v1.2.3/tool-raw') },
    });
    await expect(small.installer.install(tool, small.report)).rejects.toThrow(/larger than/);
  });

  it('refuses a tarball that does not hold the named executable', async () => {
    const { installer, report } = setup();
    const tool = entry({
      kind: 'download',
      version: '1.2.3',
      assets: { 'linux-x64': asset('/v1.2.3/tool.tar.gz', { extract: 'pkg/missing' }) },
    });
    await expect(installer.install(tool, report)).rejects.toMatchObject({
      details: { reason: 'executable_missing' },
    });
  });
});

describe('download recipes: the catalog guard', () => {
  const good = (extra: Partial<DownloadAsset> = {}): CatalogEntry =>
    entry({
      kind: 'download',
      version: '1.2.3',
      assets: {
        'linux-x64': {
          url: 'https://example.org/v1.2.3/tool.tar.gz',
          sha256: 'b'.repeat(64),
          format: 'tar.gz',
          extract: 'tool',
          ...extra,
        },
      },
    });

  it('accepts a pinned https download with a full hash', () => {
    expect(() => assertCatalogIsWellFormed([good()])).not.toThrow();
  });

  it('refuses a moving version, http, a URL without the version, a short hash, a climbing path', () => {
    expect(() =>
      assertCatalogIsWellFormed([
        entry({
          kind: 'download',
          version: 'latest',
          assets: {
            'linux-x64': { url: 'https://example.org/latest/t', sha256: 'b'.repeat(64), format: 'raw' },
          },
        }),
      ]),
    ).toThrow(/exact version/);
    expect(() =>
      assertCatalogIsWellFormed([good({ url: 'http://example.org/v1.2.3/tool.tar.gz' })]),
    ).toThrow(/https/);
    expect(() =>
      assertCatalogIsWellFormed([good({ url: 'https://example.org/latest/tool.tar.gz' })]),
    ).toThrow(/does not name 1.2.3/);
    expect(() => assertCatalogIsWellFormed([good({ sha256: 'abc' })])).toThrow(/SHA-256/);
    expect(() => assertCatalogIsWellFormed([good({ extract: '../etc/passwd' })])).toThrow(
      /relative path/,
    );
    expect(() => assertCatalogIsWellFormed([good({ extract: '/tool' })])).toThrow(/relative path/);
  });

  it('carries Goose and Grok Build as pinned downloads, verified on 2026-09-26', () => {
    const goose = catalogEntry('goose')!;
    const grok = catalogEntry('grok-build')!;
    expect(goose.install).toMatchObject({ kind: 'download', version: '1.52.0' });
    expect(grok.install).toMatchObject({ kind: 'download', version: '1.0.41' });
    expect(goose).toMatchObject({ binary: 'goose', protocolArgs: ['acp'], licence: 'Apache-2.0' });
    expect(grok).toMatchObject({
      binary: 'grok',
      protocolArgs: ['agent', '--no-leader', 'stdio'],
      licence: 'Apache-2.0',
      signIn: { args: ['login', '--device-auth'] },
    });
    // Both are published for Linux on x64 and arm64, which is what the image runs on.
    for (const recipe of [goose.install, grok.install]) {
      if (recipe.kind !== 'download') throw new Error('not a download');
      expect(Object.keys(recipe.assets).sort()).toEqual([
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
      ]);
    }
    expect(catalogEntry('kimi-code')?.signIn).toEqual({ args: ['login', '--region', 'global'] });
    expect(CATALOG.filter((item) => item.install.kind === 'download').map((item) => item.id)).toEqual([
      'goose',
      'grok-build',
    ]);
  });

  it('names the host platform the way the recipes do', () => {
    expect(downloadPlatform('linux', 'x64')).toBe('linux-x64');
    expect(downloadPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(downloadPlatform('linux', 'ia32')).toBeNull();
  });
});
