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

function readOne(dir: string, key: string): Skill | null {
  const enabledPath = path.join(dir, key, SKILL_FILE);
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
    };
  }
  const { fields, raw } = parseFrontMatter(text);
  return {
    key,
    // A skill whose front matter forgot its name is still a skill; the folder names it.
    name: fields.get('name') ?? key,
    description: fields.get('description') ?? null,
    enabled,
    pack: packOf(raw),
    version: fields.get('version') ?? null,
    updatedAt: statSync(file).mtime,
    content: text,
    broken: raw === '' ? 'front_matter_missing' : null,
  };
}

export function listSkills(home: string): Skill[] {
  const dir = skillsDir(home);
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skill = readOne(dir, entry.name);
    if (skill) out.push({ ...skill, content: null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(home: string, key: string): Skill | null {
  if (!KEY.test(key)) return null;
  return readOne(skillsDir(home), key);
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
  if (!KEY.test(key)) throw new SkillError('skill_key_invalid');
  const { fields, raw } = parseFrontMatter(input.content);
  if (raw === '') throw new SkillError('skill_front_matter_missing');
  if ((fields.get('name') ?? '').trim() === '') throw new SkillError('skill_name_required');

  const dir = skillsDir(home);
  const folder = path.join(dir, key);
  const enabledPath = path.join(folder, SKILL_FILE);
  const disabledPath = enabledPath + DISABLED_SUFFIX;
  // A skill that was off stays off: saving an edit is not the same as turning it on.
  const target = !existsSync(enabledPath) && existsSync(disabledPath) ? disabledPath : enabledPath;

  mkdirSync(folder, { recursive: true });
  writeFileSync(target, input.content, 'utf8');
  const written = readOne(dir, key);
  if (!written) throw new SkillError('skill_write_failed');
  return written;
}

/** On or off by renaming the file. Nothing is copied and nothing is lost. */
export function setSkillEnabled(home: string, key: string, enabled: boolean): Skill {
  if (!KEY.test(key)) throw new SkillError('skill_key_invalid');
  const folder = path.join(skillsDir(home), key);
  const enabledPath = path.join(folder, SKILL_FILE);
  const disabledPath = enabledPath + DISABLED_SUFFIX;
  const from = enabled ? disabledPath : enabledPath;
  const to = enabled ? enabledPath : disabledPath;
  if (existsSync(from)) renameSync(from, to);
  else if (!existsSync(to)) throw new SkillError('skill_not_found');
  const skill = readOne(skillsDir(home), key);
  if (!skill) throw new SkillError('skill_not_found');
  return skill;
}

/**
 * Remove the skill's folder.
 *
 * The whole folder, because a skill is a folder — leaving its scripts behind after its
 * `SKILL.md` is gone would leave the person with files nothing lists and nothing owns.
 */
export function deleteSkill(home: string, key: string): void {
  if (!KEY.test(key)) throw new SkillError('skill_key_invalid');
  const folder = path.join(skillsDir(home), key);
  if (
    !existsSync(path.join(folder, SKILL_FILE)) &&
    !existsSync(path.join(folder, SKILL_FILE + DISABLED_SUFFIX))
  )
    throw new SkillError('skill_not_found');
  rmSync(folder, { recursive: true, force: true });
}
