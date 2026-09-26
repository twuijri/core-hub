// The repository's `catalog/models.json` (decision §110) as every hub will read it: a provider
// key a hub would never look up, an id a hub would silently drop, or a field nobody reads fails
// here, in CI, instead of quietly offering nothing on every hub.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOGUE } from './catalogue.js';
import { CODEX_IMAGES, isCodexImageName } from './images.js';
import { MODEL_ID, PROVIDER_KEY, parseModelsCatalog } from './models-catalog.js';

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../catalog/models.json',
);
const text = readFileSync(FILE, 'utf8');
const raw = JSON.parse(text) as {
  schema: unknown;
  updated: unknown;
  providers: Record<string, Record<string, unknown>>;
};

/**
 * The key a hub looks a provider up by (service.ts): the Hermes provider id of a signed-in
 * preset, the preset slug of every other one. A preset whose address the person types (a local
 * runtime, a custom endpoint) has no list anybody could keep for it.
 */
const lookedUp = new Map(
  PROVIDER_CATALOGUE.filter((entry) => !entry.local && entry.baseUrl !== null).map((entry) => [
    entry.signIn ? entry.hermesProvider! : entry.slug,
    entry,
  ]),
);

describe('catalog/models.json', () => {
  it('is schema 1, dated, small enough for a hub to read, and only what a hub reads', () => {
    expect(Object.keys(raw).sort()).toEqual(['providers', 'schema', 'updated']);
    expect(raw.schema).toBe(1);
    expect(raw.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(Object.keys(raw.providers).length).toBeGreaterThan(1);
    expect(Object.keys(raw.providers).length).toBeLessThanOrEqual(64);
  });

  it('names every provider by the key a hub looks it up by', () => {
    for (const key of Object.keys(raw.providers)) {
      expect(PROVIDER_KEY.test(key), `${key} is not a provider key`).toBe(true);
      expect(
        lookedUp.has(key),
        `${key} is neither a preset slug nor a signed-in Hermes provider id`,
      ).toBe(true);
    }
  });

  it('holds only model ids a hub keeps, each once, and nothing it would drop', () => {
    const parsed = parseModelsCatalog(raw)!;
    expect(parsed).not.toBeNull();
    for (const [key, entry] of Object.entries(raw.providers)) {
      const fields = Object.keys(entry);
      for (const field of fields) {
        expect(['models', 'image_models', 'client_version'], `${key}.${field}`).toContain(field);
      }
      const models = entry.models as unknown[];
      expect(Array.isArray(models) && models.length > 0, `${key}.models`).toBe(true);
      expect(models.length).toBeLessThanOrEqual(200);
      for (const id of models) {
        expect(typeof id === 'string' && MODEL_ID.test(id), `${key}: ${String(id)}`).toBe(true);
        expect(id, `${key}: ${String(id)} has spaces around it`).toBe(String(id).trim());
      }
      expect(new Set(models).size, `${key} lists an id twice`).toBe(models.length);
      // Whatever a hub parses is exactly what the file says.
      expect(parsed.providers[key]!.models).toEqual(models);
    }
  });

  it('keeps image models and a client version only for the ChatGPT subscription', () => {
    for (const [key, entry] of Object.entries(raw.providers)) {
      if (key === CODEX_IMAGES.hermesProvider) continue;
      expect(entry.image_models, `${key}.image_models`).toBeUndefined();
      expect(entry.client_version, `${key}.client_version`).toBeUndefined();
    }
    const codex = raw.providers[CODEX_IMAGES.hermesProvider]!;
    const images = codex.image_models as string[];
    for (const image of images) expect(isCodexImageName(image), image).toBe(true);
    expect(codex.client_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps each speech preset’s list to that preset’s own kind of ids', () => {
    // A speech row keeps only its kind; a chat model's id in a speech list is a slip.
    const chatLooking = /^(gpt-[0-9]|claude-|gemini-[0-9.]+-(pro|flash)$|grok-)/;
    for (const [key, entry] of Object.entries(raw.providers)) {
      if (lookedUp.get(key)?.kind === 'llm') continue;
      for (const id of entry.models as string[]) expect(chatLooking.test(id), `${key}: ${id}`).toBe(false);
    }
  });
});
