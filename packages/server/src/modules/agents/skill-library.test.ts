/**
 * Seeding Core Hub's skill library into a profile's home (`skill-library.ts`, decision §60):
 * first install, an upgrade that changes, adds and drops files, a person's edit kept through every
 * later seed until Restore, a deleted skill not brought back, a folder the hub never wrote left
 * alone, and the per-profile switch.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIBRARY_CATEGORY,
  LIBRARY_MANIFEST,
  LibraryError,
  libraryStatus,
  readLibrary,
  readManifest,
  restoreLibrarySkill,
  seedLibrary,
  seedLibraryOfEveryProfile,
  setLibraryEnabled,
} from './skill-library.js';
import { listSkills, putSkill, setSkillEnabled, deleteSkill } from './skills.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const skillDoc = (name: string, text = 'Does a thing.') =>
  `---\nname: ${name}\ndescription: ${text}\nlicense: Apache-2.0\n---\n\n# ${name}\n\nBody of ${name}.\n`;

/** A library folder on disk: `{ 'alpha/SKILL.md': '...', ... }`. */
function libraryOf(files: Record<string, string | undefined>): string {
  const root = temp('corehub-lib-');
  for (const [rel, text] of Object.entries(files)) {
    if (text === undefined) continue;
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

const V1 = {
  'DESCRIPTION.md': '---\ndescription: Core Hub skills.\n---\n',
  'alpha/SKILL.md': skillDoc('alpha'),
  'alpha/scripts/run.py': 'print("v1")\n',
  'beta/SKILL.md': skillDoc('beta'),
  'gamma/SKILL.md': skillDoc('gamma'),
  'gamma/scripts/old.py': 'print("old")\n',
};

const inHome = (home: string, rel: string) =>
  path.join(home, 'skills', LIBRARY_CATEGORY, ...rel.split('/'));
const read = (home: string, rel: string) => readFileSync(inHome(home, rel), 'utf8');

describe('the Core Hub skill library in a profile', () => {
  it('installs every skill on first seed, in the core-hub category Hermes lists', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));

    const report = seedLibrary(home, library);

    expect(report).toMatchObject({
      enabled: true,
      installed: ['alpha', 'beta', 'gamma'],
      updated: [],
      edited: [],
      conflicts: [],
    });
    expect(read(home, 'alpha/scripts/run.py')).toBe('print("v1")\n');
    expect(read(home, 'DESCRIPTION.md')).toContain('Core Hub skills.');
    const listed = listSkills(home);
    expect(listed.map((skill) => [skill.key, skill.category])).toEqual([
      ['alpha', LIBRARY_CATEGORY],
      ['beta', LIBRARY_CATEGORY],
      ['gamma', LIBRARY_CATEGORY],
    ]);
    const manifest = readManifest(home)!;
    expect(manifest.enabled).toBe(true);
    expect(manifest.version).toBe(library.version);
    expect(Object.keys(manifest.files)).toContain('alpha/scripts/run.py');
    expect(existsSync(path.join(home, 'skills', LIBRARY_MANIFEST))).toBe(true);
    const status = libraryStatus(home, library);
    expect(status.available).toBe(3);
    expect([...status.skills]).toEqual([
      ['alpha', 'current'],
      ['beta', 'current'],
      ['gamma', 'current'],
    ]);
  });

  it('writes nothing new on a second seed of the same library', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    seedLibrary(home, library);
    const again = seedLibrary(home, library);
    expect(again).toMatchObject({ installed: [], updated: [], edited: [], conflicts: [] });
  });

  it('upgrades what the hub wrote: changed files replaced, new ones added, dropped ones removed', () => {
    const home = temp('corehub-home-');
    seedLibrary(home, readLibrary(libraryOf(V1)));
    const v2 = readLibrary(
      libraryOf({
        ...Object.fromEntries(Object.entries(V1).filter(([rel]) => !rel.startsWith('beta/'))),
        'alpha/scripts/run.py': 'print("v2")\n',
        'alpha/references/notes.md': '# notes\n',
        'gamma/scripts/old.py': undefined,
        'delta/SKILL.md': skillDoc('delta'),
      }),
    );

    const report = seedLibrary(home, v2);

    expect(report.installed).toEqual(['delta']);
    expect(report.updated).toEqual(['alpha']);
    expect(read(home, 'alpha/scripts/run.py')).toBe('print("v2")\n');
    expect(read(home, 'alpha/references/notes.md')).toBe('# notes\n');
    // A file and a skill the library no longer ships go, since nobody touched them.
    expect(existsSync(inHome(home, 'gamma/scripts/old.py'))).toBe(false);
    expect(existsSync(inHome(home, 'gamma/scripts'))).toBe(false);
    expect(read(home, 'gamma/SKILL.md')).toBe(skillDoc('gamma'));
    expect(existsSync(inHome(home, 'beta'))).toBe(false);
    expect(readManifest(home)!.version).toBe(v2.version);
  });

  it('never writes over a person’s edit, marks the skill edited, and Restore puts it back', () => {
    const home = temp('corehub-home-');
    seedLibrary(home, readLibrary(libraryOf(V1)));
    // Edited through the Skills page (`putSkill` writes in place, in its category).
    const mine = skillDoc('alpha', 'My own way of doing it.');
    putSkill(home, 'alpha', { content: mine });
    const v2 = readLibrary(
      libraryOf({ ...V1, 'alpha/SKILL.md': skillDoc('alpha', 'Version two.') }),
    );

    const report = seedLibrary(home, v2);

    expect(report.edited).toEqual(['alpha']);
    expect(report.updated).toEqual([]);
    expect(read(home, 'alpha/SKILL.md')).toBe(mine);
    expect(libraryStatus(home, v2).skills.get('alpha')).toBe('edited');
    // Every later boot leaves it alone too.
    seedLibrary(home, v2);
    expect(read(home, 'alpha/SKILL.md')).toBe(mine);

    restoreLibrarySkill(home, 'alpha', v2);
    expect(read(home, 'alpha/SKILL.md')).toBe(skillDoc('alpha', 'Version two.'));
    expect(libraryStatus(home, v2).skills.get('alpha')).toBe('current');
  });

  it('keeps an edited script too: any changed file makes the skill the person’s', () => {
    const home = temp('corehub-home-');
    seedLibrary(home, readLibrary(libraryOf(V1)));
    writeFileSync(inHome(home, 'alpha/scripts/run.py'), 'print("mine")\n');
    const v2 = readLibrary(libraryOf({ ...V1, 'alpha/scripts/run.py': 'print("v2")\n' }));
    expect(seedLibrary(home, v2).edited).toEqual(['alpha']);
    expect(read(home, 'alpha/scripts/run.py')).toBe('print("mine")\n');
  });

  it('keeps a switched-off skill off through an update', () => {
    const home = temp('corehub-home-');
    seedLibrary(home, readLibrary(libraryOf(V1)));
    setSkillEnabled(home, 'beta', false);
    const v2 = readLibrary(libraryOf({ ...V1, 'beta/SKILL.md': skillDoc('beta', 'Better.') }));

    expect(seedLibrary(home, v2).updated).toEqual(['beta']);
    expect(existsSync(inHome(home, 'beta/SKILL.md'))).toBe(false);
    expect(read(home, 'beta/SKILL.md.off')).toBe(skillDoc('beta', 'Better.'));
    expect(listSkills(home).find((skill) => skill.key === 'beta')?.enabled).toBe(false);
  });

  it('does not bring back a skill the person deleted', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    seedLibrary(home, library);
    deleteSkill(home, 'gamma');

    expect(seedLibrary(home, library).removed).toEqual(['gamma']);
    expect(existsSync(inHome(home, 'gamma'))).toBe(false);
    seedLibrary(home, library);
    expect(existsSync(inHome(home, 'gamma'))).toBe(false);
    expect(readManifest(home)!.removed).toEqual(['gamma']);
  });

  it('leaves alone a folder of the same name the hub never wrote', () => {
    const home = temp('corehub-home-');
    const theirs = skillDoc('beta', 'Somebody else’s beta.');
    mkdirSync(inHome(home, 'beta'), { recursive: true });
    writeFileSync(inHome(home, 'beta/SKILL.md'), theirs);

    const report = seedLibrary(home, readLibrary(libraryOf(V1)));

    expect(report.conflicts).toEqual(['beta']);
    expect(report.installed).toEqual(['alpha', 'gamma']);
    expect(read(home, 'beta/SKILL.md')).toBe(theirs);
    expect(libraryStatus(home).skills.has('beta')).toBe(false);
  });

  it('turned off: removes untouched skills, keeps edited ones as the person’s, and stops seeding', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    seedLibrary(home, library);
    const mine = skillDoc('alpha', 'Mine now.');
    putSkill(home, 'alpha', { content: mine });

    const off = setLibraryEnabled(home, false, library);

    expect(off).toMatchObject({ enabled: false, removed: ['beta', 'gamma'], edited: ['alpha'] });
    expect(existsSync(inHome(home, 'beta'))).toBe(false);
    expect(existsSync(inHome(home, 'DESCRIPTION.md'))).toBe(false);
    expect(read(home, 'alpha/SKILL.md')).toBe(mine);
    // Released: no longer a library skill, and a boot does not install anything.
    expect(libraryStatus(home, library)).toMatchObject({ enabled: false, available: 3 });
    expect(libraryStatus(home, library).skills.size).toBe(0);
    expect(seedLibrary(home, library)).toMatchObject({ enabled: false, installed: [] });
    expect(existsSync(inHome(home, 'beta'))).toBe(false);

    // On again: the whole library is back, and the person's alpha is still theirs.
    const on = setLibraryEnabled(home, true, library);
    expect(on.installed).toEqual(['beta', 'gamma']);
    expect(on.conflicts).toEqual(['alpha']);
    expect(read(home, 'alpha/SKILL.md')).toBe(mine);
  });

  it('turning the library on again brings back skills the person had deleted', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    seedLibrary(home, library);
    deleteSkill(home, 'gamma');
    seedLibrary(home, library);
    setLibraryEnabled(home, false, library);
    expect(setLibraryEnabled(home, true, library).installed).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('installs when switched on in a profile the hub never seeded', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    expect(libraryStatus(home, library)).toMatchObject({ enabled: true, available: 3 });
    expect(setLibraryEnabled(home, true, library).installed).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('refuses Restore for a skill the library does not ship, or while it is off', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    seedLibrary(home, library);
    expect(() => restoreLibrarySkill(home, 'nope', library)).toThrow(LibraryError);
    setLibraryEnabled(home, false, library);
    expect(() => restoreLibrarySkill(home, 'alpha', library)).toThrow('skill_library_off');
  });

  it('treats a damaged manifest as a fresh one and never follows a key out of the folder', () => {
    const home = temp('corehub-home-');
    mkdirSync(path.join(home, 'skills'), { recursive: true });
    writeFileSync(
      path.join(home, 'skills', LIBRARY_MANIFEST),
      JSON.stringify({ enabled: true, files: { '../../escape': 'x', 'alpha/SKILL.md': 'y' } }),
    );
    expect(Object.keys(readManifest(home)!.files)).toEqual(['alpha/SKILL.md']);
    writeFileSync(path.join(home, 'skills', LIBRARY_MANIFEST), '{not json');
    expect(readManifest(home)).toBeNull();
    expect(seedLibrary(home, readLibrary(libraryOf(V1))).installed).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('seeds every profile and logs one failure without stopping the others', () => {
    const good = temp('corehub-home-');
    const blocked = temp('corehub-home-');
    // `skills` is a file here, so nothing can be written under it.
    writeFileSync(path.join(blocked, 'skills'), 'not a folder');
    const warnings: unknown[] = [];
    seedLibraryOfEveryProfile(
      [
        { profile: 'blocked', home: blocked },
        { profile: 'default', home: good },
      ],
      { info: () => undefined, warn: (obj) => warnings.push(obj) },
      readLibrary(libraryOf(V1)),
    );
    expect(warnings).toHaveLength(1);
    expect(existsSync(inHome(good, 'alpha/SKILL.md'))).toBe(true);
  });

  it('follows a skill Hermes renamed to SKILL.md.off when reading its state', () => {
    const home = temp('corehub-home-');
    const library = readLibrary(libraryOf(V1));
    seedLibrary(home, library);
    renameSync(inHome(home, 'beta/SKILL.md'), inHome(home, 'beta/SKILL.md.off'));
    expect(libraryStatus(home, library).skills.get('beta')).toBe('current');
  });
});
