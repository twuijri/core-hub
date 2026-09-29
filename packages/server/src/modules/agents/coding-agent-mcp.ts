/**
 * A coding agent's own MCP servers, on the agent's MCP page (the page Hermes has had since
 * §67/§122/§134, now for the coding agents whose file the hub knows).
 *
 * **The agent's own file, one set for every profile** — the rule of the Config files page
 * (`config-files.ts`, decision §78): a coding agent does not know Core Hub's profiles and reads
 * its servers from the home of the user it runs as, so the page edits that file and says so.
 * The files, checked in the pinned versions (the change record lists the evidence):
 *
 * - **Claude Code** — its user-scope servers, the `mcpServers` object of the global config
 *   `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set, or a legacy
 *   `.config.json` in the config folder when one exists). The ACP bridge
 *   (`@zed-industries/claude-code-acp` 0.16.2) runs Claude Code through its SDK with
 *   `settingSources: ["user", "project", "local"]`, and the CLI reads the user-scope servers on
 *   every session it starts. Claude Code itself rewrites that file (it keeps its state there),
 *   under a lock folder `<file>.lock`; the hub takes the same lock, reads the file again
 *   inside it, changes `mcpServers` only and renames a new file over it — so neither side's
 *   write is lost.
 * - **Gemini CLI** — `mcpServers` in `~/.gemini/settings.json` (`$GEMINI_CLI_HOME/.gemini`).
 * - **Qwen Code** — `mcpServers` in `~/.qwen/settings.json` (`$QWEN_HOME`).
 *
 * The other agents (Codex's TOML, Goose's `extensions`, OpenCode, Kimi, Grok, Pi) are not
 * edited here yet: their servers are in the settings file the Config files page edits, and
 * the MCP page says so (`mcp_not_managed`).
 *
 * **Switched off is kept by the hub.** None of these files has a per-server "off" (Claude
 * Code ignores unknown keys, Gemini's exclusion list moved between versions), so a server
 * switched off is taken out of the agent's file and kept in `<DATA_DIR>/agent-mcp/<agent>.json`
 * (0600) until it is switched back on. The agent never sees it meanwhile, which is what off
 * means.
 *
 * **The same care as Hermes's block** (`mcp.ts`): a credential reads as `[stored]` and
 * `[stored]` written back keeps it; a file that does not parse is never rewritten; a file with
 * comments is read but not rewritten (the comments would be lost); a link that leads out of
 * the home is not followed.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { stripJsonComments } from './config-files.js';
import {
  McpError,
  NAME,
  connectionFingerprint,
  mask,
  unmask,
  type McpServer,
  type Transport,
} from './mcp.js';

/** How a bare `url` (no `type`) is read: Claude Code's HTTP, Gemini's SSE (`httpUrl` is HTTP). */
type UrlDefault = 'http' | 'sse';

interface McpFileSpec {
  /** Where the file is, from the environment the hub hands its agents and the home. */
  locate(env: NodeJS.ProcessEnv, home: string): { file: string; display: string; dir: string };
  /** The agent strips comments before parsing (the file may carry them). */
  comments: boolean;
  /** The agent writes the file under a `<file>.lock` folder, and so must the hub. */
  lock: boolean;
  urlDefault: UrlDefault;
}

const variable = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? path.resolve(value) : undefined;
};

/** Keyed by the catalog id (the agent's slug). */
export const CODING_AGENT_MCP: Readonly<Record<string, McpFileSpec>> = {
  'claude-code': {
    // Claude Code's `getGlobalConfigPath`: a legacy `.config.json` in the config folder wins
    // when it exists; otherwise `.claude.json` in `$CLAUDE_CONFIG_DIR`, or in the home.
    locate(env, home) {
      const configDir = variable(env, 'CLAUDE_CONFIG_DIR');
      const folder = configDir ?? path.join(home, '.claude');
      const legacy = path.join(folder, '.config.json');
      if (existsSync(legacy)) {
        return {
          file: legacy,
          display: configDir ? '$CLAUDE_CONFIG_DIR/.config.json' : '~/.claude/.config.json',
          dir: folder,
        };
      }
      return configDir
        ? {
            file: path.join(configDir, '.claude.json'),
            display: '$CLAUDE_CONFIG_DIR/.claude.json',
            dir: configDir,
          }
        : { file: path.join(home, '.claude.json'), display: '~/.claude.json', dir: home };
    },
    comments: false,
    lock: true,
    urlDefault: 'http',
  },
  'gemini-cli': {
    locate(env, home) {
      const base = variable(env, 'GEMINI_CLI_HOME');
      const dir = path.join(base ?? home, '.gemini');
      return {
        file: path.join(dir, 'settings.json'),
        display: base ? '$GEMINI_CLI_HOME/.gemini/settings.json' : '~/.gemini/settings.json',
        dir,
      };
    },
    comments: true,
    lock: false,
    urlDefault: 'sse',
  },
  'qwen-code': {
    locate(env, home) {
      const base = variable(env, 'QWEN_HOME');
      const dir = base ?? path.join(home, '.qwen');
      return {
        file: path.join(dir, 'settings.json'),
        display: base ? '$QWEN_HOME/settings.json' : '~/.qwen/settings.json',
        dir,
      };
    },
    comments: true,
    lock: false,
    urlDefault: 'sse',
  },
};

/** Whether the hub edits this coding agent's MCP servers (by slug). */
export function managesCodingAgentMcp(slug: string): boolean {
  return Object.hasOwn(CODING_AGENT_MCP, slug);
}

const BLOCK = 'mcpServers';
/** A global config larger than this is not read (Claude Code's grows with its history). */
const MAX_BYTES = 32 * 1024 * 1024;
/** Claude Code's lock is stale after 10 s (proper-lockfile's default). */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

const isBlock = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function transportOf(config: Record<string, unknown>, urlDefault: UrlDefault): Transport {
  const type = String(config.type ?? '').toLowerCase();
  if (type === 'sse') return 'sse';
  if (type === 'http' || type === 'streamable-http' || type === 'streamable_http') return 'http';
  if (typeof config.httpUrl === 'string') return 'http';
  if (typeof config.url === 'string') return urlDefault;
  return 'stdio';
}

/** Blocks the synchronous thread for `ms` (a lock wait of a few milliseconds at a time). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface CodingAgentMcpOptions {
  /** The environment the hub hands its coding agents (their own variables, `HOME`). */
  env: NodeJS.ProcessEnv;
  /** The home, when not `env.HOME` (tests). */
  home?: string;
  dataDir: string;
}

interface Located {
  spec: McpFileSpec;
  file: string;
  display: string;
}

interface Parsed {
  /** The whole document; `null` when the file is absent. */
  doc: Record<string, unknown> | null;
  /** The file carries comments: readable, not rewritable. */
  commented: boolean;
  mode: number;
}

export class CodingAgentMcpStore {
  constructor(private readonly options: CodingAgentMcpOptions) {}

  private home(): string {
    return path.resolve(this.options.home ?? (this.options.env.HOME || homedir()));
  }

  private locate(slug: string): Located {
    const spec = Object.hasOwn(CODING_AGENT_MCP, slug) ? CODING_AGENT_MCP[slug] : undefined;
    if (!spec) throw new McpError('mcp_not_managed');
    const home = this.home();
    const { file, display, dir } = spec.locate(this.options.env, home);
    // A link is followed only while it stays inside the home or the agent's folder: one an
    // agent planted towards the hub's keys is refused, not read.
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
      const real = realpathSync(file);
      if (![home, dir].some((root) => inside(real, root))) {
        throw new McpError('symlink_outside');
      }
      return { spec, file: real, display };
    }
    return { spec, file, display };
  }

  /** The file the page edits, as the page shows it (`~/.claude.json`). */
  displayPath(slug: string): string {
    return this.locate(slug).display;
  }

  private parse(located: Located): Parsed {
    if (!existsSync(located.file)) return { doc: null, commented: false, mode: 0o600 };
    const stat = statSync(located.file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new McpError('config_unreadable');
    const text = readFileSync(located.file, 'utf8');
    const plain = located.spec.comments ? stripJsonComments(text) : text;
    if (plain.trim() === '') return { doc: {}, commented: false, mode: stat.mode & 0o777 };
    let doc: unknown;
    try {
      doc = JSON.parse(plain);
    } catch {
      // A config we cannot parse is a config we must not rewrite.
      throw new McpError('config_unreadable');
    }
    if (!isBlock(doc)) throw new McpError('config_unreadable');
    return { doc, commented: plain !== text, mode: stat.mode & 0o777 };
  }

  private parkedFile(slug: string): string {
    return path.join(this.options.dataDir, 'agent-mcp', `${slug}.json`);
  }

  /** The servers switched off, which the hub keeps out of the agent's file. */
  private parked(slug: string): Record<string, Record<string, unknown>> {
    const file = this.parkedFile(slug);
    if (!existsSync(file)) return {};
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { disabled?: unknown };
      if (!isBlock(doc.disabled)) return {};
      return Object.fromEntries(
        Object.entries(doc.disabled).filter((entry): entry is [string, Record<string, unknown>] =>
          isBlock(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  private savePark(slug: string, servers: Record<string, Record<string, unknown>>): void {
    const file = this.parkedFile(slug);
    if (Object.keys(servers).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeAtomically(file, `${JSON.stringify({ disabled: servers }, null, 2)}\n`, 0o600);
  }

  private view(
    name: string,
    config: Record<string, unknown>,
    enabled: boolean,
    spec: McpFileSpec,
  ): McpServer {
    return {
      name,
      transport: transportOf(config, spec.urlDefault),
      enabled,
      config: mask(config),
      oauth: false,
      toolFilter: { include: null, exclude: null },
      fingerprint: connectionFingerprint(config),
    };
  }

  list(slug: string): McpServer[] {
    const located = this.locate(slug);
    const { doc } = this.parse(located);
    const active = isBlock(doc?.[BLOCK]) ? doc[BLOCK] : {};
    const servers = new Map<string, McpServer>();
    for (const [name, config] of Object.entries(this.parked(slug))) {
      servers.set(name, this.view(name, config, false, located.spec));
    }
    // The agent's own file wins over a parked copy of the same name.
    for (const [name, config] of Object.entries(active)) {
      if (isBlock(config)) servers.set(name, this.view(name, config, true, located.spec));
    }
    return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(slug: string, name: string): McpServer | null {
    return this.list(slug).find((server) => server.name === name) ?? null;
  }

  /**
   * Change the agent's `mcpServers` by `change` (which answers the new block), inside the
   * agent's lock when it keeps one, reading the file again there; every other key of the
   * document is written back as it was read.
   */
  private edit(
    located: Located,
    change: (block: Record<string, Record<string, unknown>>) => void,
  ): void {
    const run = () => {
      const { doc, commented, mode } = this.parse(located);
      if (commented) throw new McpError('config_has_comments');
      const document = doc ?? {};
      const block: Record<string, Record<string, unknown>> = {};
      if (isBlock(document[BLOCK])) {
        for (const [name, config] of Object.entries(document[BLOCK])) {
          if (isBlock(config)) block[name] = config;
        }
      }
      change(block);
      const next = { ...document, [BLOCK]: block };
      mkdirSync(path.dirname(located.file), { recursive: true });
      writeAtomically(located.file, `${JSON.stringify(next, null, 2)}\n`, mode);
    };
    if (located.spec.lock) withLock(located.file, run);
    else run();
  }

  /** Create or replace one server; `enabled: false` keeps it out of the agent's file. */
  put(
    slug: string,
    name: string,
    input: { enabled?: boolean | undefined; config?: Record<string, unknown> | undefined },
    transport?: Transport,
  ): McpServer {
    if (!NAME.test(name)) throw new McpError('mcp_name_invalid');
    const located = this.locate(slug);
    const parked = this.parked(slug);
    const current = this.get(slug, name);
    const { doc } = this.parse(located);
    const active = isBlock(doc?.[BLOCK]) ? doc[BLOCK] : {};
    const previous: Record<string, unknown> =
      (isBlock(active[name]) ? active[name] : parked[name]) ?? {};
    let config = input.config ? unmask(input.config, previous) : { ...previous };
    // `enabled` is the switch, which lives in where the server is kept, not in its block.
    delete config.enabled;
    if (Object.keys(config).length === 0) throw new McpError('mcp_config_empty');
    // Claude Code reads a socket only with its `type`; the page names the transport.
    if (
      slug === 'claude-code' &&
      typeof config.url === 'string' &&
      config.type === undefined &&
      (transport === 'http' || transport === 'sse')
    ) {
      config = { type: transport, ...config };
    }
    const enabled = input.enabled ?? current?.enabled ?? true;
    if (enabled) {
      this.edit(located, (block) => {
        block[name] = config;
      });
      if (name in parked) {
        delete parked[name];
        this.savePark(slug, parked);
      }
    } else {
      parked[name] = config;
      this.savePark(slug, parked);
      if (isBlock(active[name])) {
        this.edit(located, (block) => {
          delete block[name];
        });
      }
    }
    const written = this.get(slug, name);
    if (!written) throw new McpError('mcp_write_failed');
    return written;
  }

  delete(slug: string, name: string): void {
    if (!NAME.test(name)) throw new McpError('mcp_name_invalid');
    const located = this.locate(slug);
    const parked = this.parked(slug);
    const { doc } = this.parse(located);
    const active = isBlock(doc?.[BLOCK]) ? doc[BLOCK] : {};
    if (!(name in active) && !(name in parked)) throw new McpError('mcp_not_found');
    if (name in active) {
      this.edit(located, (block) => {
        delete block[name];
      });
    }
    if (name in parked) {
      delete parked[name];
      this.savePark(slug, parked);
    }
  }
}

/** A new file beside the target, renamed over it, keeping the target's mode. */
function writeAtomically(file: string, content: string, mode: number): void {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.corehub-${randomBytes(4).toString('hex')}`,
  );
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode });
    chmodSync(temp, mode);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Claude Code's own lock on its global config: a folder `<file>.lock`, made atomically, stale
 * after ten seconds. The hub waits for it a few seconds at most, then says the file is busy.
 */
function withLock(file: string, work: () => void): void {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > deadline) throw new McpError('config_busy');
      pause(50);
    }
  }
  try {
    work();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already gone (a stale-lock sweep by the agent): nothing to release.
    }
  }
}
