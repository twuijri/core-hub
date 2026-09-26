/**
 * Programs on this computer (ADR 0025): the MCP servers other assistants registered, read from
 * their own configuration files, and what it takes to run one.
 *
 * Pure: the readers in `main/discovery.ts` hand the parsed files here; this file decides what
 * each entry is, fills the placeholders it can, and names the settings it cannot fill. Nothing
 * here starts a program.
 *
 * Sources (their public documentation): Claude Desktop's `claude_desktop_config.json` and its
 * installed extensions (`.mcpb`/`.dxt` bundles unpacked under "Claude Extensions", each with a
 * `manifest.json`), Claude Code's `~/.claude.json`, Codex's `~/.codex/config.toml`, Cursor's
 * `~/.cursor/mcp.json` and Windsurf's `~/.codeium/windsurf/mcp_config.json`.
 */
import path from 'node:path';

export const PROGRAM_SOURCES = [
  'claude_desktop',
  'claude_desktop_extension',
  'claude_code',
  'codex',
  'cursor',
  'windsurf',
] as const;
export type ProgramSource = (typeof PROGRAM_SOURCES)[number];

/** A setting only the person can give (an API key the original assistant asked them for). */
export interface ProgramField {
  key: string;
  title: string;
  description: string | null;
  /** Kept sealed, never shown again once saved. */
  sensitive: boolean;
  required: boolean;
}

export interface DiscoveredProgram {
  /** Stable across scans: from the name, unique on this computer. */
  id: string;
  name: string;
  source: ProgramSource;
  /** The file it was found in. */
  origin: string;
  /**
   * `ready`: can be started; `needs_setup`: some `fields` have no value yet; `remote`: a URL
   * server, listed but not passed through (not in this version); `invalid`: no command.
   */
  kind: 'stdio' | 'remote' | 'invalid';
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  /** The settings its registration leaves to the person, with `{{field:key}}` in their place. */
  fields: ProgramField[];
  /** What the program says it does, when its manifest says. */
  description: string | null;
}

/** What the platform-specific folders are, for the placeholders a manifest may use. */
export interface PlaceholderContext {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Only for an extension: its own folder. */
  dirname?: string;
  /** Values the original assistant stored for the extension (non-secret ones only). */
  stored?: Record<string, unknown>;
}

const FIELD_MARK = (key: string) => `{{field:${key}}}`;
const FIELD_PATTERN = /\{\{field:([^}]+)\}\}/g;

/** A program id: lower-case letters, digits, `-` and `_`, starting with a letter or digit. */
export function slug(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  return cleaned || 'program';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function envOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return out;
}

function userFolder(ctx: PlaceholderContext, name: 'Desktop' | 'Documents' | 'Downloads'): string {
  return path.join(ctx.home, name);
}

/**
 * Fills the placeholders one string may hold. What cannot be filled becomes a field of the
 * program, marked in the string so the value is put there when the person gives it.
 *
 * - An extension's manifest: `${__dirname}`, `${HOME}`, `${DESKTOP}`, `${DOCUMENTS}`,
 *   `${DOWNLOADS}`, `${pathSeparator}` / `${/}`, and `${user_config.<key>}` (the person's
 *   settings for it in Claude Desktop).
 * - Claude Code: `${VAR}` and `${VAR:-default}` from the environment.
 * - Cursor: `${env:VAR}` and `${userHome}`.
 */
export function fillPlaceholders(
  value: string,
  ctx: PlaceholderContext,
  fields: Map<string, ProgramField>,
  userConfig: Record<string, unknown> = {},
): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, inner: string) => {
    const name = inner.trim();
    switch (name) {
      case '__dirname':
        return ctx.dirname ?? whole;
      case 'HOME':
      case 'userHome':
        return ctx.home;
      case 'DESKTOP':
        return userFolder(ctx, 'Desktop');
      case 'DOCUMENTS':
        return userFolder(ctx, 'Documents');
      case 'DOWNLOADS':
        return userFolder(ctx, 'Downloads');
      case 'pathSeparator':
      case '/':
        return ctx.platform === 'win32' ? '\\' : '/';
    }
    if (name.startsWith('user_config.')) {
      const key = name.slice('user_config.'.length);
      const spec = isRecord(userConfig[key]) ? userConfig[key] : {};
      const stored = ctx.stored?.[key];
      const sensitive = spec.sensitive === true;
      // A value the person already gave the original assistant, unless it is a secret: a
      // secret Core Hub keeps only once the person gives it here.
      if (!sensitive && (typeof stored === 'string' || typeof stored === 'number')) {
        return String(stored);
      }
      if (!sensitive && stored === undefined && spec.default !== undefined) {
        return fillPlaceholders(String(spec.default), ctx, fields, userConfig);
      }
      if (!fields.has(key)) {
        fields.set(key, {
          key,
          title: typeof spec.title === 'string' ? spec.title : key,
          description: typeof spec.description === 'string' ? spec.description : null,
          sensitive,
          required: spec.required !== false,
        });
      }
      return FIELD_MARK(key);
    }
    const envName = name.startsWith('env:') ? name.slice(4) : name;
    const [variable, fallback] = envName.split(':-', 2) as [string, string | undefined];
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      const found = ctx.env[variable];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      if (!fields.has(variable)) {
        fields.set(variable, {
          key: variable,
          title: variable,
          description: null,
          sensitive: /key|token|secret|password/i.test(variable),
          required: true,
        });
      }
      return FIELD_MARK(variable);
    }
    return whole;
  });
}

/** One `mcpServers`-style entry (Claude Desktop, Claude Code, Cursor, Windsurf, Codex). */
export function fromServerEntry(
  name: string,
  entry: unknown,
  source: ProgramSource,
  origin: string,
  ctx: PlaceholderContext,
): DiscoveredProgram | null {
  if (!isRecord(entry)) return null;
  // Switched off where it was registered: not offered here either.
  if (entry.disabled === true || entry.enabled === false) return null;
  const fields = new Map<string, ProgramField>();
  const fill = (value: string) => fillPlaceholders(value, ctx, fields);
  const url = typeof entry.url === 'string' ? entry.url : null;
  const type = typeof entry.type === 'string' ? entry.type : null;
  const command = typeof entry.command === 'string' && entry.command.trim() ? entry.command : null;
  const base = {
    id: slug(name),
    name,
    source,
    origin,
    description: null,
  };
  if (!command && (url || type === 'http' || type === 'sse' || type === 'streamable-http')) {
    return {
      ...base,
      kind: 'remote',
      command: null,
      args: [],
      env: {},
      cwd: null,
      fields: [],
    };
  }
  if (!command)
    return { ...base, kind: 'invalid', command: null, args: [], env: {}, cwd: null, fields: [] };
  const env = Object.fromEntries(
    Object.entries(envOf(entry.env)).map(([key, value]) => [key, fill(value)]),
  );
  return {
    ...base,
    kind: 'stdio',
    command: fill(command),
    args: strings(entry.args).map(fill),
    env,
    cwd: typeof entry.cwd === 'string' ? fill(entry.cwd) : null,
    fields: [...fields.values()],
  };
}

/** An `mcpServers` object (or Codex's `mcp_servers` table). */
export function fromServerMap(
  servers: unknown,
  source: ProgramSource,
  origin: string,
  ctx: PlaceholderContext,
): DiscoveredProgram[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers)
    .map(([name, entry]) => fromServerEntry(name, entry, source, origin, ctx))
    .filter((p): p is DiscoveredProgram => p !== null);
}

/**
 * A Claude Desktop extension, from its unpacked `manifest.json` (the MCP Bundle format): its
 * `server.mcp_config` (with the platform's override merged in), the person's `user_config`
 * settings it needs, and its display name.
 */
export function fromExtension(
  manifest: unknown,
  folder: string,
  settings: unknown,
  ctx: PlaceholderContext,
): DiscoveredProgram | null {
  if (!isRecord(manifest)) return null;
  const stored = isRecord(settings) ? settings : {};
  if (stored.isEnabled === false) return null;
  const platforms = isRecord(manifest.compatibility)
    ? strings(manifest.compatibility.platforms)
    : [];
  if (platforms.length > 0 && !platforms.includes(ctx.platform)) return null;
  const server = isRecord(manifest.server) ? manifest.server : {};
  const config = isRecord(server.mcp_config) ? server.mcp_config : {};
  const overrides = isRecord(config.platform_overrides) ? config.platform_overrides : {};
  const chosen = overrides[ctx.platform];
  const override: Record<string, unknown> = isRecord(chosen) ? chosen : {};
  const merged = {
    command: override.command ?? config.command,
    args: override.args ?? config.args,
    env: { ...envOf(config.env), ...envOf(override.env) },
  };
  const userConfig = isRecord(manifest.user_config) ? manifest.user_config : {};
  const fields = new Map<string, ProgramField>();
  const withCtx: PlaceholderContext = {
    ...ctx,
    dirname: folder,
    stored: isRecord(stored.userConfig) ? stored.userConfig : {},
  };
  const fill = (value: string) => fillPlaceholders(value, withCtx, fields, userConfig);
  const name =
    typeof manifest.display_name === 'string' && manifest.display_name.trim()
      ? manifest.display_name
      : typeof manifest.name === 'string'
        ? manifest.name
        : path.basename(folder);
  const description =
    typeof manifest.description === 'string' ? manifest.description.slice(0, 500) : null;
  const command = typeof merged.command === 'string' ? merged.command : null;
  const base = {
    id: slug(name),
    name,
    source: 'claude_desktop_extension' as const,
    origin: path.join(folder, 'manifest.json'),
    description,
  };
  if (!command)
    return { ...base, kind: 'invalid', command: null, args: [], env: {}, cwd: null, fields: [] };
  return {
    ...base,
    kind: 'stdio',
    command: fill(command),
    args: strings(merged.args).map(fill),
    env: Object.fromEntries(Object.entries(merged.env).map(([k, v]) => [k, fill(v)])),
    cwd: folder,
    fields: [...fields.values()],
  };
}

/**
 * The same server registered in two assistants is listed once (the first source wins), and
 * two different programs never share an id.
 */
export function dedupe(programs: DiscoveredProgram[]): DiscoveredProgram[] {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: DiscoveredProgram[] = [];
  for (const program of programs) {
    const signature =
      program.kind === 'stdio'
        ? JSON.stringify([program.command, program.args])
        : `${program.kind}:${program.source}:${program.name}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    let id = program.id;
    for (let n = 2; ids.has(id); n += 1) id = `${program.id.slice(0, 40)}-${n}`;
    ids.add(id);
    out.push({ ...program, id });
  }
  return out;
}

/** The fields still without a value; a program with none missing can start. */
export function missingFields(
  program: Pick<DiscoveredProgram, 'fields'>,
  values: Record<string, string>,
): string[] {
  return program.fields
    .filter((field) => field.required && !values[field.key])
    .map((field) => field.key);
}

/** The launch with the person's values put in; null when one is still missing. */
export function launchOf(
  program: DiscoveredProgram,
  values: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | null {
  if (program.kind !== 'stdio' || !program.command) return null;
  if (missingFields(program, values).length > 0) return null;
  // An optional setting left empty is put in as nothing, as the original assistant would.
  const put = (text: string) =>
    text.replace(FIELD_PATTERN, (_whole, key: string) => values[key] ?? '');
  const launch = {
    command: put(program.command),
    args: program.args.map(put),
    env: Object.fromEntries(Object.entries(program.env).map(([k, v]) => [k, put(v)])),
    cwd: program.cwd ? put(program.cwd) : null,
  };
  return launch;
}

/** Whether a program is DaVinci Resolve's integration (by what it calls itself). */
export function isResolve(program: Pick<DiscoveredProgram, 'name' | 'description'>): boolean {
  return /davinci|resolve/i.test(`${program.name} ${program.description ?? ''}`);
}

/**
 * The name a program's tool takes in this computer's helper (local mode): `<program>__<tool>`,
 * kept to 64 characters of letters, digits, `_` and `-`, which every model provider accepts.
 */
export function helperToolName(programId: string, tool: string): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe(programId)}__${safe(tool)}`.slice(0, 64);
}
