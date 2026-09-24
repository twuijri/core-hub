/**
 * Installing a skill pack: the zip reader's locks, Hermes's reading rules, and the promise
 * that a pack is installed byte for byte, all together or not at all.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SkillImportError,
  checkSkillDocument,
  installPack,
  planImport,
  readPack,
} from './skill-import.js';
import { listSkills } from './skills.js';
import { makeZip } from './testing/make-zip.js';
import { ZipError, readZip, safeEntryPath } from './zip.js';

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-import-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A pack's SKILL.md with nested front matter the hub must never reshape. */
const PDF = [
  '---',
  'name: pdf-notes',
  'description: "Summarise a PDF into notes: page references kept, headings and tables as in the source, and nothing invented."',
  'license: MIT',
  'metadata:',
  '  hermes:',
  '    source: acme-pack/skills',
  '    tags: [pdf, notes]',
  'prerequisites:',
  '  commands: [pdftotext]',
  '---',
  '',
  '# PDF notes',
  '',
  'Run `scripts/extract.sh` on the file, then read `references/style.md`.',
  '',
].join('\n');

const skill = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\n\n# ${name}\n\nSteps.\n`;

function refusal(run: () => unknown): SkillImportError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SkillImportError);
    return error as SkillImportError;
  }
  throw new Error('expected a refusal');
}

describe('the zip reader', () => {
  it('reads stored and deflated entries, and verifies each checksum', () => {
    const zip = makeZip([
      { path: 'a/SKILL.md', data: 'hello' },
      { path: 'a/raw.txt', data: 'stored bytes', stored: true },
    ]);
    const entries = readZip(zip);
    expect(entries.map((entry) => [entry.path, entry.data.toString()])).toEqual([
      ['a/SKILL.md', 'hello'],
      ['a/raw.txt', 'stored bytes'],
    ]);
  });

  it('refuses a path that climbs, an absolute path, a symlink, an encrypted entry', () => {
    const cases: Array<[Parameters<typeof makeZip>[0], string]> = [
      [[{ path: '../evil/SKILL.md', data: 'x' }], 'pack_path_unsafe'],
      [[{ path: 'ok/../../evil', data: 'x' }], 'pack_path_unsafe'],
      [[{ path: '/etc/passwd', data: 'x' }], 'pack_path_unsafe'],
      [[{ path: 'C:/Windows/x', data: 'x' }], 'pack_path_unsafe'],
      [[{ path: 'a/link', data: '/etc/passwd', mode: 0o120777 }], 'pack_path_unsafe'],
      [[{ path: 'a/secret', data: 'x', flags: 1 }], 'pack_unsupported'],
      [[{ path: 'a/SKILL.md', data: 'x', badCrc: true }], 'pack_corrupt'],
    ];
    for (const [entries, reason] of cases) {
      let caught: unknown;
      try {
        readZip(makeZip(entries));
      } catch (error) {
        caught = error;
      }
      expect(caught, entries[0]!.path).toBeInstanceOf(ZipError);
      expect((caught as ZipError).reason, entries[0]!.path).toBe(reason);
    }
  });

  it('refuses an archive that would expand past the ceiling', () => {
    const zip = makeZip([{ path: 'big.bin', data: Buffer.alloc(4096, 0) }]);
    expect(() =>
      readZip(zip, { maxEntries: 10, maxFileBytes: 1024, maxTotalBytes: 1 << 20 }),
    ).toThrow(/expands to 4096 bytes/);
    expect(() =>
      readZip(
        makeZip([
          { path: 'a', data: Buffer.alloc(800) },
          { path: 'b', data: Buffer.alloc(800) },
        ]),
        { maxEntries: 10, maxFileBytes: 1024, maxTotalBytes: 1000 },
      ),
    ).toThrow(/more than 1000 bytes/);
  });

  it('skips what archivers add, and reads Windows separators as separators', () => {
    const entries = readZip(
      makeZip([
        { path: '__MACOSX/a/._SKILL.md', data: 'junk' },
        { path: 'a/.DS_Store', data: 'junk' },
        { path: 'a\\SKILL.md', data: 'real' },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(['a/SKILL.md']);
    expect(safeEntryPath('./a/./b')).toBe('a/b');
  });

  it('says so for bytes that are not a whole zip', () => {
    expect(() => readZip(Buffer.from('PK\u0003\u0004 not really'))).toThrow(ZipError);
  });
});

describe("Hermes's reading rules for SKILL.md", () => {
  const where = { file: 'SKILL.md' };
  it('accepts a pack skill, nested front matter and all, and names it', () => {
    expect(checkSkillDocument(PDF, where)).toBe('pdf-notes');
    // A byte-order mark is tolerated, as Hermes tolerates it.
    expect(checkSkillDocument(`\uFEFF${PDF}`, where)).toBe('pdf-notes');
  });

  it('says what is wrong, one reason per mistake', () => {
    const cases: Array<[string, string]> = [
      ['', 'skill_empty'],
      ['# no front matter\n', 'skill_front_matter_missing'],
      ['---\nname: x\ndescription: y\n\nbody never closed\n', 'skill_front_matter_unclosed'],
      ['---\nname: [unclosed\n---\n\nbody\n', 'skill_front_matter_invalid'],
      ['---\n- a list\n---\n\nbody\n', 'skill_front_matter_invalid'],
      ['---\ndescription: y\n---\n\nbody\n', 'skill_name_required'],
      ['---\nname: x\n---\n\nbody\n', 'skill_description_required'],
      [
        `---\nname: x\ndescription: ${'d'.repeat(1025)}\n---\n\nbody\n`,
        'skill_description_too_long',
      ],
      ['---\nname: x\ndescription: y\n---\n\n   \n', 'skill_body_empty'],
      [`---\nname: x\ndescription: y\n---\n\n${'b'.repeat(100_001)}`, 'skill_too_large'],
    ];
    for (const [text, reason] of cases) {
      expect(refusal(() => checkSkillDocument(text, where)).reason, reason).toBe(reason);
    }
  });
});

describe('reading a pack', () => {
  it('takes a single SKILL.md, named by its front matter', () => {
    const [only] = readPack({ name: 'anything.md', data: Buffer.from(PDF) });
    expect(only!.key).toBe('pdf-notes');
    expect(only!.files.map((file) => file.path)).toEqual(['SKILL.md']);
  });

  it('takes a zip with several skills, each with the files beside it', () => {
    const skills = readPack({
      name: 'pack.zip',
      data: makeZip([
        { path: 'README.md', data: 'about the pack' },
        { path: 'skills/pdf-notes/SKILL.md', data: PDF },
        { path: 'skills/pdf-notes/scripts/extract.sh', data: '#!/bin/sh\n', mode: 0o100755 },
        { path: 'skills/pdf-notes/references/style.md', data: 'style' },
        { path: 'skills/csv-clean/SKILL.md', data: skill('csv-clean') },
      ]),
    });
    expect(skills.map((one) => one.key).sort()).toEqual(['csv-clean', 'pdf-notes']);
    const pdf = skills.find((one) => one.key === 'pdf-notes')!;
    expect(pdf.files.map((file) => file.path).sort()).toEqual([
      'SKILL.md',
      'references/style.md',
      'scripts/extract.sh',
    ]);
  });

  it('takes a zip whose root is the skill, named by its front matter', () => {
    const [only] = readPack({
      name: 'pdf.skill',
      data: makeZip([
        { path: 'SKILL.md', data: PDF },
        { path: 'references/style.md', data: 'style' },
      ]),
    });
    expect(only!.key).toBe('pdf-notes');
    expect(only!.files).toHaveLength(2);
  });

  it('falls back to the folder when the front matter name is not a name Hermes takes', () => {
    const [only] = readPack({
      name: 'p.zip',
      data: makeZip([{ path: 'web-research/SKILL.md', data: skill('Web Research') }]),
    });
    expect(only!.key).toBe('web-research');
    expect(
      refusal(() => readPack({ name: 'Web Research.md', data: Buffer.from(skill('Web Research')) }))
        .reason,
    ).toBe('skill_name_invalid');
  });

  it('refuses a pack with no skill, a skill inside a skill, and a file that is neither', () => {
    expect(
      refusal(() => readPack({ name: 'p.zip', data: makeZip([{ path: 'a.txt', data: 'x' }]) }))
        .reason,
    ).toBe('pack_has_no_skill');
    expect(
      refusal(() =>
        readPack({
          name: 'p.zip',
          data: makeZip([
            { path: 'outer/SKILL.md', data: skill('outer') },
            { path: 'outer/inner/SKILL.md', data: skill('inner') },
          ]),
        }),
      ).reason,
    ).toBe('skill_nested');
    expect(refusal(() => readPack({ name: 'notes.txt', data: Buffer.from('hi') })).reason).toBe(
      'pack_unrecognised',
    );
  });

  it('names the file inside the archive when a skill is broken', () => {
    const error = refusal(() =>
      readPack({
        name: 'pack.zip',
        data: makeZip([{ path: 'broken/SKILL.md', data: '---\nname: broken\n---\n\nbody\n' }]),
      }),
    );
    expect(error.reason).toBe('skill_description_required');
    expect(error.where.file).toBe('pack.zip: broken/SKILL.md');
  });
});

describe('installing', () => {
  it('writes every file byte for byte, keeps the executable bit, and the skill lists', () => {
    const agentHome = home();
    const script = '#!/bin/sh\necho extract\n';
    const keys = installPack(
      agentHome,
      planImport(agentHome, [
        {
          name: 'pack.zip',
          data: makeZip([
            { path: 'pdf-notes/SKILL.md', data: PDF },
            { path: 'pdf-notes/scripts/extract.sh', data: script, mode: 0o100755 },
          ]),
        },
      ]),
    );
    expect(keys).toEqual(['pdf-notes']);
    const folder = path.join(agentHome, 'skills', 'pdf-notes');
    // Verbatim: the nested `metadata` and `prerequisites` blocks are the pack's, untouched.
    expect(readFileSync(path.join(folder, 'SKILL.md'), 'utf8')).toBe(PDF);
    expect(readFileSync(path.join(folder, 'scripts', 'extract.sh'), 'utf8')).toBe(script);
    expect(statSync(path.join(folder, 'scripts', 'extract.sh')).mode & 0o111).not.toBe(0);
    const listed = listSkills(agentHome);
    expect(listed.map((one) => [one.key, one.pack])).toEqual([['pdf-notes', 'acme-pack']]);
    // Nothing staged is left behind.
    expect(readdirSync(path.join(agentHome, 'skills'))).toEqual(['pdf-notes']);
  });

  it('installs nothing when one skill of the upload is already there', () => {
    const agentHome = home();
    mkdirSync(path.join(agentHome, 'skills', 'csv-clean'), { recursive: true });
    writeFileSync(path.join(agentHome, 'skills', 'csv-clean', 'SKILL.md.off'), skill('csv-clean'));
    const error = refusal(() =>
      planImport(agentHome, [
        { name: 'one.md', data: Buffer.from(PDF) },
        { name: 'two.md', data: Buffer.from(skill('csv-clean')) },
      ]),
    );
    expect(error).toMatchObject({ reason: 'skill_exists', kind: 'conflict' });
    expect(error.where.skill).toBe('csv-clean');
    expect(existsSync(path.join(agentHome, 'skills', 'pdf-notes'))).toBe(false);
  });

  it('refuses the same skill twice in one upload', () => {
    const agentHome = home();
    expect(
      refusal(() =>
        planImport(agentHome, [
          { name: 'a.md', data: Buffer.from(PDF) },
          { name: 'b.md', data: Buffer.from(PDF) },
        ]),
      ).reason,
    ).toBe('skill_duplicate');
  });
});
