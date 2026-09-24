/**
 * An agent's skills, which are **folders on disk**, not rows in our database.
 *
 * Hermes keeps them under `${HERMES_HOME}/skills/<key>/SKILL.md`, with a YAML front
 * matter block naming the skill and describing it. That is the format Hermes reads at
 * start-up, so it is the format this hub writes: a skill added here is a skill the agent
 * has, without an import step and without a second copy that can disagree with the first.
 *
 * **We do not own this directory.** The person may have put skills there by hand, or a
 * pack may have installed a dozen, and both must survive a round trip through our screen.
 * So a write stores the document **verbatim** — the contract's `SkillWrite` carries the
 * whole file for exactly this reason, and a hub that re-serialised the front matter would
 * be the thing that lost a pack's `metadata`, its licence and its prerequisites. The hub
 * reads those fields; it never rewrites them.
 *
 * A file that does not parse is listed as broken rather than skipped — a skill that
 * silently vanishes from a list is worse than one that says it cannot be read.
 *
 * **Disabling is a rename, not a delete.** `SKILL.md` → `SKILL.md.off` leaves every byte
 * in place and takes the skill out of the agent's reach, which is what "off" should mean
 * and what makes "on" free.
 *
 * **Categories are folders, as Hermes reads them** (`tools/skills_tool.py` §_find_all_skills
 * and §_get_category_from_path, `agent/skill_utils.py` §iter_skill_index_files, tag
 * v2026.9.14): a folder under `skills/` without a `SKILL.md` of its own is a category, every
 * skill below it (`skills/<category>/<name>/SKILL.md`, deeper too) belongs to it, and its
 * `DESCRIPTION.md` describes it. That is where Hermes seeds its built-in skills. Hermes skips
 * the same folders here (`.hub`, `.git`, `node_modules` …, a skill's own `references/`,
 * `scripts/` …), and names each skill after its folder.
 *
 * **Hermes's own skills are read-only here.** A skill Hermes copied from its bundle is named
 * in `skills/.bundled_manifest` (`name:hash` per line), and Hermes updates it from there as
 * long as its bytes still match the bundle (`tools/skills_sync.py`). Renaming its `SKILL.md`
 * or rewriting it from this screen would be the hub quietly forking Hermes's copy, so those
 * are listed, readable and pinnable, and refused (`skill_bundled`) for anything else.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const SKILL_FILE = 'SKILL.md';
/** Hermes ignores anything that is not `SKILL.md`, which is what makes this a switch. */
export const DISABLED_SUFFIX = '.off';

/** A key is a directory name, so it may not escape the skills directory. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** What a lookup accepts: a folder Hermes made may be longer than one the hub creates. */
const LOOKUP_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Where Hermes records the skills it seeded from its bundle. */
export const BUNDLED_MANIFEST = '.bundled_manifest';
/** The folder describing a category, beside its skills. */
export const CATEGORY_DESCRIPTION = 'DESCRIPTION.md';
/** Folders Hermes never looks into for skills (`agent/skill_utils.py` §EXCLUDED_SKILL_DIRS). */
const EXCLUDED = new Set([
  '.git',
  '.github',
  '.hub',
  '.archive',
  '.curator_backups',
  '.venv',
  'venv',
  'node_modules',
  'site-packages',
  '__pycache__',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  // Organisation mirrors are token-gated in Hermes; the hub does not hold the token.
  '_org',
]);
/** A skill's own support folders are not categories (`SKILL_SUPPORT_DIRS`). */
const SUPPORT = new Set(['references', 'templates', 'assets', 'scripts']);
/** Hermes walks the whole tree; four levels is every layout it ships and then some. */
const MAX_DEPTH = 4;

export interface Skill {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** The pack it came from (`metadata.hermes.source`), or null when somebody wrote it. */
  pack: string | null;
  version: string | null;
  updatedAt: Date;
  /**
   * The **whole document**, front matter and all; null in a listing, read on demand.
   *
   * The same text `putSkill` takes, deliberately: an editor that was handed the body
   * alone would write the body alone, and every save would delete the front matter the
   * agent reads. Read and write are the same document or they are a data-loss bug.
   */
  content: string | null;
  /** Set when the file is there but unreadable, so the row can say why. */
  broken: string | null;
  /** The category folder it lives in (`skills/<category>/…`), or null directly under `skills/`. */
  category: string | null;
  /** Hermes seeded it from its bundle (`.bundled_manifest`): read-only through the hub. */
  bundled: boolean;
}

export function skillsDir(home: string): string {
  return path.join(home, 'skills');
}

/**
 * A minimal front-matter reader.
 *
 * Deliberately not a YAML parser: this file must never execute what it reads, and the
 * four fields a listing needs are all scalars at the top level. Anything nested — the
 * `metadata.hermes` block, `prerequisites` — is kept verbatim as text and written back
 * unchanged, because the hub does not understand it and has no business reshaping it.
 */
export function parseFrontMatter(text: string): {
  fields: Map<string, string>;
  raw: string;
  body: string;
} {
  if (!text.startsWith('---')) return { fields: new Map(), raw: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fields: new Map(), raw: '', body: text };
  const raw = text.slice(text.indexOf('\n') + 1, end + 1);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    // Top level only: an indented line belongs to a block this reader does not open.
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const value = (match[2] ?? '').trim();
    if (value === '') continue;
    fields.set(match[1] ?? '', unquote(value));
  }
  return { fields, raw, body };
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/s.exec(value) ?? /^'(.*)'$/s.exec(value);
  return quoted ? (quoted[1] ?? '') : value;
}

/** `metadata.hermes.source: markdown-viewer/skills` → `markdown-viewer`. */
function packOf(raw: string): string | null {
  const match = /^\s*source:\s*(.+)$/m.exec(raw);
  if (!match) return null;
  const source = unquote((match[1] ?? '').trim());
  const first = source.split('/')[0]?.trim();
  return first && first !== '' ? first : null;
}

/** Where one skill lives, as the walk found it. */
interface Located {
  key: string;
  /** Absolute path of the skill's folder. */
  folder: string;
  category: string | null;
}

function hasSkillFile(folder: string): boolean {
  return (
    existsSync(path.join(folder, SKILL_FILE)) ||
    existsSync(path.join(folder, SKILL_FILE + DISABLED_SUFFIX))
  );
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          !entry.name.startsWith('.') &&
          !EXCLUDED.has(entry.name),
      )
      .map((entry) => entry.name)
      .filter((name) => isDirectory(path.join(dir, name)))
      .sort();
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every skill folder under `skills/`, in Hermes's order: a folder with a `SKILL.md` is a skill
 * (and is not looked into), one without is a category whose skills are below it. Two folders
 * with the same name: the first wins, as the first skill of a name wins in Hermes.
 */
function walk(home: string): Located[] {
  const root = skillsDir(home);
  const found: Located[] = [];
  const seen = new Set<string>();
  const add = (key: string, folder: string, category: string | null) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ key, folder, category });
  };
  const descend = (dir: string, category: string, depth: number) => {
    for (const name of subfolders(dir)) {
      const folder = path.join(dir, name);
      if (hasSkillFile(folder)) add(name, folder, category);
      else if (depth < MAX_DEPTH && !SUPPORT.has(name)) descend(folder, category, depth + 1);
    }
  };
  if (!existsSync(root)) return found;
  const top = subfolders(root);
  // Skills directly under `skills/` first: those are the ones the hub has always written, and a
  // category folder must not shadow one.
  for (const name of top) {
    const folder = path.join(root, name);
    if (hasSkillFile(folder)) add(name, folder, null);
  }
  for (const name of top) {
    const folder = path.join(root, name);
    if (!hasSkillFile(folder)) descend(folder, name, 2);
  }
  return found;
}

/** The names Hermes seeded from its bundle. Empty when it never did. */
export function bundledNames(home: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(path.join(skillsDir(home), BUNDLED_MANIFEST), 'utf8');
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split('\n')
      .map((line) => (line.split(':')[0] ?? '').trim())
      .filter((name) => name !== ''),
  );
}

function readOne(where: Located, bundled: ReadonlySet<string>): Skill | null {
  const { key, folder, category } = where;
  const enabledPath = path.join(folder, SKILL_FILE);
  const disabledPath = enabledPath + DISABLED_SUFFIX;
  const file = existsSync(enabledPath)
    ? enabledPath
    : existsSync(disabledPath)
      ? disabledPath
      : null;
  // A directory with no SKILL.md is not a skill — it is somebody's folder.
  if (!file) return null;
  const enabled = file === enabledPath;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      key,
      name: key,
      description: null,
      enabled,
      pack: null,
      version: null,
      updatedAt: new Date(0),
      content: null,
      broken: error instanceof Error ? error.message : 'unreadable',
      category,
      bundled: bundled.has(key),
    };
  }
  const { fields, raw } = parseFrontMatter(text);
  const name = fields.get('name') ?? key;
  return {
    key,
    // A skill whose front matter forgot its name is still a skill; the folder names it.
    name,
    description: fields.get('description') ?? null,
    enabled,
    pack: packOf(raw),
    version: fields.get('version') ?? null,
    updatedAt: statSync(file).mtime,
    content: text,
    broken: raw === '' ? 'front_matter_missing' : null,
    category,
    // Hermes records a seeded skill by its name; the folder carries the same one.
    bundled: bundled.has(name) || bundled.has(key),
  };
}

export function listSkills(home: string): Skill[] {
  const bundled = bundledNames(home);
  const out: Skill[] = [];
  for (const where of walk(home)) {
    const skill = readOne(where, bundled);
    if (skill) out.push({ ...skill, content: null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Where the skill with this key lives: directly under `skills/` first, then in a category. */
function locate(home: string, key: string): Located | null {
  if (!LOOKUP_KEY.test(key)) return null;
  const flat = path.join(skillsDir(home), key);
  if (hasSkillFile(flat)) return { key, folder: flat, category: null };
  return walk(home).find((where) => where.key === key) ?? null;
}

/**
 * A category's own words: the `description` of its `DESCRIPTION.md` front matter, else the
 * file's first paragraph. Null when it has none.
 */
export function categoryDescription(home: string, category: string): string | null {
  if (!LOOKUP_KEY.test(category)) return null;
  let raw: string;
  try {
    raw = readFileSync(path.join(skillsDir(home), category, CATEGORY_DESCRIPTION), 'utf8');
  } catch {
    return null;
  }
  const { fields, body } = parseFrontMatter(raw);
  const described = fields.get('description');
  if (described) return described;
  const paragraph: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    paragraph.push(trimmed);
  }
  const text = paragraph.join(' ');
  if (text === '') return null;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

export function getSkill(home: string, key: string): Skill | null {
  const where = locate(home, key);
  return where ? readOne(where, bundledNames(home)) : null;
}

export class SkillError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkillError';
  }
}

export interface SkillWrite {
  /** The whole `SKILL.md`, as the person edited it. */
  content: string;
}

/**
 * Write the document exactly as given, after checking it is a skill at all.
 *
 * The check is the only thing standing between a text box and an agent that fails to
 * start: Hermes reads the front matter, so a file without one is not a skill, and saying
 * so here is kinder than a runtime that refuses to boot tonight.
 */
export function putSkill(home: string, key: string, input: SkillWrite): Skill {
  const existing = locate(home, key);
  if (!existing && !KEY.test(key)) throw new SkillError('skill_key_invalid');
  const bundled = bundledNames(home);
  if (existing && readOne(existing, bundled)?.bundled) throw new SkillError('skill_bundled');
  const { fields, raw } = parseFrontMatter(input.content);
  if (raw === '') throw new SkillError('skill_front_matter_missing');
  if ((fields.get('name') ?? '').trim() === '') throw new SkillError('skill_name_required');

  // An existing skill is written where it is, in its category or not; a new one directly
  // under `skills/`, as the hub has always created them.
  const where = existing ?? { key, folder: path.join(skillsDir(home), key), category: null };
  const enabledPath = path.join(where.folder, SKILL_FILE);
  const disabledPath = enabledPath + DISABLED_SUFFIX;
  // A skill that was off stays off: saving an edit is not the same as turning it on.
  const target = !existsSync(enabledPath) && existsSync(disabledPath) ? disabledPath : enabledPath;

  mkdirSync(where.folder, { recursive: true });
  writeFileSync(target, input.content, 'utf8');
  const written = readOne(where, bundled);
  if (!written) throw new SkillError('skill_write_failed');
  return written;
}

/** The skill a change is about, refused when it is Hermes's own. */
function writable(home: string, key: string): { where: Located; bundled: Set<string> } {
  if (!LOOKUP_KEY.test(key)) throw new SkillError('skill_key_invalid');
  const where = locate(home, key);
  if (!where) throw new SkillError('skill_not_found');
  const bundled = bundledNames(home);
  if (readOne(where, bundled)?.bundled) throw new SkillError('skill_bundled');
  return { where, bundled };
}

/** On or off by renaming the file. Nothing is copied and nothing is lost. */
export function setSkillEnabled(home: string, key: string, enabled: boolean): Skill {
  const { where, bundled } = writable(home, key);
  const enabledPath = path.join(where.folder, SKILL_FILE);
  const disabledPath = enabledPath + DISABLED_SUFFIX;
  const from = enabled ? disabledPath : enabledPath;
  const to = enabled ? enabledPath : disabledPath;
  if (existsSync(from)) renameSync(from, to);
  else if (!existsSync(to)) throw new SkillError('skill_not_found');
  const skill = readOne(where, bundled);
  if (!skill) throw new SkillError('skill_not_found');
  return skill;
}

/**
 * Remove the skill's folder.
 *
 * The whole folder, because a skill is a folder — leaving its scripts behind after its
 * `SKILL.md` is gone would leave the person with files nothing lists and nothing owns. The
 * category folder around it stays: it is Hermes's, and may hold other skills.
 */
export function deleteSkill(home: string, key: string): void {
  const { where } = writable(home, key);
  rmSync(where.folder, { recursive: true, force: true });
}
