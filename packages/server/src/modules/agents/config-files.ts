/**
 * A coding agent's own config files (contract decision §77): its instructions file and its
 * settings file, edited from the web by an admin.
 *
 * **One set for every profile.** A coding agent does not know Core Hub's profiles: it reads
 * its files from the home of the user it runs as, and the hub runs every coding agent as
 * itself (`adapters/acp.ts` hands the agent the hub's own environment). So the files are the
 * hub user's — `~/.claude/CLAUDE.md` is the same file whichever profile a conversation is in,
 * and the page says so. (In the image the home is `/data/home`, inside the volume, so an edit
 * survives an upgrade; on the desktop it is the person's own home.)
 *
 * **A fixed list per agent, nothing else.** A `file_key` names one entry of `CONFIG_FILES`;
 * there is no path in any request, so there is nothing to traverse. The entries are what the
 * pinned versions actually read, checked in their packages (the change record lists the
 * evidence): Claude Code's bridge loads user settings (`settingSources: ["user", …]`) from
 * `CLAUDE_CONFIG_DIR` or `~/.claude`; Codex reads `CODEX_HOME` or `~/.codex`; Gemini CLI
 * `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`; Qwen Code `QWEN_HOME` or `~/.qwen`; Kimi Code
 * `KIMI_CODE_HOME` or `~/.kimi-code`; Pi `PI_CODING_AGENT_DIR` or `~/.pi/agent`. OpenCode is
 * not listed: its files were not verified. Each agent's own variable is honoured, from the
 * environment the hub hands its agents, so the page edits the file the agent will read.
 *
 * **What a write does.** The `revision` read must still be the file's (a hash of its bytes) or
 * nothing is written; a JSON file must parse (with comments where the agent strips them); at
 * most 1 MiB of UTF-8. The previous bytes are kept under `<DATA_DIR>/backups/agent-config/`
 * (the newest ten per file), the new ones are written to a temporary file beside the target
 * and renamed over it, keeping its mode (`0600` for a new one). A file — or a folder on the
 * way — that is a link is followed only while its real path stays inside the agent's folder
 * or the home: a link an agent planted towards the hub's keys is refused, not read.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 1 MiB, the contract's `ConfigFileWrite.content` ceiling. */
export const CONFIG_FILE_MAX_BYTES = 1024 * 1024;
/** Backups kept per file. */
export const CONFIG_FILE_BACKUPS = 10;

export type ConfigFileLanguage = 'markdown' | 'json' | 'toml';

interface Folder {
  /** The agent's own variable that moves the folder, or `null`. */
  variable: string | null;
  /** `folder`: the variable is the folder itself; `home`: it replaces the home above it. */
  replaces: 'folder' | 'home';
  /** The folder under the home, as segments. */
  under: readonly string[];
}

export interface ConfigFileSpec {
  key: 'instructions' | 'settings';
  label: { ar: string; en: string };
  name: string;
  language: ConfigFileLanguage;
  /** For `json`: whether the agent strips comments before parsing. */
  comments?: boolean;
}

interface AgentFiles {
  folder: Folder;
  files: readonly ConfigFileSpec[];
}

const INSTRUCTIONS = { ar: 'التعليمات', en: 'Instructions' } as const;
const SETTINGS = { ar: 'الإعدادات', en: 'Settings' } as const;

/** Keyed by the catalog id (the agent's slug). */
export const CONFIG_FILES: Readonly<Record<string, AgentFiles>> = {
  'claude-code': {
    folder: { variable: 'CLAUDE_CONFIG_DIR', replaces: 'folder', under: ['.claude'] },
    files: [
      { key: 'instructions', label: INSTRUCTIONS, name: 'CLAUDE.md', language: 'markdown' },
      { key: 'settings', label: SETTINGS, name: 'settings.json', language: 'json' },
    ],
  },
  codex: {
    folder: { variable: 'CODEX_HOME', replaces: 'folder', under: ['.codex'] },
    files: [
      { key: 'instructions', label: INSTRUCTIONS, name: 'AGENTS.md', language: 'markdown' },
      { key: 'settings', label: SETTINGS, name: 'config.toml', language: 'toml' },
    ],
  },
  'gemini-cli': {
    folder: { variable: 'GEMINI_CLI_HOME', replaces: 'home', under: ['.gemini'] },
    files: [
      { key: 'instructions', label: INSTRUCTIONS, name: 'GEMINI.md', language: 'markdown' },
      {
        key: 'settings',
        label: SETTINGS,
        name: 'settings.json',
        language: 'json',
        comments: true,
      },
    ],
  },
  'qwen-code': {
    folder: { variable: 'QWEN_HOME', replaces: 'folder', under: ['.qwen'] },
    files: [
      { key: 'instructions', label: INSTRUCTIONS, name: 'QWEN.md', language: 'markdown' },
      {
        key: 'settings',
        label: SETTINGS,
        name: 'settings.json',
        language: 'json',
        comments: true,
      },
    ],
  },
  'kimi-code': {
    folder: { variable: 'KIMI_CODE_HOME', replaces: 'folder', under: ['.kimi-code'] },
    files: [
      { key: 'instructions', label: INSTRUCTIONS, name: 'AGENTS.md', language: 'markdown' },
      { key: 'settings', label: SETTINGS, name: 'config.toml', language: 'toml' },
    ],
  },
  pi: {
    folder: { variable: 'PI_CODING_AGENT_DIR', replaces: 'folder', under: ['.pi', 'agent'] },
    files: [
      { key: 'instructions', label: INSTRUCTIONS, name: 'AGENTS.md', language: 'markdown' },
      { key: 'settings', label: SETTINGS, name: 'settings.json', language: 'json' },
    ],
  },
};

/** Whether an agent (by slug) has config files the hub edits. */
export function hasConfigFiles(slug: string): boolean {
  return Object.hasOwn(CONFIG_FILES, slug);
}

export type ConfigFileFault =
  | { kind: 'unknown' }
  | { kind: 'symlink_outside' }
  | { kind: 'too_large'; limit: number }
  | { kind: 'not_text' }
  | { kind: 'changed'; revision: string | null }
  | { kind: 'invalid_json'; message: string };

export class ConfigFileError extends Error {
  constructor(readonly fault: ConfigFileFault) {
    super(fault.kind);
    this.name = 'ConfigFileError';
  }
}

/** The contract's `ConfigFile`. */
export interface ConfigFileView {
  key: string;
  label: { ar: string; en: string };
  path: string;
  language: ConfigFileLanguage;
  exists: boolean;
  size_bytes: number;
  revision: string | null;
  updated_at: string | null;
  content: string | null;
}

export interface ConfigFileStoreOptions {
  /** The environment the hub hands its coding agents (the agents' own variables, `HOME`). */
  env: NodeJS.ProcessEnv;
  /** The home, when not `env.HOME` (tests). */
  home?: string;
  dataDir: string;
  now?: () => Date;
}

export function revisionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The nearest existing ancestor's real path, with what is still missing below it. */
function realParts(target: string): { real: string; missing: string[] } {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return { real: realpathSync(current), missing };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { real: current, missing };
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * JSON with `//` and `/* *\/` comments, as the agents that allow them read it (they strip the
 * comments and parse what is left): the comments are blanked outside strings, then parsed.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      if (i < text.length) out += '\n';
    } else if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 1;
    } else out += char;
  }
  return out;
}

export class ConfigFileStore {
  private readonly now: () => Date;

  constructor(private readonly options: ConfigFileStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private home(): string {
    return path.resolve(this.options.home ?? (this.options.env.HOME || homedir()));
  }

  /** The agent's folder, its display prefix, and the roots a real path may stay inside. */
  private folderOf(folder: Folder): { dir: string; display: string; roots: string[] } {
    const home = this.home();
    const value = folder.variable ? this.options.env[folder.variable]?.trim() : undefined;
    let dir: string;
    let display: string;
    if (value && folder.replaces === 'folder') {
      dir = path.resolve(value);
      display = `$${folder.variable}`;
    } else if (value && folder.replaces === 'home') {
      dir = path.join(path.resolve(value), ...folder.under);
      display = `$${folder.variable}/${folder.under.join('/')}`;
    } else {
      dir = path.join(home, ...folder.under);
      display = `~/${folder.under.join('/')}`;
    }
    const roots = [home, dir].map((root) => realParts(root)).map(({ real, missing }) =>
      path.join(real, ...missing),
    );
    return { dir, display, roots };
  }

  private spec(slug: string, key: string): { agent: AgentFiles; file: ConfigFileSpec } {
    const agent = Object.hasOwn(CONFIG_FILES, slug) ? CONFIG_FILES[slug] : undefined;
    const file = agent?.files.find((entry) => entry.key === key);
    if (!agent || !file) throw new ConfigFileError({ kind: 'unknown' });
    return { agent, file };
  }

  /**
   * Where the bytes really are: the path the agent reads, or — when it is a link that stays
   * inside the roots — the file the link names. Refused when the real path leaves them.
   */
  private locate(slug: string, key: string) {
    const { agent, file } = this.spec(slug, key);
    const folder = this.folderOf(agent.folder);
    const target = path.join(folder.dir, file.name);
    const { real, missing } = realParts(target);
    const resolved = path.join(real, ...missing);
    if (!folder.roots.some((root) => inside(resolved, root))) {
      throw new ConfigFileError({ kind: 'symlink_outside' });
    }
    return { file, target, resolved, display: `${folder.display}/${file.name}`, folder };
  }

  private view(
    file: ConfigFileSpec,
    display: string,
    resolved: string,
    content: string | null,
  ): ConfigFileView {
    let exists = false;
    let size = 0;
    let updated: string | null = null;
    let revision: string | null = null;
    try {
      const stat = statSync(resolved);
      if (stat.isFile()) {
        exists = true;
        size = stat.size;
        updated = stat.mtime.toISOString();
        if (size <= CONFIG_FILE_MAX_BYTES) revision = revisionOf(readFileSync(resolved));
      }
    } catch {
      // absent
    }
    return {
      key: file.key,
      label: { ...file.label },
      path: display,
      language: file.language,
      exists,
      size_bytes: size,
      revision,
      updated_at: updated,
      content,
    };
  }

  list(slug: string): ConfigFileView[] {
    const agent = Object.hasOwn(CONFIG_FILES, slug) ? CONFIG_FILES[slug] : undefined;
    if (!agent) return [];
    return agent.files.map((file) => {
      try {
        const located = this.locate(slug, file.key);
        return this.view(file, located.display, located.resolved, null);
      } catch (error) {
        if (!(error instanceof ConfigFileError)) throw error;
        // Listed, but empty: reading or writing it says why.
        const folder = this.folderOf(agent.folder);
        return {
          key: file.key,
          label: { ...file.label },
          path: `${folder.display}/${file.name}`,
          language: file.language,
          exists: false,
          size_bytes: 0,
          revision: null,
          updated_at: null,
          content: null,
        };
      }
    });
  }

  read(slug: string, key: string): ConfigFileView {
    const located = this.locate(slug, key);
    let bytes: Buffer | null = null;
    try {
      const stat = statSync(located.resolved);
      if (stat.isFile()) {
        if (stat.size > CONFIG_FILE_MAX_BYTES) {
          throw new ConfigFileError({ kind: 'too_large', limit: CONFIG_FILE_MAX_BYTES });
        }
        bytes = readFileSync(located.resolved);
      }
    } catch (error) {
      if (error instanceof ConfigFileError) throw error;
    }
    const content = bytes === null ? '' : decodeText(bytes);
    return this.view(located.file, located.display, located.resolved, content);
  }

  write(
    slug: string,
    key: string,
    input: { content: string; revision: string | null },
  ): { view: ConfigFileView; previous: string | null; backup: boolean } {
    const located = this.locate(slug, key);
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.length > CONFIG_FILE_MAX_BYTES) {
      throw new ConfigFileError({ kind: 'too_large', limit: CONFIG_FILE_MAX_BYTES });
    }
    if (located.file.language === 'json') {
      try {
        JSON.parse(located.file.comments ? stripJsonComments(input.content) : input.content);
      } catch (error) {
        throw new ConfigFileError({
          kind: 'invalid_json',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let previous: Buffer | null = null;
    let mode = 0o600;
    try {
      const stat = statSync(located.resolved);
      if (stat.isFile()) {
        if (stat.size > CONFIG_FILE_MAX_BYTES) {
          throw new ConfigFileError({ kind: 'too_large', limit: CONFIG_FILE_MAX_BYTES });
        }
        previous = readFileSync(located.resolved);
        mode = stat.mode & 0o777;
      }
    } catch (error) {
      if (error instanceof ConfigFileError) throw error;
    }
    const current = previous ? revisionOf(previous) : null;
    if (current !== input.revision) {
      throw new ConfigFileError({ kind: 'changed', revision: current });
    }
    const directory = path.dirname(located.resolved);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A folder made just now through a link must still land inside the roots.
    const made = realpathSync(directory);
    if (!located.folder.roots.some((root) => inside(made, root))) {
      throw new ConfigFileError({ kind: 'symlink_outside' });
    }
    if (previous) this.backup(slug, key, previous);
    const temporary = path.join(
      made,
      `.${path.basename(located.resolved)}.corehub-${randomBytes(6).toString('hex')}`,
    );
    try {
      writeFileSync(temporary, bytes, { mode, flag: 'wx' });
      chmodSync(temporary, mode);
      renameSync(temporary, path.join(made, path.basename(located.resolved)));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return {
      view: this.view(located.file, located.display, located.resolved, input.content),
      previous: current,
      backup: previous !== null,
    };
  }

  /** The folder the backups of one file go to. */
  backupDir(slug: string, key: string): string {
    return path.join(this.options.dataDir, 'backups', 'agent-config', slug, key);
  }

  private backup(slug: string, key: string, bytes: Buffer): void {
    const dir = this.backupDir(slug, key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    writeFileSync(path.join(dir, `${stamp}-${revisionOf(bytes).slice(0, 12)}`), bytes, {
      mode: 0o600,
    });
    const kept = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && lstatSync(path.join(dir, name)).isFile())
      .sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - CONFIG_FILE_BACKUPS))) {
      rmSync(path.join(dir, old), { force: true });
    }
  }

  /** Whether a home exists to write into; made when missing (the image's `/data/home`). */
  ensureHome(): void {
    const home = this.home();
    if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  }
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigFileError({ kind: 'not_text' });
  }
}
