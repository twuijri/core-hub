#!/usr/bin/env node
// The weekly models-catalogue watcher (DECISIONS §110; .github/workflows/models-catalog-watch.yml).
//
// Compares `catalog/models.json` with public lists kept by others and says, per provider key,
// which ids they list that we do not, and which of ours none of them lists any more. It only
// reports: it never writes the catalogue. A person checks each id against the provider's own
// documentation and changes the file by pull request (catalog/README.md).
//
//   node scripts/models-catalog-watch.mjs [--catalog catalog/models.json]
//     [--ignore catalog/watch-ignore.json] [--body report.md] [--summary summary.json]
//
// No token, no key: every source is a public file. Exit 1 only when no source could be read.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** CLI Proxy API (MIT, router-for-me): catalogues refreshed from its own repository. */
export const SOURCES = {
  models: 'https://raw.githubusercontent.com/router-for-me/models/main/models.json',
  codexClient:
    'https://raw.githubusercontent.com/router-for-me/models/main/codex_client_models.json',
  codexImages:
    'https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/registry/model_definitions.go',
};

/**
 * CLI Proxy API's sections of `models.json`, by our provider key (a preset slug or a signed-in
 * Hermes provider id). `claude` is Claude Code's sign-in, whose ids are the API's; `xai` is the
 * Grok sign-in, the same ids as the xAI API.
 */
export const SECTION_KEYS = {
  claude: ['anthropic'],
  gemini: ['google'],
  aistudio: ['google'],
  'codex-free': ['openai-codex'],
  'codex-plus': ['openai-codex'],
  'codex-pro': ['openai-codex'],
  'codex-team': ['openai-codex'],
  xai: ['xai', 'xai-oauth'],
};

/** Sections that are not one of our providers (Vertex, the Gemini CLI, Antigravity, Kimi, Meta). */
export const OTHER_SECTIONS = new Set(['vertex', 'gemini-cli', 'antigravity', 'kimi', 'meta']);

/** The pseudo key the Codex image models are compared under. */
export const CODEX_IMAGES_KEY = 'openai-codex (image_models)';

/**
 * The form two ids are compared in: case aside, and a dated snapshot (`-20251001`,
 * `-2026-04-23`) is the same model as its alias.
 */
export function comparable(id) {
  return String(id)
    .trim()
    .toLowerCase()
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

const isId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value.trim());

/** CLI Proxy API's `models.json`: `{ section: [{ id }] }` → Map(section → ids). */
export function parseSections(json) {
  const sections = new Map();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return sections;
  for (const [section, items] of Object.entries(json)) {
    if (!Array.isArray(items)) continue;
    const ids = items
      .map((item) => item?.id)
      .filter(isId)
      .map((id) => id.trim());
    sections.set(section, [...new Set(ids)]);
  }
  return sections;
}

/** `codex_client_models.json`: the slugs the Codex backend shows (`visibility: list`). */
export function parseCodexClient(json) {
  const models = Array.isArray(json?.models) ? json.models : [];
  return [
    ...new Set(
      models
        .filter((model) => model && (model.visibility === undefined || model.visibility === 'list'))
        .map((model) => model.slug)
        .filter(isId)
        .map((slug) => slug.trim()),
    ),
  ];
}

/** The image model names in CLI Proxy API's Go source (`codexBuiltinImage*ModelID = "…"`). */
export function parseCodexImages(source) {
  const found = [];
  for (const match of String(source ?? '').matchAll(
    /codexBuiltinImage\w*ModelID\s*=\s*"([^"\n]+)"/g,
  )) {
    if (/^(gpt-image-|chatgpt-image-)/.test(match[1]) && isId(match[1])) found.push(match[1]);
  }
  return [...new Set(found)];
}

/**
 * What the readable sources list, by our key: only for a key some source covers can an id of
 * ours be said to be no longer listed. Sections neither mapped nor known are `unknownSections`.
 */
export function seenByKey({ sections, codexClient, codexImages }) {
  const seen = new Map();
  const add = (key, ids) => {
    if (!seen.has(key)) seen.set(key, new Set());
    for (const id of ids) seen.get(key).add(id);
  };
  const unknownSections = [];
  if (sections) {
    for (const [section, ids] of sections) {
      const keys = SECTION_KEYS[section];
      if (keys) for (const key of keys) add(key, ids);
      else if (!OTHER_SECTIONS.has(section) && /^[A-Za-z0-9._-]{1,64}$/.test(section)) {
        unknownSections.push(section);
      }
    }
  }
  if (codexClient) add('openai-codex', codexClient);
  if (codexImages && codexImages.length > 0) add(CODEX_IMAGES_KEY, codexImages);
  return { seen, unknownSections };
}

/** Our catalogue, by the same keys (image models under {@link CODEX_IMAGES_KEY}). */
export function oursByKey(catalog) {
  const ours = new Map();
  for (const [key, entry] of Object.entries(catalog?.providers ?? {})) {
    if (Array.isArray(entry?.models)) ours.set(key, entry.models.filter(isId));
    if (Array.isArray(entry?.image_models) && entry.image_models.length > 0) {
      ours.set(
        key === 'openai-codex' ? CODEX_IMAGES_KEY : `${key} (image_models)`,
        entry.image_models.filter(isId),
      );
    }
  }
  return ours;
}

/**
 * The differences, per key: `added` — ids a source lists that we do not have; `gone` — ids of
 * ours that no source covering the key lists. An id in `ignore` (decided on already: a retired
 * model a source still lists, or one of ours a source never will) is in neither. Keys of ours
 * no source covers are `unwatched`.
 */
export function compare(ours, seen, ignore = {}) {
  const changes = [];
  const unwatched = [];
  const keys = [...new Set([...ours.keys(), ...seen.keys()])].sort();
  for (const key of keys) {
    const mine = ours.get(key) ?? [];
    const theirs = seen.get(key);
    if (!theirs) {
      unwatched.push(key);
      continue;
    }
    const mineSet = new Set(mine.map(comparable));
    const ignored = new Set((ignore[key] ?? []).map(comparable));
    const theirSet = new Set([...theirs].map(comparable));
    const added = [...theirs].filter(
      (id) => !mineSet.has(comparable(id)) && !ignored.has(comparable(id)),
    );
    const gone = mine.filter((id) => !theirSet.has(comparable(id)) && !ignored.has(comparable(id)));
    // Two dated snapshots of one alias collapse to one line.
    const dedupe = (ids) => [...new Map(ids.map((id) => [comparable(id), id])).values()];
    if (added.length > 0 || gone.length > 0) {
      changes.push({ key, inCatalog: mine.length > 0, added: dedupe(added), gone });
    }
  }
  return { changes, unwatched };
}

/** The issue body (Markdown). */
export function render({ changes, unwatched, unknownSections, errors, checkedAt }) {
  const lines = [
    '<!-- models-catalog-watch -->',
    `Weekly comparison of \`catalog/models.json\` with public model lists, ${checkedAt}.`,
    '',
    'Nothing here is changed automatically. Check each id against the provider’s own',
    'documentation (and its deprecations page) before editing `catalog/models.json` by pull',
    'request; an id already decided on goes into `catalog/watch-ignore.json`. See',
    '`catalog/README.md`.',
    '',
  ];
  if (changes.length === 0) {
    lines.push('No differences.');
  }
  for (const change of changes) {
    lines.push(`### \`${change.key}\`${change.inCatalog ? '' : ' (not in our catalogue)'}`);
    if (change.added.length > 0) {
      lines.push('', 'Listed elsewhere, not ours:', '');
      for (const id of change.added) lines.push(`- \`${id}\``);
    }
    if (change.gone.length > 0) {
      lines.push('', 'Ours, no longer listed by any source:', '');
      for (const id of change.gone) lines.push(`- \`${id}\``);
    }
    lines.push('');
  }
  if (unwatched.length > 0) {
    lines.push(
      '',
      `Not covered by these sources (check by hand): ${unwatched.map((key) => `\`${key}\``).join(', ')}.`,
    );
  }
  if (unknownSections.length > 0) {
    lines.push(
      '',
      `New CLI Proxy API sections, not mapped to a provider of ours: ${unknownSections
        .map((section) => `\`${section}\``)
        .join(', ')} (\`scripts/models-catalog-watch.mjs\`).`,
    );
  }
  if (errors.length > 0) {
    lines.push('', 'Sources that could not be read this time:', '');
    // A source's own words never reach the issue as Markdown (no mentions, no links).
    for (const error of errors) lines.push(`- \`${error.replace(/[`\n\r]/g, ' ').slice(0, 300)}\``);
  }
  lines.push(
    '',
    `Sources: [CLI Proxy API models](${SOURCES.models}), [Codex client models](${SOURCES.codexClient}), [Codex image names](${SOURCES.codexImages}).`,
  );
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

async function read(fetcher, url, kind) {
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'core-hub-models-catalog-watch' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('larger than 8 MB');
  return kind === 'json' ? JSON.parse(text) : text;
}

/** Reads the sources and compares; never throws for a source, it is reported instead. */
export async function watch({ catalog, ignore = {}, fetch: fetcher = fetch, now = new Date() }) {
  const errors = [];
  const attempt = async (url, kind, parse) => {
    try {
      return parse(await read(fetcher, url, kind));
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const sections = await attempt(SOURCES.models, 'json', parseSections);
  const codexClient = await attempt(SOURCES.codexClient, 'json', parseCodexClient);
  const codexImages = await attempt(SOURCES.codexImages, 'text', parseCodexImages);
  if (codexImages && codexImages.length === 0) {
    errors.push(`${SOURCES.codexImages}: no codexBuiltinImage*ModelID constant found`);
  }
  const { seen, unknownSections } = seenByKey({ sections, codexClient, codexImages });
  const { changes, unwatched } = compare(oursByKey(catalog), seen, ignore);
  const report = {
    checkedAt: now.toISOString().slice(0, 10),
    changes,
    unwatched,
    unknownSections,
    errors,
    sourcesRead: [sections, codexClient, codexImages].filter(Boolean).length,
  };
  return { ...report, body: render(report) };
}

function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

async function main(argv) {
  const catalogPath = argument(argv, '--catalog', path.join(ROOT, 'catalog/models.json'));
  const ignorePath = argument(argv, '--ignore', path.join(ROOT, 'catalog/watch-ignore.json'));
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const ignore = JSON.parse(readFileSync(ignorePath, 'utf8')).ignore ?? {};
  const result = await watch({ catalog, ignore });
  const bodyPath = argument(argv, '--body', null);
  const summaryPath = argument(argv, '--summary', null);
  if (bodyPath) writeFileSync(bodyPath, result.body);
  else process.stdout.write(result.body);
  const summary = {
    differences: result.changes.length > 0 || result.unknownSections.length > 0,
    changes: result.changes,
    errors: result.errors,
    sourcesRead: result.sourcesRead,
  };
  if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (result.sourcesRead === 0) {
    process.stderr.write('No source could be read.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
