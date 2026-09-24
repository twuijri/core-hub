/**
 * Hermes's plugins in one profile, as Hermes itself lists and changes them.
 *
 * What Hermes offers was read from its MIT source (tag v2026.9.14): `hermes_cli/plugins_cmd.py`
 * and `hermes_cli/subcommands/plugins.py` for the command, `hermes_cli/web_routers/
 * dashboard_ui.py` for the dashboard routes. The dashboard's plugin routes
 * (`/api/dashboard/plugins/hub`, `/api/dashboard/agent-plugins/{name}/enable` …) take no
 * `profile`, unlike its MCP, skills and cron routes: they read and write the home the dashboard
 * itself runs in, which is the default profile's. So the hub runs Hermes's own command against
 * the selected profile's home instead — the same functions behind both, and the only way to
 * reach a named profile's allow and deny lists:
 *
 * - `hermes plugins list --json` → `[{name, status, version, description, source, removed}]`,
 *   `status` being `enabled`, `disabled` or `not enabled`, and `source` `bundled`, `user`,
 *   `git`, `entrypoint`, or a provenance note for a catalog or pinned install
 *   (`catalog:<tier>@<sha8>`, `git pinned@<sha8>`).
 * - `hermes plugins enable <name> --no-allow-tool-override` / `disable <name>`: Hermes's allow
 *   and deny lists in the profile's `config.yaml`. The flag answers the one question `enable`
 *   would otherwise ask; a capability the plugin declares stays ungranted, which is what Hermes
 *   does without a person at its terminal ("fail closed").
 * - `hermes plugins remove <name>`: the folder under the profile's `plugins/`.
 * - `hermes plugins install <identifier> --no-enable`: from the curated catalog, a Git URL or
 *   `owner/repo`, scanned, checked against the catalog's kill list, installed switched off.
 *
 * Every command runs with stdin closed, so a question Hermes asks anyway is answered "no" (its
 * `_ask_yes` treats end of input as no), never left waiting. `COLUMNS` is wide so Rich does not
 * wrap Hermes's sentence across lines. Argument arrays only, never a shell string.
 */
import { spawn } from 'node:child_process';
import { HubError, notFound } from '../../lib/errors.js';
import { t, type Language } from '../../i18n/index.js';
import type { JobHandle } from '../audit/index.js';

/** One `hermes` command against one Hermes home. The real process, or a test's fake. */
export type HermesCli = (
  home: string,
  argv: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** How long a list or a switch may take; an install clones, so it gets longer. */
export const PLUGIN_COMMAND_TIMEOUT_MS = 60_000;
export const PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60_000;

/** Runs `hermes <argv>` with `HERMES_HOME` set to the profile's home, stdin closed. */
export function hermesCliRunner(options: {
  command: string;
  /** The whole environment (the runtime's `cliEnv()`); nothing is inherited from the hub. */
  env: () => NodeJS.ProcessEnv;
}): HermesCli {
  return (home, argv, call) =>
    new Promise((resolve) => {
      const child = spawn(options.command, [...argv], {
        env: { ...options.env(), HERMES_HOME: home, COLUMNS: '1000', NO_COLOR: '1' },
        cwd: home,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const cap = 4 * 1024 * 1024;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < cap) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < cap) stderr += chunk.toString('utf8');
      });
      const timer = setTimeout(() => {
        stderr += `\nhermes ${argv.slice(0, 2).join(' ')} did not finish in time`;
        child.kill('SIGKILL');
      }, call?.timeoutMs ?? PLUGIN_COMMAND_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

/** The contract's `AgentPlugin`. */
export interface AgentPlugin {
  key: string;
  name: string;
  kind: 'standalone' | 'bundled' | 'preset';
  source: 'bundled' | 'user' | 'external';
  status: 'enabled' | 'disabled' | 'not_enabled';
  version: string | null;
  description: string | null;
  author: string | null;
  configured: boolean;
  enabled: boolean;
  manageable: boolean;
  removable: boolean;
  provides_tools: string[];
  provides_hooks: string[];
  requires_env: string[];
  entries: never[];
}

interface HermesPluginRow {
  name?: unknown;
  status?: unknown;
  version?: unknown;
  description?: unknown;
  source?: unknown;
  removed?: unknown;
}

/** A plugin Hermes's command refused to act on, with its sentence. */
export function refusal(message: string): HubError {
  return new HubError('conflict', {
    message,
    details: { reason: 'hermes_refused', message },
  });
}

/** Hermes's own sentence from a failed command: its last line, or the traceback's. */
export function sentenceOf(result: { code: number; stdout: string; stderr: string }): string {
  const last = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1) ?? '';
  // A crash prints a traceback on stderr and leaves whatever it had printed on stdout; a
  // refusal (`_fail`) prints its sentence on stdout and exits 1.
  if (result.stderr.includes('Traceback')) return last(result.stderr);
  return last(result.stdout) || last(result.stderr) || `hermes exited with ${result.code}`;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function statusOf(value: unknown): AgentPlugin['status'] {
  if (value === 'enabled') return 'enabled';
  if (value === 'disabled') return 'disabled';
  return 'not_enabled';
}

/** Hermes's `source` (or its provenance note) as the contract's three. */
function sourceOf(value: unknown): AgentPlugin['source'] {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === 'bundled') return 'bundled';
  if (raw === 'entrypoint') return 'external';
  // `user`, `git`, `catalog:<tier>@<sha>`, `git pinned@<sha>`: a folder in the profile.
  return 'user';
}

/** Parse `hermes plugins list --json`. Anything printed before the array is not data. */
export function parsePluginList(stdout: string): { items: AgentPlugin[]; warnings: string[] } {
  const trimmed = stdout.trim();
  // "No plugins installed." is Hermes's answer for an empty list, not a failure.
  if (!trimmed.includes('[')) return { items: [], warnings: [] };
  const start = /^\[/m.exec(trimmed)?.index ?? trimmed.indexOf('[');
  let rows: unknown;
  try {
    rows = JSON.parse(trimmed.slice(start));
  } catch {
    throw new HubError('agent_error', {
      message: 'Hermes did not answer its plugin list as JSON',
      details: { reason: 'hermes_answer_unreadable' },
    });
  }
  if (!Array.isArray(rows)) return { items: [], warnings: [] };
  const items: AgentPlugin[] = [];
  const warnings: string[] = [];
  for (const row of rows as HermesPluginRow[]) {
    const name = text(row?.name);
    if (!name) continue;
    const source = sourceOf(row.source);
    const status = statusOf(row.status);
    const removed = text(row.removed);
    if (removed) warnings.push(`${name}: ${removed}`);
    items.push({
      key: name,
      name,
      kind: source === 'bundled' ? 'bundled' : 'standalone',
      source,
      status,
      version: text(row.version),
      description: text(row.description),
      author: null,
      configured: true,
      enabled: status === 'enabled',
      manageable: true,
      removable: source === 'user',
      provides_tools: [],
      provides_hooks: [],
      requires_env: [],
      entries: [],
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, warnings };
}

export async function listPlugins(
  cli: HermesCli,
  home: string,
): Promise<{ items: AgentPlugin[]; warnings: string[] }> {
  const result = await cli(home, ['plugins', 'list', '--json']);
  if (result.code !== 0) throw refusal(sentenceOf(result));
  return parsePluginList(result.stdout);
}

async function findPlugin(cli: HermesCli, home: string, key: string): Promise<AgentPlugin> {
  const { items } = await listPlugins(cli, home);
  const found = items.find((item) => item.key === key);
  if (!found) throw notFound({ resource: 'plugin', id: key });
  return found;
}

export async function setPluginEnabled(
  cli: HermesCli,
  home: string,
  key: string,
  enabled: boolean,
): Promise<AgentPlugin> {
  await findPlugin(cli, home, key);
  const argv = enabled
    ? ['plugins', 'enable', key, '--no-allow-tool-override']
    : ['plugins', 'disable', key];
  const result = await cli(home, argv);
  if (result.code !== 0) throw refusal(sentenceOf(result));
  return findPlugin(cli, home, key);
}

export async function removePlugin(cli: HermesCli, home: string, key: string): Promise<void> {
  const plugin = await findPlugin(cli, home, key);
  if (!plugin.removable) {
    // Hermes ships it (or a Python package registers it): switching it off is the way.
    throw new HubError('conflict', {
      details: { reason: 'plugin_bundled', plugin: key },
    });
  }
  const result = await cli(home, ['plugins', 'remove', key]);
  if (result.code !== 0) throw refusal(sentenceOf(result));
}

/**
 * The body of a `plugin_install` job: Hermes installs, switched off. The result names what
 * appeared in the list, which is how a catalog name or a URL becomes a plugin's name.
 */
export async function installPlugin(
  cli: HermesCli,
  handle: JobHandle,
  input: { home: string; identifier: string; language: Language },
): Promise<Record<string, unknown>> {
  const before = new Set((await listPlugins(cli, input.home)).items.map((item) => item.key));
  handle.progress(null, t('jobs.plugin_install.running', input.language));
  const result = await cli(input.home, ['plugins', 'install', input.identifier, '--no-enable'], {
    timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS,
  });
  if (result.code !== 0) throw refusal(sentenceOf(result));
  const after = (await listPlugins(cli, input.home)).items;
  const added = after.find((item) => !before.has(item.key));
  const output = result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-12)
    .join('\n');
  return {
    name: added?.name ?? null,
    identifier: input.identifier,
    output,
    message: t('jobs.plugin_install.done', input.language),
  };
}
