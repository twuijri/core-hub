/**
 * Installing a skill pack someone uploaded: a single `SKILL.md`, or a zip (`.zip`, `.skill`)
 * holding one skill or several.
 *
 * **Hermes has no importer**, so this is the hub's. Hermes's dashboard can create one skill
 * from text (`POST /api/skills`), but that is the path for skills the *agent* writes, and it
 * holds a new skill's description to 60 characters so the system prompt stays small — a rule
 * most published packs break, and not one Hermes applies to a skill it *reads*. What decides
 * whether a pack works is whether Hermes will read it, so these are Hermes's reading rules
 * (`tools/skill_manager_tool.py` §_validate_frontmatter, `VALID_NAME_RE`, `MAX_*`):
 *
 * - `SKILL.md` opens with a YAML front matter block that is closed, parses as a mapping and
 *   carries `name` and `description` (at most 1,024 characters); a body follows; the whole
 *   file is under 100,000 characters. A UTF-8 byte-order mark is tolerated.
 * - The skill's name — its front matter `name`, else its folder — is `^[a-z0-9][a-z0-9._-]*$`,
 *   at most 64 characters.
 *
 * **Nothing is rewritten.** Every file of the pack lands byte for byte: the front matter a
 * pack carries (its licence, its `metadata`, its prerequisites) is the pack's, and the skills
 * page already promises to keep it (`skills.ts`). The executable bit a zip recorded is kept,
 * so a pack's scripts still run.
 *
 * **All or nothing.** Every skill in every file is checked before a byte is written; a skill
 * that already exists, or a broken one, refuses the whole import with the reason, the skill
 * and the file. Then everything is written to a hidden folder beside the skills and moved into
 * place, so a failure half-way leaves nothing half-installed.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SKILL_FILE, DISABLED_SUFFIX, skillsDir } from './skills.js';
import { DEFAULT_ZIP_LIMITS, ZipError, looksLikeZip, readZip, type ZipLimits } from './zip.js';

/** Hermes's `VALID_NAME_RE` and `MAX_NAME_LENGTH`. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SKILL_CHARS = 100_000;
const MAX_DESCRIPTION_CHARS = 1024;
/** Hermes's `_FRONTMATTER_END_RE`. */
const FRONT_MATTER_END = /\n---\s*\n/;

export class SkillImportError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly where: { skill?: string | null; file?: string | null } = {},
    /** `conflict` when the pack is fine but the profile already has the skill. */
    readonly kind: 'invalid' | 'conflict' = 'invalid',
  ) {
    super(message);
    this.name = 'SkillImportError';
  }
}

export interface UploadedFile {
  /** The name the person uploaded it under. */
  name: string;
  data: Buffer;
}

export interface PackSkill {
  key: string;
  /** The file the skill came from, for error messages. */
  source: string;
  files: Array<{ path: string; data: Buffer; mode: number | null }>;
}

/**
 * Check `SKILL.md` the way Hermes reads it. Returns the front matter's `name`. Never changes
 * the text: the checks run on a copy without the byte-order mark, and the file is written as
 * it came.
 */
export function checkSkillDocument(text: string, where: { skill?: string; file: string }): string {
  const fail = (reason: string, message: string): never => {
    throw new SkillImportError(reason, message, where);
  };
  if (!text.trim()) fail('skill_empty', 'SKILL.md is empty');
  if (text.length > MAX_SKILL_CHARS) {
    fail(
      'skill_too_large',
      `SKILL.md is ${text.length} characters (Hermes reads at most ${MAX_SKILL_CHARS})`,
    );
  }
  const body = text.replace(/^\uFEFF/, '');
  if (!body.startsWith('---')) {
    fail('skill_front_matter_missing', 'SKILL.md must start with a YAML front matter block (---)');
  }
  const end = FRONT_MATTER_END.exec(body.slice(3));
  if (!end) fail('skill_front_matter_unclosed', "SKILL.md's front matter has no closing ---");
  const block = body.slice(3, end!.index + 3);
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch (error) {
    fail(
      'skill_front_matter_invalid',
      `the front matter is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('skill_front_matter_invalid', 'the front matter must be a YAML mapping (key: value)');
  }
  const fields = parsed as Record<string, unknown>;
  if (!('name' in fields) || String(fields.name ?? '').trim() === '') {
    fail('skill_name_required', "the front matter has no 'name'");
  }
  if (!('description' in fields) || fields.description === null) {
    fail('skill_description_required', "the front matter has no 'description'");
  }
  const description = String(fields.description);
  if (description.length > MAX_DESCRIPTION_CHARS) {
    fail(
      'skill_description_too_long',
      `the description is ${description.length} characters (Hermes reads at most ${MAX_DESCRIPTION_CHARS})`,
    );
  }
  if (!body.slice(end!.index + 3 + end![0].length).trim()) {
    fail('skill_body_empty', 'SKILL.md has nothing after its front matter');
  }
  return String(fields.name).trim();
}

/** The skill's name: its front matter's when that is a valid name, else its folder's. */
function keyFor(declared: string, folder: string | null, where: { file: string }): string {
  if (NAME.test(declared)) return declared;
  if (folder !== null && NAME.test(folder)) return folder;
  throw new SkillImportError(
    'skill_name_invalid',
    `"${declared}" is not a name Hermes accepts: lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit, at most 64`,
    { skill: declared, file: where.file },
  );
}

function decode(data: Buffer, where: { skill?: string; file: string }): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new SkillImportError('skill_not_utf8', 'SKILL.md is not UTF-8 text', where);
  }
}

/** The skills in one uploaded file. */
export function readPack(file: UploadedFile, limits: ZipLimits = DEFAULT_ZIP_LIMITS): PackSkill[] {
  if (!looksLikeZip(file.data)) {
    if (!/\.(md|markdown)$/i.test(file.name)) {
      throw new SkillImportError(
        'pack_unrecognised',
        'a skill pack is a SKILL.md file or a zip archive',
        { file: file.name },
      );
    }
    const text = decode(file.data, { file: file.name });
    const declared = checkSkillDocument(text, { file: file.name });
    const key = keyFor(declared, null, { file: file.name });
    return [{ key, source: file.name, files: [{ path: SKILL_FILE, data: file.data, mode: null }] }];
  }

  let entries;
  try {
    entries = readZip(file.data, limits);
  } catch (error) {
    if (error instanceof ZipError) {
      throw new SkillImportError(error.reason, error.message, {
        file: error.file ? `${file.name}: ${error.file}` : file.name,
      });
    }
    throw error;
  }
  // A skill is a folder holding a SKILL.md; the pack's root counts as a folder too.
  const roots = entries
    .filter((entry) => path.posix.basename(entry.path) === SKILL_FILE)
    .map((entry) => path.posix.dirname(entry.path))
    .map((dir) => (dir === '.' ? '' : dir))
    .sort((a, b) => a.length - b.length);
  if (roots.length === 0) {
    throw new SkillImportError('pack_has_no_skill', 'the archive holds no SKILL.md', {
      file: file.name,
    });
  }
  const inside = (dir: string, root: string) =>
    root === '' || dir === root || dir.startsWith(`${root}/`);
  for (const [index, root] of roots.entries()) {
    const outer = roots.slice(0, index).find((other) => inside(root, other));
    if (outer !== undefined) {
      throw new SkillImportError(
        'skill_nested',
        `"${root}/SKILL.md" is inside the skill "${outer || '(the archive root)'}"; a skill cannot hold another`,
        { file: `${file.name}: ${root}/${SKILL_FILE}` },
      );
    }
  }

  return roots.map((root) => {
    const skillPath = root === '' ? SKILL_FILE : `${root}/${SKILL_FILE}`;
    const where = { file: `${file.name}: ${skillPath}` };
    const document = entries.find((entry) => entry.path === skillPath)!;
    const declared = checkSkillDocument(decode(document.data, where), where);
    const folder = root === '' ? null : path.posix.basename(root);
    const key = keyFor(declared, folder, where);
    const prefix = root === '' ? '' : `${root}/`;
    return {
      key,
      source: `${file.name}: ${skillPath}`,
      files: entries
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({
          path: entry.path.slice(prefix.length),
          data: entry.data,
          mode: entry.mode,
        })),
    };
  });
}

/** Every skill in every uploaded file, checked against each other and against the profile. */
export function planImport(home: string, uploads: readonly UploadedFile[]): PackSkill[] {
  const skills = uploads.flatMap((file) => readPack(file));
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const earlier = seen.get(skill.key);
    if (earlier) {
      throw new SkillImportError(
        'skill_duplicate',
        `the skill "${skill.key}" is in the upload twice (${earlier} and ${skill.source})`,
        { skill: skill.key, file: skill.source },
      );
    }
    seen.set(skill.key, skill.source);
    const folder = path.join(skillsDir(home), skill.key);
    if (
      existsSync(folder) ||
      existsSync(path.join(folder, SKILL_FILE)) ||
      existsSync(path.join(folder, SKILL_FILE + DISABLED_SUFFIX))
    ) {
      throw new SkillImportError(
        'skill_exists',
        `this profile already has a skill "${skill.key}"; delete it first to replace it`,
        { skill: skill.key, file: skill.source },
        'conflict',
      );
    }
  }
  return skills;
}

/**
 * Write the planned skills into `home/skills/`: staged in a hidden folder beside them, then
 * moved into place one by one. A failure removes whatever it had already moved.
 */
export function installPack(home: string, skills: readonly PackSkill[]): string[] {
  const root = skillsDir(home);
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(path.join(root, '.import-'));
  const moved: string[] = [];
  try {
    for (const skill of skills) {
      const target = path.join(staging, skill.key);
      for (const file of skill.files) {
        const destination = path.join(target, ...file.path.split('/'));
        // `safeEntryPath` already refused anything climbing; this is the second lock.
        if (!destination.startsWith(`${target}${path.sep}`)) {
          throw new SkillImportError('pack_path_unsafe', `"${file.path}" leaves its skill`, {
            skill: skill.key,
            file: skill.source,
          });
        }
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file.data);
        if (file.mode !== null && (file.mode & 0o111) !== 0) chmodSync(destination, 0o755);
      }
    }
    for (const skill of skills) {
      renameSync(path.join(staging, skill.key), path.join(root, skill.key));
      moved.push(skill.key);
    }
    return moved;
  } catch (error) {
    for (const key of moved) rmSync(path.join(root, key), { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
