/**
 * Where the hub finds CLIProxyAPI (ADR 0029), and that the pin the image, the installers and the
 * hub read is one pin.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_MAIN_MODEL as AGENTS_MAIN,
  GATEWAY_SMALL_MODEL as AGENTS_SMALL,
} from '../../agents/gateway-models.js';
import { GATEWAY_MAIN_MODEL, GATEWAY_SMALL_MODEL } from './gateway.js';
import { CLIPROXY_VERSION, devCliproxyPath, locateCliproxy } from './locate.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CLIProxyAPI: the pin and where it is', () => {
  it('names one version everywhere, each file with its SHA-256', () => {
    const pin = JSON.parse(readFileSync(path.join(repo, 'scripts/cliproxy/pin.json'), 'utf8')) as {
      version: string;
      licence: string;
      assets: Record<string, { file: string; sha256: string }>;
    };
    expect(pin.version).toBe(CLIPROXY_VERSION);
    expect(pin.licence).toBe('MIT');
    expect(Object.keys(pin.assets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    for (const asset of Object.values(pin.assets)) {
      expect(asset.file).toContain(`_${pin.version}_`);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The image downloads the same release and checks the same hashes.
    const dockerfile = readFileSync(path.join(repo, 'packages/server/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY scripts/cliproxy /tmp/cliproxy');
    expect(dockerfile).toContain('node /tmp/cliproxy/fetch.mjs');
  });

  it('uses the configured path or none, else the image’s, else a developer’s copy', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-locate-'));
    dirs.push(home);
    expect(locateCliproxy({ configured: path.join(home, 'missing'), home })).toBeNull();
    const dev = devCliproxyPath(home);
    mkdirSync(path.dirname(dev), { recursive: true });
    writeFileSync(dev, '#!/bin/sh\n');
    chmodSync(dev, 0o755);
    expect(dev).toContain(path.join('.cache', 'corehub', 'cliproxy', CLIPROXY_VERSION));
    // (The image's /opt/corehub/bin copy is found first where it exists.)
    const found = locateCliproxy({ configured: null, home });
    expect([dev, '/opt/corehub/bin/cli-proxy-api']).toContain(found);
    expect(locateCliproxy({ configured: dev, home })).toBe(dev);
  });

  it('starts agents with the names the gateway answers to', () => {
    expect([AGENTS_MAIN, AGENTS_SMALL]).toEqual([GATEWAY_MAIN_MODEL, GATEWAY_SMALL_MODEL]);
  });
});
