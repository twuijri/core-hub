/**
 * A home's copy of Hermes's WhatsApp bridge on the image's dependencies (`whatsapp-bridge.ts`):
 * made once, refreshed when the image's bridge changes, the link repaired, a home's own install
 * kept only while Hermes would still use it — and Node really resolves the bridge's ESM imports,
 * a dependency's own dependency included, through the link.
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWhatsAppBridge } from './whatsapp-bridge.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-wa-bridge-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * An installed bridge the way the image has it: ESM, its dependencies in `node_modules` with
 * Hermes's stamp. `baileys` imports `boom`, which only sits beside it — resolved from the
 * package's real path, not from the home's copy.
 */
function imageBridge(): string {
  const source = path.join(tempDir(), 'opt', 'whatsapp-bridge');
  write(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'bridge', type: 'module', dependencies: { baileys: '1.0.0' } }),
  );
  write(
    path.join(source, 'bridge.js'),
    "import { hello } from 'baileys';\nconsole.log(hello());\n",
  );
  write(path.join(source, 'lib', 'helper.js'), 'export const x = 1;\n');
  const modules = path.join(source, 'node_modules');
  write(path.join(modules, '.hermes-pkg-hash'), 'abc123\n');
  write(
    path.join(modules, 'baileys', 'package.json'),
    JSON.stringify({ name: 'baileys', type: 'module', exports: './index.js' }),
  );
  write(
    path.join(modules, 'baileys', 'index.js'),
    "import { boom } from 'boom';\nexport const hello = () => `linked ${boom}`;\n",
  );
  write(
    path.join(modules, 'boom', 'package.json'),
    JSON.stringify({ name: 'boom', type: 'module', exports: './index.js' }),
  );
  write(path.join(modules, 'boom', 'index.js'), "export const boom = 'ok';\n");
  return source;
}

const bridgeOf = (home: string) => path.join(home, 'scripts', 'whatsapp-bridge');

describe("a home's WhatsApp bridge on the image's dependencies", () => {
  it('does nothing where there is no installed bridge with dependencies (not the image)', () => {
    const home = tempDir();
    const source = path.join(tempDir(), 'bare');
    write(path.join(source, 'package.json'), '{}');
    expect(prepareWhatsAppBridge(home, source)).toBe('no-image-bridge');
    expect(prepareWhatsAppBridge(home, path.join(tempDir(), 'missing'))).toBe('no-image-bridge');
    expect(readdirSync(home)).toEqual([]);
  });

  it("copies the bridge's own files and links node_modules to the image's", () => {
    const source = imageBridge();
    const home = tempDir();
    expect(prepareWhatsAppBridge(home, source)).toBe('created');
    const bridge = bridgeOf(home);
    expect(readFileSync(path.join(bridge, 'bridge.js'), 'utf8')).toContain("from 'baileys'");
    expect(readFileSync(path.join(bridge, 'lib', 'helper.js'), 'utf8')).toContain('x = 1');
    expect(lstatSync(path.join(bridge, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(bridge, 'node_modules'))).toBe(path.join(source, 'node_modules'));
    // Hermes's stamp is read through the link, so its adapter installs nothing.
    expect(readFileSync(path.join(bridge, 'node_modules', '.hermes-pkg-hash'), 'utf8')).toBe(
      'abc123\n',
    );
    // No temporary folder is left beside it.
    expect(readdirSync(path.join(home, 'scripts'))).toEqual(['whatsapp-bridge']);
    // The second time there is nothing to do.
    expect(prepareWhatsAppBridge(home, source)).toBe('current');
  });

  it("lets Node resolve the bridge's ESM imports through the link", () => {
    const source = imageBridge();
    const home = tempDir();
    prepareWhatsAppBridge(home, source);
    const bridge = bridgeOf(home);
    const out = execFileSync(process.execPath, ['bridge.js'], { cwd: bridge, encoding: 'utf8' });
    expect(out.trim()).toBe('linked ok');
    // The check the image runs: a bare import from the home's bridge folder.
    const imported = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "const m = await import('baileys'); console.log(m.hello());"],
      { cwd: bridge, encoding: 'utf8' },
    );
    expect(imported.trim()).toBe('linked ok');
  });

  it("refreshes the copy when the image's bridge changed, and keeps nothing stale", () => {
    const source = imageBridge();
    const home = tempDir();
    prepareWhatsAppBridge(home, source);
    write(path.join(source, 'bridge.js'), "import { hello } from 'baileys';\nconsole.log(2);\n");
    expect(prepareWhatsAppBridge(home, source)).toBe('refreshed');
    expect(readFileSync(path.join(bridgeOf(home), 'bridge.js'), 'utf8')).toContain('log(2)');
    expect(lstatSync(path.join(bridgeOf(home), 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readdirSync(path.join(home, 'scripts'))).toEqual(['whatsapp-bridge']);
  });

  it('repairs a missing link or one that points at an older image', () => {
    const source = imageBridge();
    const home = tempDir();
    prepareWhatsAppBridge(home, source);
    const link = path.join(bridgeOf(home), 'node_modules');
    rmSync(link);
    expect(prepareWhatsAppBridge(home, source)).toBe('linked');
    expect(readlinkSync(link)).toBe(path.join(source, 'node_modules'));
  });

  it("keeps a home's own install while Hermes would still use it, and replaces it once not", () => {
    const source = imageBridge();
    const home = tempDir();
    // What Hermes left before the image carried the dependencies: its copy and its own install.
    const bridge = bridgeOf(home);
    for (const file of ['package.json', 'bridge.js', path.join('lib', 'helper.js')]) {
      write(path.join(bridge, file), readFileSync(path.join(source, file), 'utf8'));
    }
    write(path.join(bridge, 'node_modules', '.hermes-pkg-hash'), 'abc123');
    write(path.join(bridge, 'node_modules', 'baileys', 'index.js'), 'export const own = 1;\n');
    expect(prepareWhatsAppBridge(home, source)).toBe('kept-own');
    expect(lstatSync(path.join(bridge, 'node_modules')).isDirectory()).toBe(true);

    // An install Hermes would redo (its stamp no longer matches): the link replaces it.
    write(path.join(bridge, 'node_modules', '.hermes-pkg-hash'), 'older');
    expect(prepareWhatsAppBridge(home, source)).toBe('linked');
    expect(lstatSync(path.join(bridge, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it("replaces a home's own install when the image's bridge changed", () => {
    const source = imageBridge();
    const home = tempDir();
    const bridge = bridgeOf(home);
    write(path.join(bridge, 'bridge.js'), 'an older bridge\n');
    write(path.join(bridge, 'node_modules', '.hermes-pkg-hash'), 'abc123');
    expect(prepareWhatsAppBridge(home, source)).toBe('refreshed');
    expect(lstatSync(path.join(bridge, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(bridge, 'bridge.js'), 'utf8')).toContain("from 'baileys'");
  });
});
