// pnpm scripts:test — the weekly models-catalogue watcher, against stand-in sources.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODEX_IMAGES_KEY,
  SOURCES,
  comparable,
  compare,
  oursByKey,
  parseCodexClient,
  parseCodexImages,
  parseSections,
  seenByKey,
  watch,
} from './models-catalog-watch.mjs';

const GO = `
const (
	codexBuiltinImage15ModelID         = "gpt-image-1.5"
	codexBuiltinImageModelID           = "gpt-image-2"
	codexBuiltinImage3ModelID = "gpt-image-3"
	someOtherModelID = "not-an-image"
	codexBuiltinImageBrokenModelID = "rm -rf /"
)`;

const CATALOG = {
  schema: 1,
  providers: {
    anthropic: { models: ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-retired-1'] },
    'openai-codex': {
      models: ['gpt-6-sol', 'gpt-5.5'],
      image_models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-old'],
      client_version: '0.157.1',
    },
    mistral: { models: ['mistral-large-latest'] },
  },
};

const MODELS = {
  claude: [
    { id: 'claude-opus-5-5' },
    { id: 'claude-haiku-4-5-20251001' },
    { id: 'claude-new-6' },
    { id: 'claude-3-7-sonnet-20250219' },
    { id: 42 },
    { nope: true },
  ],
  'codex-plus': [{ id: 'gpt-6-sol' }, { id: 'gpt-5.5' }, { id: 'codex-auto-review' }],
  xai: [{ id: 'grok-4.7' }],
  kimi: [{ id: 'kimi-k3' }],
  brandnew: [{ id: 'x-1' }],
  notalist: { id: 'x' },
};

const CLIENT = {
  models: [
    { slug: 'gpt-6-sol', visibility: 'list' },
    { slug: 'gpt-7', visibility: 'list' },
    { slug: 'gpt-reserve', visibility: 'hide' },
    { slug: '../bad id', visibility: 'list' },
  ],
};

describe('parsing the sources defensively', () => {
  it('reads sections of ids and drops what is not an id', () => {
    const sections = parseSections(MODELS);
    assert.deepEqual(sections.get('claude'), [
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
      'claude-new-6',
      'claude-3-7-sonnet-20250219',
    ]);
    assert.equal(sections.has('notalist'), false);
    assert.equal(parseSections(null).size, 0);
    assert.equal(parseSections([1, 2]).size, 0);
  });

  it('keeps only the Codex slugs the backend shows', () => {
    assert.deepEqual(parseCodexClient(CLIENT), ['gpt-6-sol', 'gpt-7']);
    assert.deepEqual(parseCodexClient({}), []);
    assert.deepEqual(parseCodexClient('garbage'), []);
  });

  it('finds the image model constants and nothing else in the Go source', () => {
    assert.deepEqual(parseCodexImages(GO), ['gpt-image-1.5', 'gpt-image-2', 'gpt-image-3']);
    assert.deepEqual(parseCodexImages(''), []);
    assert.deepEqual(parseCodexImages(undefined), []);
  });

  it('compares a dated snapshot as its alias, case aside', () => {
    assert.equal(comparable('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(comparable('gpt-5.5-2026-04-23'), 'gpt-5.5');
    assert.equal(comparable('MiniMax-M3'), 'minimax-m3');
    assert.equal(comparable('gpt-5.5'), 'gpt-5.5');
  });
});

describe('comparing with our catalogue', () => {
  const { seen, unknownSections } = seenByKey({
    sections: parseSections(MODELS),
    codexClient: parseCodexClient(CLIENT),
    codexImages: parseCodexImages(GO),
  });

  it('maps sections to our keys and says which sections are new', () => {
    assert.deepEqual([...seen.get('xai')], ['grok-4.7']);
    assert.deepEqual([...seen.get('xai-oauth')], ['grok-4.7']);
    assert.ok(seen.get('openai-codex').has('gpt-7'));
    assert.deepEqual(unknownSections, ['brandnew']);
    assert.equal(seen.has('kimi'), false);
  });

  it('lists new ids, ids no source lists any more, and keys nobody covers', () => {
    const { changes, unwatched } = compare(oursByKey(CATALOG), seen, {
      anthropic: ['claude-3-7-sonnet-20250219'],
      'openai-codex': ['codex-auto-review'],
    });
    const byKey = Object.fromEntries(changes.map((change) => [change.key, change]));
    assert.deepEqual(byKey.anthropic.added, ['claude-new-6']);
    assert.deepEqual(byKey.anthropic.gone, ['claude-retired-1']);
    assert.deepEqual(byKey['openai-codex'].added, ['gpt-7']);
    assert.deepEqual(byKey['openai-codex'].gone, []);
    assert.deepEqual(byKey[CODEX_IMAGES_KEY].added, ['gpt-image-3']);
    assert.deepEqual(byKey[CODEX_IMAGES_KEY].gone, ['gpt-image-old']);
    assert.equal(byKey.xai.inCatalog, false);
    assert.deepEqual(unwatched, ['mistral']);
  });

  it('says nothing about a key whose source could not be read', () => {
    const { changes, unwatched } = compare(oursByKey(CATALOG), new Map());
    assert.deepEqual(changes, []);
    assert.deepEqual(unwatched, ['anthropic', 'mistral', 'openai-codex', CODEX_IMAGES_KEY]);
  });
});

describe('a whole run', () => {
  const serve = (routes) => async (url) => {
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };

  it('reports the differences as an issue body, sources linked', async () => {
    const result = await watch({
      catalog: CATALOG,
      ignore: { anthropic: ['claude-3-7-sonnet-20250219'] },
      fetch: serve({
        [SOURCES.models]: MODELS,
        [SOURCES.codexClient]: CLIENT,
        [SOURCES.codexImages]: GO,
      }),
      now: new Date('2026-09-26T08:00:00Z'),
    });
    assert.equal(result.sourcesRead, 3);
    assert.deepEqual(result.errors, []);
    assert.match(result.body, /^<!-- models-catalog-watch -->/);
    assert.match(result.body, /2026-09-26/);
    assert.match(result.body, /- `claude-new-6`/);
    assert.match(result.body, /- `claude-retired-1`/);
    assert.doesNotMatch(result.body, /claude-3-7-sonnet/);
    assert.match(result.body, /`brandnew`/);
    assert.match(result.body, /Not covered by these sources \(check by hand\): `mistral`/);
    assert.ok(result.body.includes(SOURCES.models));
  });

  it('keeps going when a source is down or not what it was, and says so', async () => {
    const result = await watch({
      catalog: CATALOG,
      fetch: serve({ [SOURCES.models]: MODELS, [SOURCES.codexClient]: '{not json' }),
    });
    assert.equal(result.sourcesRead, 1);
    assert.equal(result.errors.length, 2);
    assert.match(result.body, /could not be read/);
    assert.match(result.body, /HTTP 404/);
  });

  it('reads nothing when everything is down, and invents no differences', async () => {
    const result = await watch({ catalog: CATALOG, fetch: serve({}) });
    assert.equal(result.sourcesRead, 0);
    assert.deepEqual(result.changes, []);
  });
});
