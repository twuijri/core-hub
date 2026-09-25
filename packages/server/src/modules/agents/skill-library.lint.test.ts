/**
 * A lint of the skills Core Hub ships (`packages/server/skill-library/`, decision §60), and the
 * helper scripts run for real where a Python 3 is available:
 *
 * - every skill folder has a `SKILL.md` whose front matter is valid YAML, names the folder, has a
 *   one-sentence description Hermes will not truncate (≤ 60 characters, ending with a period —
 *   Hermes cuts longer ones in the prompt, `agent/skill_utils.py` §SKILL_PROMPT_DESC_LIMIT), the
 *   Apache-2.0 licence, the `core-hub` category and tags in Arabic as well as English;
 * - names are unique and none is the name of a skill Hermes ships (a clash would hide one);
 * - there is something for images (the owner's requirement) and the two copies of the image API
 *   script are the same file;
 * - the scripts work: charts from a CSV, an Arabic document's direction fixed, a translation
 *   checked, a deck built, a long text chunked, and images generated, edited and varied against a
 *   scripted OpenAI-style and Gemini-style endpoint — with the key sent and never printed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LIBRARY_CATEGORY, LIBRARY_SOURCE, readLibrary } from './skill-library.js';

/** Hermes's built-in skills at the pinned tag (v2026.9.14), `skills/` and `optional-skills/`. */
const HERMES_SKILLS = new Set(
  (
    'airtable apple-notes apple-reminders architecture-diagram arxiv ascii-video baoyu-infographic ' +
    'blocked-page-recovery box claude-code claude-design codebase-inspection codex ' +
    'competitor-news-monitor computer-use design-md document-to-action-items docx dogfood ' +
    'email-inbox-triage findmy gif-search github google-workspace grounded-citations hermes-agent ' +
    'hermes-agent-skill-authoring himalaya humanizer imessage inspecting-hermes-desktop-dom llm-wiki ' +
    'manim-video maps meeting-action-items node-inspect-debugger notion obsidian opencode p5js pdf ' +
    'popular-web-designs powerpoint product-price-monitor python-debugpy requesting-code-review ' +
    'sdlc-review simplify-code songsee songwriting-and-ai-music spike systematic-debugging ' +
    'teams-meeting-pipeline test-driven-development weekly-review-planning xlsx xurl youtube-content ' +
    'stable-diffusion clip whisper llava segment-anything-model'
  ).split(' '),
);

const ARABIC = /[\u0600-\u06FF]/;

interface FrontMatter {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  license?: unknown;
  author?: unknown;
  platforms?: unknown;
  required_environment_variables?: unknown;
  metadata?: { hermes?: { tags?: unknown; category?: unknown; related_skills?: unknown } };
}

function frontMatter(text: string): FrontMatter {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('no front matter');
  return parse(match[1]!) as FrontMatter;
}

const skillFolders = readdirSync(LIBRARY_SOURCE).filter((name) =>
  statSync(path.join(LIBRARY_SOURCE, name)).isDirectory(),
);

describe('the skills Core Hub ships', () => {
  it('ships between ten and fifteen skills, each a folder with a SKILL.md', () => {
    expect(skillFolders.length).toBeGreaterThanOrEqual(10);
    expect(skillFolders.length).toBeLessThanOrEqual(15);
    for (const folder of skillFolders) {
      expect(existsSync(path.join(LIBRARY_SOURCE, folder, 'SKILL.md')), folder).toBe(true);
    }
    expect(readLibrary().skills.size).toBe(skillFolders.length);
  });

  it.each(skillFolders)('%s: valid front matter Hermes can match against', (folder) => {
    const text = readFileSync(path.join(LIBRARY_SOURCE, folder, 'SKILL.md'), 'utf8');
    const meta = frontMatter(text);
    expect(meta.name).toBe(folder);
    expect(folder).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(typeof meta.description).toBe('string');
    const description = meta.description as string;
    expect(description.length, description).toBeLessThanOrEqual(60);
    expect(description.endsWith('.'), description).toBe(true);
    expect(meta.license).toBe('Apache-2.0');
    expect(String(meta.author)).toContain('Core Hub');
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(meta.platforms).toEqual(['linux', 'macos', 'windows']);
    expect(meta.metadata?.hermes?.category).toBe(LIBRARY_CATEGORY);
    const tags = meta.metadata?.hermes?.tags as string[];
    expect(Array.isArray(tags)).toBe(true);
    // Works in both languages: English words and Arabic words to match a request by.
    expect(
      tags.some((tag) => ARABIC.test(tag)),
      `${folder}: an Arabic tag`,
    ).toBe(true);
    expect(
      tags.some((tag) => /^[a-z]/.test(tag)),
      `${folder}: an English tag`,
    ).toBe(true);
    // The body: the sections a model needs, and a line in Arabic.
    const body = text.slice(text.indexOf('\n---\n', 4) + 5);
    for (const section of ['## When to Use', '## Procedure', '## Pitfalls', '## Verification']) {
      expect(body, `${folder}: ${section}`).toContain(section);
    }
    expect(ARABIC.test(body), `${folder}: an Arabic line`).toBe(true);
    // A key is only ever read from the environment: nothing that looks like one is written down.
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}/);
  });

  it('has unique names, none of them a skill Hermes ships', () => {
    const names = skillFolders.map(
      (folder) =>
        frontMatter(readFileSync(path.join(LIBRARY_SOURCE, folder, 'SKILL.md'), 'utf8')).name,
    );
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(HERMES_SKILLS.has(String(name)), String(name)).toBe(false);
  });

  it('has something for images: generate, edit, describe and convert', () => {
    for (const name of ['image-generate', 'image-edit', 'image-describe', 'image-convert']) {
      expect(skillFolders).toContain(name);
    }
    // One script, shipped in both skills that use it; they must not drift apart.
    expect(
      readFileSync(path.join(LIBRARY_SOURCE, 'image-edit', 'scripts', 'image_api.py'), 'utf8'),
    ).toBe(
      readFileSync(path.join(LIBRARY_SOURCE, 'image-generate', 'scripts', 'image_api.py'), 'utf8'),
    );
  });

  it('names only scripts that exist, and every script is referenced by its skill', () => {
    for (const folder of skillFolders) {
      const text = readFileSync(path.join(LIBRARY_SOURCE, folder, 'SKILL.md'), 'utf8');
      for (const match of text.matchAll(/<skill_dir>\/(scripts\/[\w.-]+)/g)) {
        expect(existsSync(path.join(LIBRARY_SOURCE, folder, match[1]!)), match[1]).toBe(true);
      }
      const scripts = path.join(LIBRARY_SOURCE, folder, 'scripts');
      if (!existsSync(scripts)) continue;
      for (const script of readdirSync(scripts)) {
        expect(text, `${folder} mentions scripts/${script}`).toContain(`scripts/${script}`);
      }
    }
  });

  it('describes its category for Hermes', () => {
    const text = readFileSync(path.join(LIBRARY_SOURCE, 'DESCRIPTION.md'), 'utf8');
    expect(typeof frontMatter(text).description).toBe('string');
  });
});

// ---------------------------------------------------------------- the scripts, for real

function python(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' });
      if (/Python 3\.(\d+)/.test(version) && Number(/Python 3\.(\d+)/.exec(version)![1]) >= 9) {
        return candidate;
      }
    } catch {
      // not there
    }
  }
  return null;
}
const PY = python();
const hasPillow = (() => {
  if (!PY) return false;
  try {
    execFileSync(PY, ['-c', 'import PIL'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function run(
  script: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number; json: Record<string, unknown>; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PY!, [path.join(LIBRARY_SOURCE, script), ...args], {
      cwd: options.cwd,
      // A clean environment: only what the test gives, so no key from the machine leaks in.
      env: { PATH: process.env.PATH ?? '', ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // left empty; the assertion on `ok` says so
      }
      resolve({ code: code ?? -1, json, stdout, stderr });
    });
  });
}

describe.skipIf(!PY)('the library’s helper scripts (Python 3)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'corehub-skill-scripts-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('every script compiles', () => {
    for (const folder of skillFolders) {
      const scripts = path.join(LIBRARY_SOURCE, folder, 'scripts');
      if (!existsSync(scripts)) continue;
      for (const script of readdirSync(scripts).filter((name) => name.endsWith('.py'))) {
        const source = readFileSync(path.join(scripts, script), 'utf8');
        expect(() =>
          execFileSync(PY!, ['-c', 'import sys; compile(sys.stdin.read(), "s", "exec")'], {
            input: source,
          }),
        ).not.toThrow();
      }
    }
  });

  it('data-to-chart: a CSV with Arabic headers and digits becomes a table, stats and an SVG', async () => {
    writeFileSync(
      path.join(dir, 'sales.csv'),
      'المنطقة,المبيعات\nالرياض,"1,200"\nجدة,٩٠٠\nالرياض,300\n',
    );
    const script = 'data-to-chart/scripts/table_chart.py';
    const inspect = await run(script, ['inspect', 'sales.csv'], { cwd: dir });
    expect(inspect.json).toMatchObject({ ok: true, rows: 3 });
    const stats = await run(script, ['stats', 'sales.csv'], { cwd: dir });
    expect(stats.json.stats).toEqual([
      expect.objectContaining({ column: 'المبيعات', sum: 2400, max: 1200 }),
    ]);
    const table = await run(script, ['table', 'sales.csv', '--sort', 'المبيعات', '--desc'], {
      cwd: dir,
    });
    expect(String(table.json.markdown).split('\n')[2]).toBe('| الرياض | 1,200 |');
    const chart = await run(
      script,
      ['chart', 'sales.csv', '--x', 'المنطقة', '--y', 'المبيعات', '--out', 'c.svg'],
      { cwd: dir },
    );
    expect(chart.json).toMatchObject({ ok: true, points: 2, aggregate: 'sum' });
    const svg = readFileSync(path.join(dir, 'c.svg'), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('direction="rtl"');
    const missing = await run(script, ['inspect', 'nope.csv'], { cwd: dir });
    expect(missing.code).toBe(2);
    expect(missing.json).toMatchObject({ ok: false, error: 'file_not_found' });
  });

  it('report-writer: an Arabic line that starts in Latin gets a right-to-left mark and Arabic punctuation', async () => {
    writeFileSync(path.join(dir, 'r.md'), '# تقرير\n- API جديدة, وهي مفيدة\nهل هذا صحيح?\n');
    const script = 'report-writer/scripts/rtl_md.py';
    const check = await run(script, ['check', 'r.md'], { cwd: dir });
    expect(check.json.count).toBe(3);
    await run(script, ['fix', 'r.md', '--out', 'r.md'], { cwd: dir });
    expect(readFileSync(path.join(dir, 'r.md'), 'utf8')).toBe(
      '# تقرير\n- \u200fAPI جديدة، وهي مفيدة\nهل هذا صحيح؟\n',
    );
    expect((await run(script, ['check', 'r.md'], { cwd: dir })).json.count).toBe(0);
  });

  it('translate: a translation that lost a link, a placeholder and a number is caught', async () => {
    writeFileSync(path.join(dir, 'en.md'), '# Hi {name}\n\n- 3 items\n- [site](https://a.b/c)\n');
    writeFileSync(
      path.join(dir, 'ar.md'),
      '# مرحبًا {name}\n\n- ٣ عناصر\n- [الموقع](https://a.b/c)\n',
    );
    writeFileSync(path.join(dir, 'bad.md'), '# مرحبًا\n\n- عناصر\n');
    const script = 'translate/scripts/translate_check.py';
    expect((await run(script, ['en.md', 'ar.md'], { cwd: dir })).json).toMatchObject({
      clean: true,
    });
    const bad = await run(script, ['en.md', 'bad.md'], { cwd: dir });
    expect(bad.json.clean).toBe(false);
    const checks = (bad.json.problems as Array<{ check: string }>).map((p) => p.check);
    expect(checks).toEqual(
      expect.arrayContaining(['list_items', 'link_targets', 'placeholders', 'numbers']),
    );
  });

  it('slides-html: a deck with an Arabic and an English slide, notes and code', async () => {
    writeFileSync(
      path.join(dir, 'deck.md'),
      '# العرض\n\nملاحظة: سرّي\n\n---\n\n## English\n\n- one\n\n```\n<b>x</b>\n```\n',
    );
    const built = await run('slides-html/scripts/make_slides.py', ['deck.md'], { cwd: dir });
    expect(built.json).toMatchObject({ ok: true, slides: 2 });
    const html = readFileSync(path.join(dir, 'deck.html'), 'utf8');
    expect(html).toContain('<section class="slide" dir="rtl"');
    expect(html).toContain('<section class="slide" dir="ltr"');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('<aside class="notes"');
    // Nothing loaded from elsewhere: it opens in the sandboxed preview and offline.
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=["']https?:/);
  });

  it('summarize: a long text is cut into ordered chunks under the limit', async () => {
    writeFileSync(
      path.join(dir, 'long.md'),
      `# One\n\n${'جملة قصيرة. '.repeat(400)}\n\n# Two\n\n${'Another line.\n\n'.repeat(200)}`,
    );
    const chunks = await run('summarize/scripts/chunk.py', ['long.md', '--max-chars', '2000'], {
      cwd: dir,
    });
    const list = chunks.json.chunks as Array<{ index: number; chars: number }>;
    expect(list.length).toBeGreaterThan(2);
    expect(list.map((chunk) => chunk.index)).toEqual(list.map((_, i) => i + 1));
    for (const chunk of list) expect(chunk.chars).toBeLessThanOrEqual(2000);
  });

  describe('image-generate / image-edit against a scripted image endpoint', () => {
    let server: Server;
    let base = '';
    const seen: Array<{ url: string; auth: string | undefined; google: string | undefined }> = [];
    // A 1×1 PNG.
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    beforeAll(async () => {
      server = createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          seen.push({
            url: request.url ?? '',
            auth: request.headers.authorization,
            google: request.headers['x-goog-api-key'] as string | undefined,
          });
          response.setHeader('content-type', 'application/json');
          if (request.url?.includes('refuse')) {
            response.statusCode = 400;
            response.end('{"error":{"message":"prompt refused"}}');
          } else if (request.url?.includes(':predict')) {
            response.end(JSON.stringify({ predictions: [{ bytesBase64Encoded: PNG }] }));
          } else if (request.url?.includes(':generateContent')) {
            response.end(
              JSON.stringify({
                candidates: [
                  { content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } },
                ],
              }),
            );
          } else {
            response.end(JSON.stringify({ data: [{ b64_json: PNG, revised_prompt: 'fox' }] }));
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      writeFileSync(path.join(dir, 'photo.png'), Buffer.from(PNG, 'base64'));
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('generates through an OpenAI-compatible endpoint, sending the key and never printing it', async () => {
      const result = await run(
        'image-generate/scripts/image_api.py',
        ['generate', '--prompt', 'a red fox', '--out', 'out'],
        {
          cwd: dir,
          env: { COREHUB_IMAGE_BASE_URL: `${base}/v1`, COREHUB_IMAGE_API_KEY: 'sk-secret-123' },
        },
      );
      expect(result.json).toMatchObject({ ok: true, provider: 'compatible' });
      const file = (result.json.files as string[])[0]!;
      expect(readFileSync(path.join(dir, file)).subarray(1, 4).toString()).toBe('PNG');
      expect(seen.at(-1)).toMatchObject({
        url: '/v1/images/generations',
        auth: 'Bearer sk-secret-123',
      });
      expect(result.stdout + result.stderr).not.toContain('sk-secret-123');
    });

    it('edits and varies an image, and reports a refusal in the provider’s words', async () => {
      const env = { COREHUB_IMAGE_BASE_URL: `${base}/v1` };
      const edit = await run(
        'image-edit/scripts/image_api.py',
        ['edit', '--image', 'photo.png', '--prompt', 'make it blue', '--out', 'out'],
        { cwd: dir, env },
      );
      expect(edit.json).toMatchObject({ ok: true, command: 'edit' });
      expect(seen.at(-1)?.url).toBe('/v1/images/edits');
      const vary = await run(
        'image-edit/scripts/image_api.py',
        ['vary', '--image', 'photo.png', '--out', 'out'],
        { cwd: dir, env },
      );
      expect(vary.json).toMatchObject({ ok: true, command: 'vary' });
      expect(seen.at(-1)?.url).toBe('/v1/images/variations');
      const refused = await run(
        'image-generate/scripts/image_api.py',
        ['generate', '--prompt', 'x'],
        { cwd: dir, env: { COREHUB_IMAGE_BASE_URL: `${base}/refuse` } },
      );
      expect(refused.code).toBe(2);
      expect(refused.json).toMatchObject({ ok: false, error: 'api_error', status: 400 });
      expect(String(refused.json.detail)).toContain('prompt refused');
    });

    it('uses Gemini/Imagen with the Gemini key, and says which key is missing', async () => {
      const gemini = await run(
        'image-generate/scripts/image_api.py',
        [
          'generate',
          '--prompt',
          'a cat',
          '--provider',
          'gemini',
          '--aspect',
          '16:9',
          '--out',
          'out',
        ],
        { cwd: dir, env: { COREHUB_IMAGE_BASE_URL: `${base}/v1beta`, GEMINI_API_KEY: 'g-key' } },
      );
      expect(gemini.json).toMatchObject({ ok: true, provider: 'gemini' });
      expect(seen.at(-1)).toMatchObject({
        url: '/v1beta/models/imagen-4.0-generate-001:predict',
        google: 'g-key',
      });
      const none = await run('image-generate/scripts/image_api.py', ['generate', '--prompt', 'x'], {
        cwd: dir,
      });
      expect(none.json).toMatchObject({ ok: false, error: 'api_key_missing' });
      expect(none.json.looked_for).toEqual(['COREHUB_IMAGE_API_KEY', 'OPENAI_API_KEY']);
    });
  });

  describe.skipIf(!hasPillow)('image-convert and image-describe (Pillow)', () => {
    it('resizes, crops to an aspect, compresses under a size and clears a plain background', async () => {
      execFileSync(
        PY!,
        [
          '-c',
          [
            'from PIL import Image, ImageDraw',
            'im = Image.new("RGB", (400, 300), (255, 255, 255))',
            'ImageDraw.Draw(im).ellipse((100, 50, 300, 250), fill=(200, 30, 30))',
            'im.save("logo.jpg", quality=95)',
          ].join('\n'),
        ],
        { cwd: dir },
      );
      const script = 'image-convert/scripts/image_tools.py';
      expect(
        (await run(script, ['resize', 'logo.jpg', '--max', '200'], { cwd: dir })).json,
      ).toMatchObject({ ok: true, width: 200, height: 150 });
      expect(
        (await run(script, ['crop', 'logo.jpg', '--aspect', '1:1'], { cwd: dir })).json,
      ).toMatchObject({ ok: true, width: 300, height: 300 });
      const small = await run(script, ['compress', 'logo.jpg', '--max-kb', '6'], { cwd: dir });
      expect(small.json.ok).toBe(true);
      expect(Number(small.json.bytes)).toBeLessThanOrEqual(6 * 1024);
      const clear = await run(script, ['transparent-bg', 'logo.jpg'], { cwd: dir });
      expect(clear.json).toMatchObject({ ok: true, background: '#ffffff' });
      expect(Number(clear.json.cleared_share)).toBeGreaterThan(0.5);
      // The source is never replaced.
      expect(existsSync(path.join(dir, 'logo.jpg'))).toBe(true);
      const prepared = await run(
        'image-describe/scripts/ocr_prep.py',
        ['prepare', 'logo.jpg', '--enhance'],
        { cwd: dir },
      );
      expect(prepared.json).toMatchObject({ ok: true, tiles: 1, enhanced: true });
    });
  });
});
