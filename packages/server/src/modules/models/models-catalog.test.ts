// The shared models catalogue (decision §110): the repository's file parses, a hub reads it at
// most every twelve hours, and whatever else is in it never reaches a hub.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_IMAGES, codexImageModels } from './images.js';
import { authed, drainJobs, signedInHub } from '../../../tests/unit/helpers.js';
import {
  MODELS_CATALOG_TTL_MS,
  modelsCatalogSource,
  parseModelsCatalog,
  type ModelsCatalog,
} from './models-catalog.js';

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../catalog/models.json',
);

const CATALOG_URL = 'https://raw.githubusercontent.com/twuijri/core-hub/main/catalog/models.json';

const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('the shared models catalogue', () => {
  it('the repository’s file parses and names the subscription’s models and image models', () => {
    const catalog = parseModelsCatalog(JSON.parse(readFileSync(FILE, 'utf8')));
    expect(catalog).not.toBeNull();
    const codex = catalog!.providers['openai-codex']!;
    expect(codex.models.length).toBeGreaterThan(0);
    expect(codex.clientVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The built-in fallback says the same as the file the day it ships.
    expect(codex.imageModels).toEqual([...CODEX_IMAGES.models]);
  });

  it('keeps only real model names and versions; anything else is not a catalogue', () => {
    expect(
      parseModelsCatalog({
        schema: 1,
        providers: {
          'openai-codex': {
            client_version: '0.200.0; rm -rf /',
            models: ['gpt-6-sol', 'gpt 6', '../etc', 'models/gemini-3-pro', 'gpt-6-sol'],
            image_models: ['gpt-image-3', 'gpt-5.5', '<script>', 7],
          },
          anthropic: { models: ['claude-opus-4-7'] },
          'Bad Key!': { models: ['x'] },
        },
      }),
    ).toEqual({
      providers: {
        'openai-codex': {
          models: ['gpt-6-sol', 'models/gemini-3-pro'],
          imageModels: ['gpt-image-3'],
          clientVersion: null,
        },
        anthropic: { models: ['claude-opus-4-7'], imageModels: [], clientVersion: null },
      },
    });
    expect(parseModelsCatalog({ schema: 2, providers: {} })).toBeNull();
    expect(parseModelsCatalog({ schema: 1 })).toBeNull();
    expect(parseModelsCatalog('nope')).toBeNull();
  });

  it('replaces the built-in list, so a model removed there is gone, and the environment adds', () => {
    expect(codexImageModels({}, ['gpt-image-3', 'gpt-image-2'])).toEqual([
      'gpt-image-3',
      'gpt-image-2',
    ]);
    expect(codexImageModels({}, [])).toEqual([...CODEX_IMAGES.models]);
    expect(
      codexImageModels({ COREHUB_CODEX_IMAGE_MODELS: 'gpt-image-4' }, ['gpt-image-3']),
    ).toEqual(['gpt-image-4', 'gpt-image-3']);
  });

  it('is read at most every twelve hours, keeps what it knew when a read fails, and can be off', async () => {
    let now = 0;
    const answers = [
      () => answer({ schema: 1, providers: { x: { models: ['m-3'] } } }),
      () => answer({ message: 'rate limited' }, 429),
      () => Promise.resolve(new Response('not json')),
      () => answer({ schema: 1, providers: { x: { models: ['m-4'] } } }),
    ];
    const fetch = vi.fn((_url: string, _init?: RequestInit) => answers.shift()!());
    const read = modelsCatalogSource({ url: CATALOG_URL, fetch, now: () => now });
    expect((await read())?.providers.x?.models).toEqual(['m-3']);
    expect((await read())?.providers.x?.models).toEqual(['m-3']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(CATALOG_URL);
    now += MODELS_CATALOG_TTL_MS;
    expect((await read())?.providers.x?.models).toEqual(['m-3']);
    now += MODELS_CATALOG_TTL_MS;
    expect((await read())?.providers.x?.models).toEqual(['m-3']);
    now += MODELS_CATALOG_TTL_MS;
    expect((await read())?.providers.x?.models).toEqual(['m-4']);

    const never = vi.fn();
    expect(await modelsCatalogSource({ url: null, fetch: never })()).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe('the shared catalogue for a key provider (decision §110)', () => {
  it('offers the catalogue’s list, marked fallback, when the provider cannot be asked', async () => {
    // Anthropic's list endpoint is down; the key itself is fine.
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"error":{"message":"overloaded"}}', { status: 529 }),
      )) as unknown as typeof fetch;
    const catalog = () =>
      Promise.resolve<ModelsCatalog>({
        providers: {
          anthropic: {
            models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
            imageModels: [],
            clientVersion: null,
          },
        },
      });
    const hub = await signedInHub({}, { models: { fetchImpl, catalog } });
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'anthropic', label: 'Anthropic', kind: 'llm', api_key: 'sk-ant-x' },
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json() as { id: string };
      await drainJobs(hub.app);
      const listed = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/providers' })
      ).json() as {
        items: {
          id: string;
          catalogue: { source: string | null; fallback_reason: string | null };
          models: { model: string }[];
        }[];
      };
      const row = listed.items.find((item) => item.id === id)!;
      expect(row.models.map((model) => model.model).sort()).toEqual([
        'claude-opus-4-7',
        'claude-sonnet-4-6',
      ]);
      expect(row.catalogue.source).toBe('fallback');
      expect(row.catalogue.fallback_reason).toBeTruthy();
    } finally {
      await hub.close();
    }
  });
});
