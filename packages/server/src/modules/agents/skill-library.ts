/**
 * Core Hub's own skill library (contract decision §60): the skills that ship with the hub in
 * `packages/server/skill-library/`, installed into every Hermes profile's
 * `skills/core-hub/<skill>/` — a category folder, which is how Hermes lists them (#91).
 *
 * **The hub updates only what it wrote.** A manifest in the profile
 * (`skills/.core-hub-library.json`) records the SHA-256 of every file the hub put there. On each
 * seed a file is:
 * - written when it is missing (a new skill, or a file a new version adds);
 * - replaced by the new version when its bytes still equal what the hub recorded — nobody
 *   touched it, so it is still the hub's;
 * - **left alone when its bytes differ** from what the hub recorded: the person edited it, and
 *   the skill is now theirs. The Skills page marks it `edited` and offers Restore, which is the
 *   only thing that writes over an edit.
 *
 * A skill the person deleted (its `SKILL.md` gone while the manifest knows it) is remembered as
 * removed and not brought back on the next boot. A folder of the same name that the hub never
 * seeded is somebody else's: adopted only if it is byte-for-byte the library's, otherwise never
 * touched and reported as a conflict.
 *
 * **Off is per profile, and on by default.** The switch lives in the same manifest, so it travels
 * with the profile (a clone or an export carries it). Turning the library off removes the skills
 * that are still exactly as the hub wrote them and releases the edited ones — they stay, as the
 * person's own. Turning it on installs the whole library again.
 *
 * Switching a skill off on the Skills page renames its `SKILL.md` to `SKILL.md.off`; the manifest
 * follows the file under either name, and an update keeps a switched-off skill off.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISABLED_SUFFIX, SKILL_FILE, skillsDir } from './skills.js';

/** The category folder the library lives in, in every profile. */
export const LIBRARY_CATEGORY = 'core-hub';
/** The hub's record of what it wrote, beside Hermes's own `.bundled_manifest`. */
export const LIBRARY_MANIFEST = '.core-hub-library.json';
/** The category's own description file (Hermes reads it for the category line). */
const CATEGORY_FILE = 'DESCRIPTION.md';
const FORMAT = 1;

/** `packages/server/skill-library/`, from `src/modules/agents/` and from `dist/modules/agents/`. */
export const LIBRARY_SOURCE = fileURLToPath(new URL('../../../skill-library/', import.meta.url));

export interface LibraryFile {
  /** Path inside the skill (`SKILL.md`, `scripts/x.py`). */
  rel: string;
  data: Buffer;
  hash: string;
}

export interface Library {
  /** Skill folder name → its files. */
  skills: Map<string, LibraryFile[]>;
  /** `DESCRIPTION.md` of the category, if the library has one. */
  description: LibraryFile | null;
  /** A digest of every file: changes whenever any file of the library changes. */
  version: string;
}

export interface LibraryManifest {
  format: number;
  enabled: boolean;
  version: string;
  /** `<skill>/<rel>` (or `DESCRIPTION.md`) → SHA-256 of the bytes the hub wrote. */
  files: Record<string, string>;
  /** Skills the person deleted; not reinstalled until the library is switched off and on. */
  removed: string[];
}

export type LibraryState = 'current' | 'edited';

export interface SeedReport {
  enabled: boolean;
  installed: string[];
  updated: string[];
  /** Skills with a file the person changed: left exactly as they are. */
  edited: string[];
  /** Skills the person deleted: not brought back. */
  removed: string[];
  /** A folder of a library skill's name the hub did not write: never touched. */
  conflicts: string[];
}

export class LibraryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LibraryError';
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** The library as shipped: every skill folder (one with a `SKILL.md`) and the category file. */
export function readLibrary(root: string = LIBRARY_SOURCE): Library {
  const skills = new Map<string, LibraryFile[]>();
  let description: LibraryFile | null = null;
  const digest = createHash('sha256');
  if (!existsSync(root)) return { skills, description, version: 'none' };
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === CATEGORY_FILE) {
      const data = readFileSync(full);
      description = { rel: CATEGORY_FILE, data, hash: sha256(data) };
      digest.update(`${CATEGORY_FILE}\0${description.hash}\n`);
      continue;
    }
    if (!entry.isDirectory() || !existsSync(path.join(full, SKILL_FILE))) continue;
    const files = filesUnder(full).map((rel) => {
      const data = readFileSync(path.join(full, rel));
      return { rel, data, hash: sha256(data) };
    });
    for (const file of files) digest.update(`${entry.name}/${file.rel}\0${file.hash}\n`);
    skills.set(entry.name, files);
  }
  return { skills, description, version: digest.digest('hex').slice(0, 16) };
}

let cached: Library | null = null;
/** The shipped library, read once per process (it is part of the image and never changes). */
export function shippedLibrary(): Library {
  cached ??= readLibrary();
  return cached;
}

function categoryDir(home: string): string {
  return path.join(skillsDir(home), LIBRARY_CATEGORY);
}

function manifestPath(home: string): string {
  return path.join(skillsDir(home), LIBRARY_MANIFEST);
}

function fresh(): LibraryManifest {
  return { format: FORMAT, enabled: true, version: '', files: {}, removed: [] };
}

/** The profile's manifest, or null when the hub never seeded it. A damaged one counts as new. */
export function readManifest(home: string): LibraryManifest | null {
  let raw: string;
  try {
    raw = readFileSync(manifestPath(home), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LibraryManifest>;
    return {
      format: FORMAT,
      enabled: parsed.enabled !== false,
      version: typeof parsed.version === 'string' ? parsed.version : '',
      files:
        parsed.files && typeof parsed.files === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.files).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string' && safeKey(entry[0]),
              ),
            )
          : {},
      removed: Array.isArray(parsed.removed)
        ? parsed.removed.filter((name): name is string => typeof name === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/** A manifest key names a file inside the category folder, never outside it. */
function safeKey(key: string): boolean {
  return (
    key !== '' &&
    !key.startsWith('/') &&
    !key.split('/').some((part) => part === '..' || part === '' || part === '.')
  );
}

function writeManifest(home: string, manifest: LibraryManifest): void {
  mkdirSync(skillsDir(home), { recursive: true });
  const target = manifestPath(home);
  const temporary = `${target}.${process.pid}.tmp`;
  const files = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    temporary,
    `${JSON.stringify({ ...manifest, files, removed: [...new Set(manifest.removed)].sort() }, null, 2)}\n`,
  );
  renameSync(temporary, target);
}

/** Where a manifest key lives on disk; `SKILL.md` is found under its switched-off name too. */
function onDisk(home: string, key: string): string {
  const plain = path.join(categoryDir(home), ...key.split('/'));
  if (path.basename(key) === SKILL_FILE && !existsSync(plain)) {
    const off = plain + DISABLED_SUFFIX;
    if (existsSync(off)) return off;
  }
  return plain;
}

function hashOf(file: string): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    return sha256(readFileSync(file));
  } catch {
    return null;
  }
}

function put(file: string, data: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

const skillOf = (key: string): string | null => (key.includes('/') ? key.split('/')[0]! : null);

function skillPresent(home: string, skill: string): boolean {
  const folder = path.join(categoryDir(home), skill);
  return (
    existsSync(path.join(folder, SKILL_FILE)) ||
    existsSync(path.join(folder, SKILL_FILE + DISABLED_SUFFIX))
  );
}

/** Remove now-empty folders from `dir` up to (and including) the category folder. */
function prune(home: string, dir: string): void {
  const stop = path.dirname(categoryDir(home));
  let current = dir;
  while (current.startsWith(categoryDir(home)) && current !== stop) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function emptyReport(enabled: boolean): SeedReport {
  return { enabled, installed: [], updated: [], edited: [], removed: [], conflicts: [] };
}

/**
 * Install or update the library in one profile's home. Idempotent: a second run with the same
 * library writes nothing but the manifest's unchanged contents.
 */
export function seedLibrary(home: string, library: Library = shippedLibrary()): SeedReport {
  const manifest = readManifest(home) ?? fresh();
  const report = emptyReport(manifest.enabled);
  if (!manifest.enabled) return report;
  if (library.skills.size === 0) return report;

  const touched = { installed: new Set<string>(), updated: new Set<string>() };
  const edited = new Set<string>();

  /** One file: write, update, or leave the person's version alone. Returns what happened. */
  const reconcile = (key: string, file: LibraryFile, owner: string | null, ownerPresent = true) => {
    const target = onDisk(home, key);
    const current = hashOf(target);
    const recorded = manifest.files[key];
    if (current === null) {
      // A file the hub wrote and the person removed from a skill they kept is an edit too.
      if (recorded && owner) {
        edited.add(owner);
        return;
      }
      put(target, file.data);
      manifest.files[key] = file.hash;
      if (owner) (ownerPresent ? touched.updated : touched.installed).add(owner);
      return;
    }
    if (current === file.hash) {
      manifest.files[key] = file.hash;
      return;
    }
    if (recorded && current === recorded) {
      put(target, file.data);
      manifest.files[key] = file.hash;
      if (owner) touched.updated.add(owner);
      return;
    }
    // Different from what the hub wrote: the person's now.
    if (owner) edited.add(owner);
  };

  for (const [skill, files] of library.skills) {
    if (manifest.removed.includes(skill)) {
      report.removed.push(skill);
      continue;
    }
    const known = Object.keys(manifest.files).some((key) => skillOf(key) === skill);
    const present = skillPresent(home, skill);
    if (known && !present) {
      // The person deleted it (the Skills page removes the whole folder).
      manifest.removed.push(skill);
      for (const key of Object.keys(manifest.files)) {
        if (skillOf(key) === skill) delete manifest.files[key];
      }
      report.removed.push(skill);
      continue;
    }
    if (!known && present) {
      // A folder the hub never wrote. Adopt it only when it is exactly the library's.
      const same = files.every(
        (file) => hashOf(onDisk(home, `${skill}/${file.rel}`)) === file.hash,
      );
      if (!same) {
        report.conflicts.push(skill);
        continue;
      }
    }
    for (const file of files) reconcile(`${skill}/${file.rel}`, file, skill, present);
    // Files an older library had and this one does not: gone if untouched, kept if edited.
    const shipped = new Set(files.map((file) => `${skill}/${file.rel}`));
    for (const key of Object.keys(manifest.files)) {
      if (skillOf(key) !== skill || shipped.has(key)) continue;
      retire(home, manifest, key, () => edited.add(skill));
    }
  }

  // Skills an older library had and this one does not.
  for (const key of Object.keys(manifest.files)) {
    const skill = skillOf(key);
    if (skill === null || library.skills.has(skill)) continue;
    retire(home, manifest, key, () => undefined);
  }

  if (library.description) reconcile(CATEGORY_FILE, library.description, null);

  manifest.version = library.version;
  writeManifest(home, manifest);
  report.installed = [...touched.installed].sort();
  report.updated = [...touched.updated].filter((skill) => !touched.installed.has(skill)).sort();
  report.edited = [...edited].sort();
  return report;
}

/** A file the library no longer ships: removed when still the hub's, forgotten either way. */
function retire(home: string, manifest: LibraryManifest, key: string, onEdited: () => void): void {
  const target = onDisk(home, key);
  const current = hashOf(target);
  if (current !== null && current === manifest.files[key]) {
    rmSync(target, { force: true });
    prune(home, path.dirname(target));
  } else if (current !== null) {
    onEdited();
  }
  delete manifest.files[key];
}

export interface LibraryStatus {
  enabled: boolean;
  /** How many skills the library ships. */
  available: number;
  /** Library skills installed in this profile, by folder name, with their state. */
  skills: Map<string, LibraryState>;
}

/** What the library looks like in this profile, from the manifest and the files. */
export function libraryStatus(home: string, library: Library = shippedLibrary()): LibraryStatus {
  const manifest = readManifest(home);
  const skills = new Map<string, LibraryState>();
  if (manifest) {
    for (const [key, recorded] of Object.entries(manifest.files)) {
      const skill = skillOf(key);
      if (skill === null || !skillPresent(home, skill)) continue;
      const state = hashOf(onDisk(home, key)) === recorded ? 'current' : 'edited';
      if (state === 'edited' || !skills.has(skill)) skills.set(skill, state);
    }
  }
  return {
    enabled: manifest?.enabled ?? true,
    available: library.skills.size,
    skills,
  };
}

/**
 * Switch the library on or off in one profile. Off removes every library skill still exactly as
 * the hub wrote it and releases the edited ones, which stay as the person's own; on installs the
 * whole library again, including skills the person had deleted.
 */
export function setLibraryEnabled(
  home: string,
  enabled: boolean,
  library: Library = shippedLibrary(),
): SeedReport {
  const manifest = readManifest(home) ?? fresh();
  if (enabled) {
    manifest.enabled = true;
    manifest.removed = [];
    writeManifest(home, manifest);
    return seedLibrary(home, library);
  }
  const report = emptyReport(false);
  const bySkill = new Map<string, string[]>();
  for (const key of Object.keys(manifest.files)) {
    const skill = skillOf(key);
    if (skill === null) continue;
    bySkill.set(skill, [...(bySkill.get(skill) ?? []), key]);
  }
  for (const [skill, keys] of bySkill) {
    const untouched = keys.every((key) => hashOf(onDisk(home, key)) === manifest.files[key]);
    if (untouched) {
      rmSync(path.join(categoryDir(home), skill), { recursive: true, force: true });
      report.removed.push(skill);
    } else {
      report.edited.push(skill);
    }
  }
  const description = manifest.files[CATEGORY_FILE];
  if (description && hashOf(onDisk(home, CATEGORY_FILE)) === description) {
    rmSync(onDisk(home, CATEGORY_FILE), { force: true });
  }
  prune(home, categoryDir(home));
  writeManifest(home, { format: FORMAT, enabled: false, version: '', files: {}, removed: [] });
  report.removed.sort();
  report.edited.sort();
  return report;
}

/**
 * Put a library skill back exactly as the library ships it, over the person's edits (the only
 * operation that writes over an edit). A switched-off skill stays off.
 */
export function restoreLibrarySkill(
  home: string,
  skill: string,
  library: Library = shippedLibrary(),
): void {
  const files = library.skills.get(skill);
  if (!files) throw new LibraryError('skill_not_library');
  const manifest = readManifest(home) ?? fresh();
  if (!manifest.enabled) throw new LibraryError('skill_library_off');
  for (const file of files) {
    const key = `${skill}/${file.rel}`;
    put(onDisk(home, key), file.data);
    manifest.files[key] = file.hash;
  }
  manifest.removed = manifest.removed.filter((name) => name !== skill);
  if (library.description && !existsSync(onDisk(home, CATEGORY_FILE))) {
    put(onDisk(home, CATEGORY_FILE), library.description.data);
    manifest.files[CATEGORY_FILE] = library.description.hash;
  }
  writeManifest(home, manifest);
}

/** Seed every profile under Hermes's root home: `default` (the root) and each named profile. */
export function seedLibraryOfEveryProfile(
  homes: ReadonlyArray<{ profile: string; home: string }>,
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void },
  library: Library = shippedLibrary(),
): void {
  for (const { profile, home } of homes) {
    try {
      const report = seedLibrary(home, library);
      if (report.installed.length + report.updated.length + report.conflicts.length > 0) {
        log.info(
          {
            profile,
            installed: report.installed,
            updated: report.updated,
            edited: report.edited,
            conflicts: report.conflicts,
          },
          'agents: Core Hub skill library seeded',
        );
      }
    } catch (error) {
      log.warn({ profile, err: error }, 'agents: could not seed the Core Hub skill library');
    }
  }
}
