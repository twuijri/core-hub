/**
 * Finds the programs other assistants registered on this computer (ADR 0025): reads their
 * configuration files where each one keeps them on macOS, Windows and Linux, and hands what it
 * finds to `shared/programs.ts`. Reading only: nothing is started, nothing is written.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  dedupe,
  fromExtension,
  fromServerMap,
  type DiscoveredProgram,
  type PlaceholderContext,
  type ProgramSource,
} from '../shared/programs.js';

export interface DiscoveryEnv {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Tests give a folder of fixtures; the app reads the real files. */
  readText?: (file: string) => string | null;
  listDir?: (dir: string) => string[];
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Claude Desktop's own folder: Application Support, Roaming app data, or the XDG config. */
export function claudeDesktopDir(env: DiscoveryEnv): string {
  if (env.platform === 'darwin')
    return path.join(env.home, 'Library', 'Application Support', 'Claude');
  if (env.platform === 'win32')
    return path.join(env.env.APPDATA ?? path.join(env.home, 'AppData', 'Roaming'), 'Claude');
  return path.join(env.env.XDG_CONFIG_HOME ?? path.join(env.home, '.config'), 'Claude');
}

/** Every file this looks in, with the source each one is. */
export function discoveryFiles(env: DiscoveryEnv): Array<{ source: ProgramSource; file: string }> {
  const claude = claudeDesktopDir(env);
  return [
    { source: 'claude_desktop', file: path.join(claude, 'claude_desktop_config.json') },
    { source: 'claude_code', file: path.join(env.home, '.claude.json') },
    {
      source: 'codex',
      file: path.join(env.env.CODEX_HOME ?? path.join(env.home, '.codex'), 'config.toml'),
    },
    { source: 'cursor', file: path.join(env.home, '.cursor', 'mcp.json') },
    { source: 'windsurf', file: path.join(env.home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
}

function parse(file: string, text: string): unknown {
  try {
    return file.endsWith('.toml') ? parseToml(text) : JSON.parse(text);
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** What one assistant's file registers. */
function programsIn(
  source: ProgramSource,
  file: string,
  data: unknown,
  ctx: PlaceholderContext,
): DiscoveredProgram[] {
  if (!isRecord(data)) return [];
  if (source === 'codex') return fromServerMap(data.mcp_servers, source, file, ctx);
  const found = fromServerMap(data.mcpServers, source, file, ctx);
  if (source === 'claude_code' && isRecord(data.projects)) {
    // A server Claude Code keeps for one project folder (its "local" scope).
    for (const project of Object.values(data.projects)) {
      if (isRecord(project)) found.push(...fromServerMap(project.mcpServers, source, file, ctx));
    }
  }
  return found;
}

/** Claude Desktop's installed extensions, each unpacked in a folder with its manifest. */
function extensions(env: DiscoveryEnv, ctx: PlaceholderContext): DiscoveredProgram[] {
  const read = env.readText ?? readText;
  const list = env.listDir ?? listDir;
  const claude = claudeDesktopDir(env);
  const root = path.join(claude, 'Claude Extensions');
  const found: DiscoveredProgram[] = [];
  for (const name of list(root)) {
    const folder = path.join(root, name);
    const manifest = read(path.join(folder, 'manifest.json'));
    if (manifest === null) continue;
    const settingsText = read(path.join(claude, 'Claude Extensions Settings', `${name}.json`));
    const program = fromExtension(
      parse('manifest.json', manifest),
      folder,
      settingsText === null ? null : parse('settings.json', settingsText),
      ctx,
    );
    if (program) found.push(program);
  }
  return found;
}

/** Everything registered on this computer, each program once. */
export function discoverPrograms(env: DiscoveryEnv): DiscoveredProgram[] {
  const read = env.readText ?? readText;
  const ctx: PlaceholderContext = { home: env.home, platform: env.platform, env: env.env };
  const found: DiscoveredProgram[] = [];
  const files = discoveryFiles(env);
  // Claude Desktop's own config first, then its extensions, then the others.
  const [desktop, ...others] = files;
  for (const entry of [desktop!]) {
    const text = read(entry.file);
    if (text !== null) found.push(...programsIn(entry.source, entry.file, parse(entry.file, text), ctx));
  }
  found.push(...extensions(env, ctx));
  for (const entry of others) {
    const text = read(entry.file);
    if (text !== null) found.push(...programsIn(entry.source, entry.file, parse(entry.file, text), ctx));
  }
  return dedupe(found);
}
