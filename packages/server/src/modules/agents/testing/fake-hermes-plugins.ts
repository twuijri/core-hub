/**
 * `hermes plugins …` played in memory, for the route tests and the e2e hub. It answers the way
 * Hermes v2026.9.14 does (`hermes_cli/plugins_cmd.py`): the list as JSON with Hermes's words for
 * status and source, a refusal as one sentence on stdout and exit 1, and each profile's home its
 * own allow and deny lists and its own installed plugins. The real command is exercised by
 * `hermes-plugins.real.test.ts`.
 */
import type { HermesCli } from '../hermes-plugins.js';

interface FakePlugin {
  name: string;
  version: string;
  description: string;
  source: string;
  removed?: string | null;
}

/** What Hermes ships, in every profile. */
export const FAKE_BUNDLED: readonly FakePlugin[] = [
  { name: 'kanban', version: '1.0.0', description: 'Multi-agent kanban board', source: 'bundled' },
  {
    name: 'disk-cleanup',
    version: '0.3.0',
    description: 'Tidy temporary files after a run',
    source: 'bundled',
  },
];

/** What `plugins install <identifier>` can fetch. Anything else is refused as Hermes refuses. */
export const FAKE_CATALOG: Readonly<Record<string, FakePlugin>> = {
  'chrome-profiles': {
    name: 'chrome-profiles',
    version: '0.2.1',
    description: 'Open the browser with a saved Chrome profile',
    source: 'catalog:community@1a2b3c4d',
  },
  'anpicasso/hermes-plugin-chrome-profiles': {
    name: 'chrome-profiles',
    version: '0.2.1',
    description: 'Open the browser with a saved Chrome profile',
    source: 'git',
  },
};

interface Home {
  installed: FakePlugin[];
  enabled: Set<string>;
  disabled: Set<string>;
}

export interface FakeHermesPlugins {
  cli: HermesCli;
  /** Every command, as `<home> <argv…>`. */
  calls: string[];
  /** Put a plugin into a home as if it had been installed there. */
  install(home: string, plugin: FakePlugin): void;
}

export function fakeHermesPlugins(options: { installDelayMs?: number } = {}): FakeHermesPlugins {
  const homes = new Map<string, Home>();
  const calls: string[] = [];
  const stateOf = (home: string): Home => {
    let state = homes.get(home);
    if (!state) {
      state = { installed: [], enabled: new Set(), disabled: new Set() };
      homes.set(home, state);
    }
    return state;
  };
  const all = (state: Home): FakePlugin[] => [...FAKE_BUNDLED, ...state.installed];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const no = (stdout: string) => ({ code: 1, stdout, stderr: '' });

  const cli: HermesCli = async (home, argv) => {
    calls.push([home, ...argv].join(' '));
    const state = stateOf(home);
    const [group, verb, name] = argv;
    if (group !== 'plugins') return no(`unknown command ${group}`);
    const find = (key: string | undefined) => all(state).find((plugin) => plugin.name === key);
    switch (verb) {
      case 'list': {
        const rows = all(state).map((plugin) => ({
          name: plugin.name,
          status: state.disabled.has(plugin.name)
            ? 'disabled'
            : state.enabled.has(plugin.name)
              ? 'enabled'
              : 'not enabled',
          version: plugin.version,
          description: plugin.description,
          source: plugin.source,
          removed: plugin.removed ?? null,
        }));
        return ok(`${JSON.stringify(rows, null, 2)}\n`);
      }
      case 'enable':
      case 'disable': {
        if (!find(name)) return no(`Plugin '${name}' is not installed or bundled.`);
        const key = name as string;
        if (verb === 'enable') {
          state.enabled.add(key);
          state.disabled.delete(key);
          return ok(`✓ Plugin ${key} enabled. Takes effect on next session.\n`);
        }
        state.enabled.delete(key);
        state.disabled.add(key);
        return ok(`⊘ Plugin ${key} disabled. Takes effect on next session.\n`);
      }
      case 'remove': {
        const index = state.installed.findIndex((plugin) => plugin.name === name);
        if (index < 0) return no(`Plugin '${name}' not found in ${home}/plugins/.`);
        state.installed.splice(index, 1);
        state.enabled.delete(name as string);
        state.disabled.delete(name as string);
        return ok(`✗ Plugin ${name} removed from ${home}/plugins\n`);
      }
      case 'install': {
        if (options.installDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.installDelayMs));
        }
        const plugin = FAKE_CATALOG[name as string];
        if (!plugin) {
          return no(
            `Cloning https://github.com/${name}.git...\nError: Git clone failed:\nrepository '${name}' not found`,
          );
        }
        if (find(plugin.name)) return no(`Error: Plugin '${plugin.name}' already exists.`);
        state.installed.push(plugin);
        return ok(
          [
            `Cloning ${name}...`,
            `✓ Plugin ${plugin.name} installed.`,
            `Plugin installed but not enabled. Run \`hermes plugins enable ${plugin.name}\` to activate.`,
            'Restart the gateway for the plugin to take effect:',
            '  hermes gateway restart',
            '',
          ].join('\n'),
        );
      }
      default:
        return no(`unknown verb ${verb}`);
    }
  };

  return {
    cli,
    calls,
    install(home, plugin) {
      stateOf(home).installed.push(plugin);
    },
  };
}
