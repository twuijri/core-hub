/**
 * Skills are folders on disk that this hub does not own. The tests are mostly about
 * what survives a round trip through our screen.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SkillError,
  categoryDescription,
  deleteSkill,
  getSkill,
  listSkills,
  parseFrontMatter,
  putSkill,
  setSkillEnabled,
} from './skills.js';

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-skills-'));
  homes.push(dir);
  mkdirSync(path.join(dir, 'skills'), { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skill exactly as a pack writes one, including blocks we do not understand. */
const PACK_SKILL = `---
name: markdown-viewer
description: "Diagrams and charts in Markdown."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    source: markdown-viewer/skills
    tags: [diagrams, visualization]
prerequisites:
  commands: [node, npx]
---

# Markdown Viewer

Use it for diagrams.
`;

function write(dir: string, key: string, text: string, off = false): void {
  mkdirSync(path.join(dir, 'skills', key), { recursive: true });
  writeFileSync(path.join(dir, 'skills', key, off ? 'SKILL.md.off' : 'SKILL.md'), text, 'utf8');
}

describe('reading what is on disk', () => {
  it('reads the name, the description and the pack it came from', () => {
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    const [skill] = listSkills(dir);
    expect(skill?.name).toBe('markdown-viewer');
    expect(skill?.description).toBe('Diagrams and charts in Markdown.');
    expect(skill?.pack).toBe('markdown-viewer');
    expect(skill?.version).toBe('1.0.0');
    expect(skill?.enabled).toBe(true);
    // A listing does not carry bodies: ten skills would be ten documents nobody read.
    expect(skill?.content).toBeNull();
  });

  it('reads the whole document when asked for one skill, front matter and all', () => {
    // What an editor is handed is what it will write back. Handing it the body alone
    // would make every save delete the front matter the agent reads.
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    expect(getSkill(dir, 'markdown-viewer')?.content).toBe(PACK_SKILL);
  });

  it('what is read can be written back unchanged', () => {
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    const read = getSkill(dir, 'markdown-viewer')?.content ?? '';
    putSkill(dir, 'markdown-viewer', { content: read });
    expect(getSkill(dir, 'markdown-viewer')?.content).toBe(PACK_SKILL);
  });

  it('lists a skill whose front matter is broken instead of hiding it', () => {
    // A skill that silently vanishes from a list is worse than one that says it is broken.
    const dir = home();
    write(dir, 'half-written', '# no front matter here\n');
    const [skill] = listSkills(dir);
    expect(skill?.key).toBe('half-written');
    expect(skill?.broken).toBe('front_matter_missing');
  });

  it('is not fooled by a folder that is not a skill', () => {
    const dir = home();
    mkdirSync(path.join(dir, 'skills', 'notes'), { recursive: true });
    expect(listSkills(dir)).toHaveLength(0);
  });

  it('names a skill after its folder when the front matter forgot to', () => {
    const dir = home();
    write(dir, 'unnamed', '---\nversion: 2\n---\nbody\n');
    expect(listSkills(dir)[0]?.name).toBe('unnamed');
  });

  it('refuses a key that would climb out of the skills folder', () => {
    const dir = home();
    expect(getSkill(dir, '../../etc')).toBeNull();
    expect(() => putSkill(dir, '../escape', { content: '---\nname: x\n---\ny' })).toThrow(
      SkillError,
    );
  });

  it('says nothing at all when the agent has no skills folder yet', () => {
    expect(listSkills(mkdtempSync(path.join(tmpdir(), 'majlis-empty-')))).toEqual([]);
  });
});

describe('writing one back', () => {
  it('stores the document verbatim, so nothing a pack wrote is reshaped', () => {
    // A hub that re-serialised the front matter would be the thing that lost the licence,
    // the metadata and the prerequisites.
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    const edited = PACK_SKILL.replace('Diagrams and charts in Markdown.', 'A shorter one.');
    putSkill(dir, 'markdown-viewer', { content: edited });
    const text = readFileSync(path.join(dir, 'skills', 'markdown-viewer', 'SKILL.md'), 'utf8');
    expect(text).toBe(edited);
    expect(text).toContain('license: MIT');
    expect(text).toContain('commands: [node, npx]');
  });

  it('round-trips: what was read is what is read again, byte for byte', () => {
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    const before = getSkill(dir, 'markdown-viewer');
    putSkill(dir, 'markdown-viewer', { content: PACK_SKILL });
    const after = getSkill(dir, 'markdown-viewer');
    expect(after?.name).toBe(before?.name);
    expect(after?.description).toBe(before?.description);
    expect(after?.pack).toBe(before?.pack);
    expect(after?.content).toBe(PACK_SKILL);
  });

  it('refuses a document that is not a skill, before the agent fails to start', () => {
    // Hermes reads the front matter. Saying so here is kinder than a runtime that
    // refuses to boot tonight.
    const dir = home();
    expect(() => putSkill(dir, 'broken', { content: '# just a note\n' })).toThrow(
      /front_matter_missing/,
    );
    expect(() => putSkill(dir, 'nameless', { content: '---\nversion: 1\n---\nbody\n' })).toThrow(
      /name_required/,
    );
    expect(existsSync(path.join(dir, 'skills', 'broken'))).toBe(false);
  });

  it('creates the folder for a skill that did not exist', () => {
    const dir = home();
    const skill = putSkill(dir, 'brand-new', { content: '---\nname: Brand new\n---\n# hi\n' });
    expect(skill.name).toBe('Brand new');
    expect(existsSync(path.join(dir, 'skills', 'brand-new', 'SKILL.md'))).toBe(true);
  });
});

describe('turning one off', () => {
  it('renames the file rather than deleting anything', () => {
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    writeFileSync(path.join(dir, 'skills', 'markdown-viewer', 'script.js'), 'console.log(1)');

    const off = setSkillEnabled(dir, 'markdown-viewer', false);
    expect(off.enabled).toBe(false);
    expect(existsSync(path.join(dir, 'skills', 'markdown-viewer', 'SKILL.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'skills', 'markdown-viewer', 'SKILL.md.off'))).toBe(true);
    // Everything else is untouched, which is what makes turning it back on free.
    expect(existsSync(path.join(dir, 'skills', 'markdown-viewer', 'script.js'))).toBe(true);

    const on = setSkillEnabled(dir, 'markdown-viewer', true);
    expect(on.enabled).toBe(true);
    expect(on.description).toBe('Diagrams and charts in Markdown.');
  });

  it('still lists a disabled skill, and still reads it', () => {
    const dir = home();
    write(dir, 'paused', PACK_SKILL, true);
    const [skill] = listSkills(dir);
    expect(skill?.enabled).toBe(false);
    expect(getSkill(dir, 'paused')?.content).toBe(PACK_SKILL);
  });

  it('writing a disabled skill leaves it disabled', () => {
    const dir = home();
    write(dir, 'paused', PACK_SKILL, true);
    const written = putSkill(dir, 'paused', { content: '---\nname: paused\n---\nnew body\n' });
    expect(written.enabled).toBe(false);
  });

  it('says so when there is nothing to switch', () => {
    expect(() => setSkillEnabled(home(), 'ghost', true)).toThrow(/not_found/);
  });
});

describe('removing one', () => {
  it('takes the whole folder, because a skill is a folder', () => {
    const dir = home();
    write(dir, 'markdown-viewer', PACK_SKILL);
    writeFileSync(path.join(dir, 'skills', 'markdown-viewer', 'script.js'), 'x');
    deleteSkill(dir, 'markdown-viewer');
    expect(existsSync(path.join(dir, 'skills', 'markdown-viewer'))).toBe(false);
  });

  it('refuses to delete a folder that is not a skill', () => {
    const dir = home();
    mkdirSync(path.join(dir, 'skills', 'notes'), { recursive: true });
    expect(() => deleteSkill(dir, 'notes')).toThrow(/not_found/);
    expect(existsSync(path.join(dir, 'skills', 'notes'))).toBe(true);
  });
});

describe('the front-matter reader', () => {
  it('does not open a block it does not understand', () => {
    // `source` is indented under `metadata.hermes`; it is not a top-level field.
    const { fields } = parseFrontMatter(PACK_SKILL);
    expect(fields.get('name')).toBe('markdown-viewer');
    expect(fields.has('source')).toBe(false);
    expect(fields.has('commands')).toBe(false);
  });

  it('treats a file with no front matter as all body', () => {
    const { fields, body } = parseFrontMatter('# just a document\n');
    expect(fields.size).toBe(0);
    expect(body).toBe('# just a document\n');
  });

  it('treats an unterminated front matter as all body, not as half a skill', () => {
    const { raw } = parseFrontMatter('---\nname: x\nstill going\n');
    expect(raw).toBe('');
  });
});

/**
 * Hermes keeps its own skills one level down, in category folders, and records the ones it
 * seeded from its bundle (`tools/skills_sync.py`). Before, the page listed none of them.
 */
describe('skills in category folders, as Hermes keeps them', () => {
  function seed(dir: string, rel: string, name: string, description = `${name} skill`): void {
    mkdirSync(path.join(dir, 'skills', rel), { recursive: true });
    writeFileSync(
      path.join(dir, 'skills', rel, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`,
      'utf8',
    );
  }

  function hermesHome(): string {
    const dir = home();
    seed(dir, 'apple/apple-notes', 'apple-notes');
    seed(dir, 'apple/findmy', 'findmy');
    seed(dir, 'research/arxiv', 'arxiv');
    // A deeper layout Hermes also walks; the category is still the top folder.
    seed(dir, 'mlops/training/axolotl', 'axolotl');
    // A skill's own support folder is not a category, and Hermes's hub folder is skipped.
    seed(dir, 'research/arxiv/references/not-a-skill', 'not-a-skill');
    seed(dir, '.hub/cache/hidden', 'hidden');
    writeFileSync(
      path.join(dir, 'skills', 'apple', 'DESCRIPTION.md'),
      'Apple / macOS skills — tools that interact with the Mac desktop\n(Finder, native apps).\n\nSecond paragraph.\n',
    );
    writeFileSync(
      path.join(dir, 'skills', 'research', 'DESCRIPTION.md'),
      '---\ndescription: Finding and reading sources.\n---\n# Research\n',
    );
    writeFileSync(
      path.join(dir, 'skills', '.bundled_manifest'),
      'apple-notes:0f1e2d\nfindmy:aa11\narxiv:bb22\naxolotl:cc33\n',
    );
    // One the person wrote themselves, flat, as the hub has always written them.
    write(dir, 'my-notes', '---\nname: my-notes\ndescription: Mine.\n---\nbody\n');
    return dir;
  }

  it('lists every skill below a category folder, with its category, and the flat ones too', () => {
    const dir = hermesHome();
    const listed = listSkills(dir).map((skill) => [skill.key, skill.category, skill.bundled]);
    expect(listed).toEqual([
      ['apple-notes', 'apple', true],
      ['arxiv', 'research', true],
      ['axolotl', 'mlops', true],
      ['findmy', 'apple', true],
      ['my-notes', null, false],
    ]);
  });

  it("reads a category's own description: front matter, or its first paragraph", () => {
    const dir = hermesHome();
    expect(categoryDescription(dir, 'apple')).toBe(
      'Apple / macOS skills — tools that interact with the Mac desktop (Finder, native apps).',
    );
    expect(categoryDescription(dir, 'research')).toBe('Finding and reading sources.');
    expect(categoryDescription(dir, 'mlops')).toBeNull();
    expect(categoryDescription(dir, '../etc')).toBeNull();
  });

  it('reads a category skill by its folder name, whole document', () => {
    const dir = hermesHome();
    const skill = getSkill(dir, 'findmy');
    expect(skill?.category).toBe('apple');
    expect(skill?.content).toContain('name: findmy');
  });

  it("refuses to write, switch or delete a skill Hermes seeded, and leaves Hermes's copy alone", () => {
    const dir = hermesHome();
    const file = path.join(dir, 'skills', 'apple', 'findmy', 'SKILL.md');
    const before = readFileSync(file, 'utf8');
    expect(() => putSkill(dir, 'findmy', { content: '---\nname: findmy\n---\nmine\n' })).toThrow(
      /skill_bundled/,
    );
    expect(() => setSkillEnabled(dir, 'findmy', false)).toThrow(/skill_bundled/);
    expect(() => deleteSkill(dir, 'findmy')).toThrow(/skill_bundled/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it("writes, switches and deletes a category skill that is not Hermes's, where it is", () => {
    const dir = hermesHome();
    seed(dir, 'research/lit-review', 'lit-review');
    const folder = path.join(dir, 'skills', 'research', 'lit-review');
    const edited = '---\nname: lit-review\ndescription: Edited.\n---\nNew body.\n';
    const written = putSkill(dir, 'lit-review', { content: edited });
    expect(written.category).toBe('research');
    expect(readFileSync(path.join(folder, 'SKILL.md'), 'utf8')).toBe(edited);
    // Not a second copy directly under skills/.
    expect(existsSync(path.join(dir, 'skills', 'lit-review'))).toBe(false);

    setSkillEnabled(dir, 'lit-review', false);
    expect(existsSync(path.join(folder, 'SKILL.md.off'))).toBe(true);
    expect(listSkills(dir).find((skill) => skill.key === 'lit-review')?.enabled).toBe(false);

    deleteSkill(dir, 'lit-review');
    expect(existsSync(folder)).toBe(false);
    // The category folder is Hermes's and holds other skills.
    expect(existsSync(path.join(dir, 'skills', 'research', 'arxiv', 'SKILL.md'))).toBe(true);
  });

  it('a skill directly under skills/ wins over a category skill of the same folder name', () => {
    const dir = hermesHome();
    write(dir, 'arxiv', '---\nname: arxiv\ndescription: Mine.\n---\nbody\n');
    const arxiv = listSkills(dir).filter((skill) => skill.key === 'arxiv');
    expect(arxiv).toHaveLength(1);
    expect(arxiv[0]?.category).toBeNull();
  });
});
