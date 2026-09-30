/**
 * The ACP bridges were renamed on npm (DECISIONS §139): `@zed-industries/claude-code-acp` →
 * `@agentclientprotocol/claude-agent-acp` (its program `claude-code-acp` → `claude-agent-acp`)
 * and `@zed-industries/codex-acp` → `@agentclientprotocol/codex-acp` (same program name). An
 * install of the old package keeps working — found, run, versioned by its own `package.json` —
 * until the person takes the update, which installs the new package in a fresh folder and swaps
 * only once it runs; a failed update leaves the old install exactly as it was.
 *
 * npm is a fake here that lays packages out as `npm install --global --prefix` does.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAdapter } from './adapters/acp.js';
import { catalogEntry, type CatalogEntry } from './catalog/index.js';
import {
  agentBinDir,
  createNpmInstaller,
  installedVersion,
  legacyInstalled,
  managedBinDirs,
} from './installer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BINARIES: Record<string, string> = {
  '@zed-industries/claude-code-acp': 'claude-code-acp',
  '@agentclientprotocol/claude-agent-acp': 'claude-agent-acp',
  '@zed-industries/codex-acp': 'codex-acp',
  '@agentclientprotocol/codex-acp': 'codex-acp',
};

/**
 * `npm install --global --prefix <p> <pkg@version>…`: each package's `package.json` under
 * `lib/node_modules`, and its program in `bin` — refusing, as npm does, to put a program over
 * one another package already owns. `$FAKE_NPM_FAIL` makes it fail; a program installed while
 * `$FAKE_BROKEN` is set cannot start (a Node too old for it).
 */
function fakeNpm(dir: string): void {
  const table = Object.entries(BINARIES)
    .map(([name, bin]) => `    ${name}) bin=${bin} ;;`)
    .join('\n');
  writeFileSync(
    path.join(dir, 'npm'),
    `#!/bin/sh
[ -n "$FAKE_NPM_FAIL" ] && { echo "npm ERR! network" >&2; exit 1; }
prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --*|install) shift ;;
    *)
      spec="$1"; shift
      name="\${spec%@*}"; version="\${spec##*@}"
      case "$name" in
${table}
        *) bin="" ;;
      esac
      mkdir -p "$prefix/lib/node_modules/$name" "$prefix/bin"
      printf '{"name":"%s","version":"%s"}' "$name" "$version" > "$prefix/lib/node_modules/$name/package.json"
      if [ -n "$bin" ]; then
        if [ -e "$prefix/bin/$bin" ]; then echo "npm error EEXIST: $prefix/bin/$bin" >&2; exit 1; fi
        if [ -n "$FAKE_BROKEN" ]; then
          printf '#!/bin/sh\\necho "SyntaxError: Unexpected identifier" >&2\\nexit 1\\n' > "$prefix/bin/$bin"
        else
          printf '#!/bin/sh\\necho %s\\n' "$version" > "$prefix/bin/$bin"
        fi
        chmod 755 "$prefix/bin/$bin"
      fi
      ;;
  esac
done
`,
  );
  chmodSync(path.join(dir, 'npm'), 0o755);
}

function setup(extra: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-rename-'));
  const tools = mkdtempSync(path.join(tmpdir(), 'corehub-rename-npm-'));
  dirs.push(dataDir, tools);
  fakeNpm(tools);
  const inherited = { PATH: `${tools}:/usr/bin:/bin`, ...extra };
  const installer = createNpmInstaller({
    dataDir,
    host: { pathValue: inherited.PATH, inherited },
  });
  return { dataDir, tools, installer };
}

const entryOf = (id: string): CatalogEntry => {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`no catalog entry ${id}`);
  return entry;
};

/** An install from before the rename, as npm left it. */
function legacyInstall(dataDir: string, pkg: string, version: string): void {
  const prefix = path.join(dataDir, 'agents', pkg.includes('claude') ? 'claude-code' : 'codex');
  const bin = BINARIES[pkg]!;
  mkdirSync(path.join(prefix, 'lib', 'node_modules', ...pkg.split('/')), { recursive: true });
  writeFileSync(
    path.join(prefix, 'lib', 'node_modules', ...pkg.split('/'), 'package.json'),
    JSON.stringify({ name: pkg, version }),
  );
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  writeFileSync(path.join(prefix, 'bin', bin), `#!/bin/sh\necho legacy\n`);
  chmodSync(path.join(prefix, 'bin', bin), 0o755);
}

const noReport = async () => {};

describe.skipIf(process.platform === 'win32')('an ACP bridge renamed on npm', () => {
  it('pins the successors, and remembers the old names', () => {
    const claude = entryOf('claude-code');
    const codex = entryOf('codex');
    expect(claude.install).toMatchObject({
      kind: 'npm',
      package: '@agentclientprotocol/claude-agent-acp',
      legacy: [{ package: '@zed-industries/claude-code-acp', binary: 'claude-code-acp' }],
    });
    expect(claude.binary).toBe('claude-agent-acp');
    expect(codex.install).toMatchObject({
      kind: 'npm',
      package: '@agentclientprotocol/codex-acp',
      legacy: [{ package: '@zed-industries/codex-acp', binary: 'codex-acp' }],
    });
  });

  it.each([
    ['claude-code', '@zed-industries/claude-code-acp', '0.16.2', 'claude-code-acp'],
    ['codex', '@zed-industries/codex-acp', '0.16.0', 'codex-acp'],
  ])('%s: an old install keeps working, with its own version', async (id, pkg, version, binary) => {
    const { dataDir, installer } = setup();
    const entry = entryOf(id);
    legacyInstall(dataDir, pkg, version);
    expect(installer.isPresent(entry)).toBe(true);
    expect(installer.executablePath?.(entry)).toBe(path.join(agentBinDir(dataDir, id), binary));
    await expect(installer.health(entry)).resolves.toEqual({
      ok: true,
      version,
      error: null,
    });
    expect(installedVersion(dataDir, entry)).toBe(version);
    expect(installedVersion(dataDir, entry, { current: true })).toBeNull();
    expect(legacyInstalled(dataDir, entry)).toEqual([pkg]);

    // The adapter finds and runs the old program under its old name.
    const adapter = createAcpAdapter({
      host: { pathValue: agentBinDir(dataDir, id), inherited: { PATH: '/usr/bin:/bin' } },
    });
    const found = (await adapter.discover()).find((agent) => agent.slug === id);
    expect(found?.command[0]).toBe(binary);
    expect(found?.executablePath).toBe(path.join(agentBinDir(dataDir, id), binary));
    const probe = await adapter.probe({
      slug: id,
      name: entry.name,
      command: [entry.binary],
      executablePath: null,
      endpoint: null,
    });
    expect(probe.installed).toBe(true);
  });

  it.each([
    ['claude-code', '@zed-industries/claude-code-acp', '0.16.2'],
    ['codex', '@zed-industries/codex-acp', '0.16.0'],
  ])('%s: the update moves it to the new package', async (id, pkg, version) => {
    const { dataDir, installer } = setup();
    const entry = entryOf(id);
    legacyInstall(dataDir, pkg, version);
    const outcome = await installer.install(entry, noReport);
    const pinned = entry.install.kind === 'npm' ? entry.install.version : '';
    expect(outcome).toEqual({
      version: pinned,
      executablePath: path.join(agentBinDir(dataDir, id), entry.binary),
    });
    expect(installedVersion(dataDir, entry, { current: true })).toBe(pinned);
    expect(legacyInstalled(dataDir, entry)).toEqual([]);
    // Nothing is left of the update in progress, and no dot folder is ever on PATH.
    expect(readdirSync(path.join(dataDir, 'agents')).sort()).toEqual([id]);
    expect(managedBinDirs(dataDir)).toEqual([agentBinDir(dataDir, id)]);
  });

  it.each([
    ['npm fails', { FAKE_NPM_FAIL: '1' }, /network/],
    ['the new program cannot start', { FAKE_BROKEN: '1' }, /does not start/],
  ])('a failed update (%s) leaves the old install as it was', async (_why, extra, error) => {
    const { dataDir, installer } = setup(extra);
    const entry = entryOf('claude-code');
    legacyInstall(dataDir, '@zed-industries/claude-code-acp', '0.16.2');
    await expect(installer.install(entry, noReport)).rejects.toThrow(error);
    expect(installedVersion(dataDir, entry)).toBe('0.16.2');
    expect(installer.executablePath?.(entry)).toBe(
      path.join(agentBinDir(dataDir, 'claude-code'), 'claude-code-acp'),
    );
    expect(existsSync(path.join(dataDir, 'agents', '.claude-code.next'))).toBe(false);
    expect(readdirSync(path.join(dataDir, 'agents'))).toEqual(['claude-code']);
  });

  it('a fresh install goes straight into the agent’s folder', async () => {
    const { dataDir, installer } = setup();
    const entry = entryOf('codex');
    const outcome = await installer.install(entry, noReport);
    expect(outcome.executablePath).toBe(path.join(agentBinDir(dataDir, 'codex'), 'codex-acp'));
    expect(installedVersion(dataDir, entry, { current: true })).toBe('2.0.0');
  });
});
