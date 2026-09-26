// Programs on this computer (ADR 0025): discovery on macOS, Windows and Linux, the settings a
// registration leaves to the person, starting a program on Windows, the Resolve readiness check.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeDesktopDirs, discoverPrograms, discoveryFiles } from '../../src/main/discovery.js';
import { checkResolve, scriptingEnv, type Exec } from '../../src/main/resolve.js';
import {
  dedupe,
  fromExtension,
  helperToolName,
  launchOf,
  missingFields,
  slug,
} from '../../src/shared/programs.js';
import { defaultHelper, parseHelper, withDefaultFolder } from '../../src/shared/helper.js';
import {
  escapeForCmd,
  findOnWindows,
  quoteForCRuntime,
  windowsLaunch,
} from '../../src/shared/windows-command.js';

/** A computer's files, in memory. */
function disk(files: Record<string, string>) {
  return {
    readText: (file: string) => files[file] ?? null,
    listDir: (dir: string) => {
      const prefix =
        dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}${dir.includes('\\') ? '\\' : '/'}`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split(/[\\/]/)[0]!);
      }
      return [...names];
    },
  };
}

const resolveManifest = {
  manifest_version: '0.2',
  name: 'resolve-mcp',
  display_name: 'DaVinci Resolve',
  description: 'Drive DaVinci Resolve.',
  compatibility: { platforms: ['darwin', 'win32', 'linux'] },
  server: {
    type: 'python',
    mcp_config: {
      command: 'python3',
      args: ['${__dirname}/server/main.py', '--out', '${DOCUMENTS}'],
      env: { RESOLVE_KEY: '${user_config.api_key}', MODE: '${user_config.mode}' },
      platform_overrides: { win32: { command: 'py', args: ['${__dirname}\\server\\main.py'] } },
    },
  },
  user_config: {
    api_key: { type: 'string', title: 'API key', sensitive: true, required: true },
    mode: { type: 'string', title: 'Mode', default: 'fast' },
  },
};

describe('discovery: every assistant, where it keeps its files', () => {
  it('reads all five on macOS, skips what is off, lists a URL server as remote, and each program once', () => {
    const home = '/Users/me';
    const claude = `${home}/Library/Application Support/Claude`;
    const found = discoverPrograms({
      home,
      platform: 'darwin',
      env: { GITHUB_TOKEN: 'gh-1' },
      ...disk({
        [`${claude}/claude_desktop_config.json`]: JSON.stringify({
          mcpServers: {
            blender: { command: 'uvx', args: ['blender-mcp'] },
            off: { command: 'x', disabled: true },
          },
        }),
        [`${claude}/Claude Extensions/ant.resolve/manifest.json`]: JSON.stringify(resolveManifest),
        [`${claude}/Claude Extensions Settings/ant.resolve.json`]: JSON.stringify({
          isEnabled: true,
          userConfig: { mode: 'quality', api_key: 'never-read' },
        }),
        [`${home}/.claude.json`]: JSON.stringify({
          mcpServers: {
            // The same server as Claude Desktop's: listed once.
            blender: { type: 'stdio', command: 'uvx', args: ['blender-mcp'] },
            github: { command: 'gh-mcp', env: { TOKEN: '${GITHUB_TOKEN}', ORG: '${ORG:-mine}' } },
          },
          projects: {
            '/work': { mcpServers: { figma: { type: 'http', url: 'https://f.example/mcp' } } },
          },
        }),
        [`${home}/.codex/config.toml`]: [
          '[mcp_servers.notes]',
          'command = "notes-mcp"',
          'args = ["--stdio"]',
          '[mcp_servers.notes.env]',
          'NOTES_DIR = "/Users/me/notes"',
          '[mcp_servers.old]',
          'command = "old"',
          'enabled = false',
        ].join('\n'),
        [`${home}/.cursor/mcp.json`]: JSON.stringify({
          mcpServers: { sheets: { command: 'sheets', env: { KEY: '${env:SHEETS_KEY}' } } },
        }),
        [`${home}/.codeium/windsurf/mcp_config.json`]: JSON.stringify({
          mcpServers: { wind: { command: 'wind', args: ['${userHome}/w'] } },
        }),
      }),
    });
    expect(found.map((p) => [p.id, p.source, p.kind])).toEqual([
      ['blender', 'claude_desktop', 'stdio'],
      ['davinci-resolve', 'claude_desktop_extension', 'stdio'],
      ['github', 'claude_code', 'stdio'],
      ['figma', 'claude_code', 'remote'],
      ['notes', 'codex', 'stdio'],
      ['sheets', 'cursor', 'stdio'],
      ['wind', 'windsurf', 'stdio'],
    ]);
    const resolve = found.find((p) => p.id === 'davinci-resolve')!;
    expect(resolve.command).toBe('python3');
    expect(resolve.args).toEqual([
      `${claude}/Claude Extensions/ant.resolve/server/main.py`,
      '--out',
      `${home}/Documents`,
    ]);
    // A stored non-secret value is used; the secret is asked for here, never read from there.
    expect(resolve.env).toEqual({ RESOLVE_KEY: '{{field:api_key}}', MODE: 'quality' });
    expect(resolve.fields).toEqual([
      { key: 'api_key', title: 'API key', description: null, sensitive: true, required: true },
    ]);
    const github = found.find((p) => p.id === 'github')!;
    expect(github.env).toEqual({ TOKEN: 'gh-1', ORG: 'mine' });
    expect(found.find((p) => p.id === 'sheets')!.fields.map((f) => [f.key, f.sensitive])).toEqual([
      ['SHEETS_KEY', true],
    ]);
    expect(found.find((p) => p.id === 'notes')!.env).toEqual({ NOTES_DIR: '/Users/me/notes' });
    expect(found.find((p) => p.id === 'wind')!.args).toEqual(['/Users/me/w']);
  });

  it('knows Windows: Roaming app data, the Store build’s own copy, and its overrides', () => {
    const home = 'C:\\Users\\me';
    const env = {
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    };
    const store =
      'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude';
    const files = disk({
      [`${store}\\claude_desktop_config.json`]: JSON.stringify({
        mcpServers: { resolve: { command: 'npx', args: ['-y', 'resolve-mcp'] } },
      }),
      [`${store}\\Claude Extensions\\ant.resolve\\manifest.json`]: JSON.stringify(resolveManifest),
      [`${home}\\.codex\\config.toml`]: '[mcp_servers.notes]\ncommand = "notes"\n',
    });
    const view = { home, platform: 'win32' as const, env, ...files };
    expect(claudeDesktopDirs(view)).toEqual(['C:\\Users\\me\\AppData\\Roaming\\Claude', store]);
    expect(discoveryFiles(view).map((f) => f.file)).toContain('C:\\Users\\me\\.cursor\\mcp.json');
    const found = discoverPrograms(view);
    expect(found.map((p) => [p.id, p.source])).toEqual([
      ['resolve', 'claude_desktop'],
      ['davinci-resolve', 'claude_desktop_extension'],
      ['notes', 'codex'],
    ]);
    const extension = found[1]!;
    expect(extension.command).toBe('py');
    expect(extension.args).toEqual([`${store}\\Claude Extensions\\ant.resolve\\server\\main.py`]);
    expect(extension.origin).toBe(`${store}\\Claude Extensions\\ant.resolve\\manifest.json`);
  });

  it('knows Linux: the XDG config folder', () => {
    const view = {
      home: '/home/me',
      platform: 'linux' as const,
      env: { XDG_CONFIG_HOME: '/home/me/.cfg' },
      ...disk({
        '/home/me/.cfg/Claude/claude_desktop_config.json': JSON.stringify({
          mcpServers: { a: { command: 'a' } },
        }),
      }),
    };
    expect(discoverPrograms(view).map((p) => p.origin)).toEqual([
      '/home/me/.cfg/Claude/claude_desktop_config.json',
    ]);
  });

  it('skips an extension that is switched off in Claude, or not for this system', () => {
    const ctx = { home: '/h', platform: 'darwin' as const, env: {} };
    expect(fromExtension(resolveManifest, '/x', { isEnabled: false }, ctx)).toBeNull();
    expect(
      fromExtension(
        { ...resolveManifest, compatibility: { platforms: ['win32'] } },
        '/x',
        null,
        ctx,
      ),
    ).toBeNull();
  });

  it('puts the person’s values in, and a program with a required one missing cannot start', () => {
    const ctx = { home: '/h', platform: 'linux' as const, env: {} };
    const program = fromExtension(resolveManifest, '/ext', null, ctx)!;
    expect(missingFields(program, {})).toEqual(['api_key']);
    expect(launchOf(program, {})).toBeNull();
    expect(launchOf(program, { api_key: 'k' })).toEqual({
      command: 'python3',
      args: ['/ext/server/main.py', '--out', '/h/Documents'],
      env: { RESOLVE_KEY: 'k', MODE: 'fast' },
      cwd: '/ext',
    });
  });

  it('names programs and their tools safely', () => {
    expect(slug('DaVinci Resolve (Studio)!')).toBe('davinci-resolve-studio');
    expect(slug('——')).toBe('program');
    const twice = dedupe([
      {
        ...fromExtension(resolveManifest, '/a', null, { home: '/h', platform: 'linux', env: {} })!,
      },
      {
        ...fromExtension(resolveManifest, '/b', null, { home: '/h', platform: 'linux', env: {} })!,
      },
    ]);
    expect(twice.map((p) => p.id)).toEqual(['davinci-resolve', 'davinci-resolve-2']);
    expect(helperToolName('davinci-resolve', 'render.start')).toBe('davinci-resolve__render_start');
    expect(helperToolName('p', 'x'.repeat(100))).toHaveLength(64);
  });
});

describe('starting a program on Windows', () => {
  const env = { PATH: 'C:\\node;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const exists = (files: string[]) => (file: string) => files.includes(file);

  it('finds it through PATH and PATHEXT', () => {
    expect(findOnWindows('npx', env, exists(['C:\\node\\npx.cmd']))).toBe('C:\\node\\npx.cmd');
    expect(findOnWindows('uvx', env, exists(['C:\\bin\\uvx.exe']))).toBe('C:\\bin\\uvx.exe');
    expect(findOnWindows('C:\\tools\\x.exe', env, exists(['C:\\tools\\x.exe']))).toBe(
      'C:\\tools\\x.exe',
    );
    expect(findOnWindows('nothing', env, exists([]))).toBeNull();
  });

  it('starts an .exe directly and a .cmd through cmd.exe with every argument made literal', () => {
    expect(windowsLaunch('uvx', ['a b'], env, exists(['C:\\bin\\uvx.exe']))).toEqual({
      file: 'C:\\bin\\uvx.exe',
      args: ['a b'],
      verbatim: false,
    });
    const cmd = windowsLaunch(
      'npx',
      ['-y', 'x & calc', 'say "hi"'],
      env,
      exists(['C:\\node\\npx.cmd']),
    );
    expect(cmd.file).toBe('cmd.exe');
    expect(cmd.verbatim).toBe(true);
    expect(cmd.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // No bare `&`: cmd.exe cannot read "calc" as a second command.
    expect(cmd.args[3]).not.toMatch(/[^^]&/);
    expect(cmd.args[3]).toContain('^&');
    expect(quoteForCRuntime('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteForCRuntime('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(escapeForCmd('a&b|c')).toBe('a^&b^|c');
  });
});

describe('the default folder', () => {
  it('is shared writable when nothing is, and never replaces what the person shared', () => {
    const empty = defaultHelper(() => 'f'.repeat(64));
    const withFolder = withDefaultFolder(empty, '/home/me/Core Hub');
    expect(withFolder.folders).toEqual([{ path: '/home/me/Core Hub', write: true }]);
    expect(withFolder.defaultFolder).toBe('/home/me/Core Hub');
    const mine = { ...empty, folders: [{ path: '/home/me/work', write: false }] };
    expect(withDefaultFolder(mine, '/home/me/Core Hub')).toBe(mine);
    // Kept across launches with the person's program choices.
    const saved = parseHelper(
      JSON.parse(
        JSON.stringify({
          ...withFolder,
          programs: {
            'davinci-resolve': {
              profiles: ['default', 'BAD SLUG'],
              values: { api_key: 'v1:abc' },
              tools: [{ name: 'render', description: 'r', input_schema: { type: 'object' } }],
            },
            'Not An Id': { profiles: ['default'] },
          },
        }),
      ),
      () => 'f'.repeat(64),
    );
    expect(saved.defaultFolder).toBe('/home/me/Core Hub');
    expect(saved.programs).toEqual({
      'davinci-resolve': {
        profiles: ['default'],
        values: { api_key: 'v1:abc' },
        tools: [{ name: 'render', description: 'r', input_schema: { type: 'object' } }],
      },
    });
  });
});

describe('DaVinci Resolve readiness', () => {
  const program = fromExtension(resolveManifest, '/ext', null, {
    home: '/h',
    platform: 'darwin',
    env: {},
  })!;
  const exec =
    (answers: Record<string, { code: number | null; stdout: string }>): Exec =>
    async (command) =>
      answers[command] ?? { code: null, stdout: '' };

  it('says what to install when there is no integration, and to start Resolve', async () => {
    const report = await checkResolve({
      platform: 'darwin',
      env: {},
      programs: [],
      settings: {},
      exec: exec({ pgrep: { code: 1, stdout: '' } }),
    });
    expect(report).toMatchObject({ integration: 'missing', running: false, scripting: 'unknown' });
    expect(report.steps).toEqual(['install_integration', 'start_resolve']);
  });

  it('asks Resolve itself; a running Resolve that does not answer needs the preference or Studio', async () => {
    const report = await checkResolve({
      platform: 'linux',
      env: {},
      programs: [program],
      settings: { 'davinci-resolve': { profiles: ['default'], values: {}, tools: null } },
      exec: exec({
        pgrep: { code: 0, stdout: '4242\n' },
        python3: { code: 0, stdout: '{"ok": false}\n' },
      }),
    });
    expect(report).toMatchObject({
      integration: 'shared',
      running: true,
      scripting: 'unreachable',
    });
    expect(report.steps).toEqual(['enable_scripting', 'needs_studio']);
  });

  it('is ready on Windows when Studio answers, and says the free edition cannot', async () => {
    const studio = await checkResolve({
      platform: 'win32',
      env: {},
      programs: [program],
      settings: { 'davinci-resolve': { profiles: ['default'], values: {}, tools: null } },
      exec: exec({
        tasklist: { code: 0, stdout: 'Resolve.exe   1234 Console  1  900,000 K\n' },
        py: {
          code: 0,
          stdout: '{"ok": true, "product": "DaVinci Resolve Studio", "version": "20.1"}\n',
        },
      }),
    });
    expect(studio).toMatchObject({
      running: true,
      scripting: 'reachable',
      studio: true,
      steps: [],
    });
    const free = await checkResolve({
      platform: 'darwin',
      env: {},
      programs: [program],
      settings: {},
      exec: exec({
        pgrep: { code: 0, stdout: '1\n' },
        python3: {
          code: 0,
          stdout: '{"ok": true, "product": "DaVinci Resolve", "version": "20"}\n',
        },
      }),
    });
    expect(free.steps).toEqual(['share_program', 'needs_studio']);
  });

  it('points Python at Resolve’s scripting files on each system', () => {
    expect(scriptingEnv('darwin', {}).RESOLVE_SCRIPT_LIB).toBe(
      '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so',
    );
    const win = scriptingEnv('win32', { PROGRAMDATA: 'C:\\ProgramData' });
    expect(win.RESOLVE_SCRIPT_API).toBe(
      'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting',
    );
    expect(win.PYTHONPATH).toBe(path.win32.join(win.RESOLVE_SCRIPT_API!, 'Modules'));
    expect(scriptingEnv('linux', { PYTHONPATH: '/x' }).PYTHONPATH).toBe(
      '/x:/opt/resolve/Developer/Scripting/Modules',
    );
  });
});
