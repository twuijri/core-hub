/**
 * The preset catalogue: the list the "Add provider" dialog and `majlis providers presets`
 * are drawn from. These are pure assertions on data — no hub, no HTTP.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CATALOGUE,
  assertCatalogueIsWellFormed,
  authKindOf,
  catalogueEntry,
  familyEntries,
  type ProviderCatalogueEntry,
} from './catalogue.js';
import { hostInfo, LOOPBACK_ALIAS } from './service.js';

const entry = (slug: string): ProviderCatalogueEntry => {
  const found = catalogueEntry(slug);
  if (!found) throw new Error(`no preset "${slug}"`);
  return found;
};

describe('provider catalogue', () => {
  it('is well formed', () => {
    expect(() => assertCatalogueIsWellFormed()).not.toThrow();
  });

  it('catches a family that disagrees with itself about its variable', () => {
    const broken: ProviderCatalogueEntry[] = [
      { ...entry('openai') },
      { ...entry('openai-stt'), envVar: 'OPENAI_OTHER_KEY' },
    ];
    expect(() => assertCatalogueIsWellFormed(broken)).toThrow(/one family is one key/);
  });

  it('catches an entry that demands a key but names no variable for it', () => {
    const broken: ProviderCatalogueEntry[] = [
      { ...entry('lmstudio'), keyRequirement: 'required' as const },
    ];
    expect(() => assertCatalogueIsWellFormed(broken)).toThrow(/names no variable/);
  });

  it('catches a local entry that claims a name in Hermes it cannot have', () => {
    const broken: ProviderCatalogueEntry[] = [{ ...entry('lmstudio'), hermesProvider: 'lmstudio' }];
    expect(() => assertCatalogueIsWellFormed(broken)).toThrow(/claims a Hermes name/);
  });

  describe('the local providers (the owner asked for these first)', () => {
    it('LM Studio: OpenAI-compatible on 1234, no key demanded', () => {
      expect(entry('lmstudio')).toMatchObject({
        protocol: 'openai',
        apiMode: 'chat_completions',
        baseUrl: 'http://127.0.0.1:1234/v1',
        keyRequirement: 'optional',
        local: true,
        envVar: null,
      });
      expect(entry('lmstudio').capabilities.listModels).toBe(true);
    });

    it('LiteLLM: no address anybody could guess, and a key it may or may not want', () => {
      expect(entry('litellm')).toMatchObject({
        protocol: 'openai',
        baseUrl: null,
        keyRequirement: 'optional',
        local: true,
      });
    });

    it('OpenAI-compatible: the generic one, added as many times as you like', () => {
      expect(entry('openai-compatible')).toMatchObject({
        protocol: 'openai',
        baseUrl: null,
        keyRequirement: 'optional',
        repeatable: true,
        family: 'custom',
      });
    });

    it('Ollama behaves like the rest of them: local, reachable, key not demanded', () => {
      expect(entry('ollama')).toMatchObject({
        baseUrl: 'http://127.0.0.1:11434',
        keyRequirement: 'optional',
        local: true,
      });
    });

    it('no preset refuses a key — `optional` is the weakest value there is', () => {
      for (const preset of PROVIDER_CATALOGUE) {
        expect(['required', 'optional']).toContain(preset.keyRequirement);
        // `auth.kind: none` is "no key required", which is exactly what lets a client
        // keep offering the field (the defect of 2026-09-22).
        expect(authKindOf(preset)).toBe(preset.keyRequirement === 'required' ? 'api_key' : 'none');
      }
    });
  });

  it('keeps one key behind the whole OpenAI family', () => {
    expect(familyEntries('openai').map((item) => item.slug)).toEqual([
      'openai',
      'openai-stt',
      'openai-tts',
    ]);
    expect(new Set(familyEntries('openai').map((item) => item.envVar))).toEqual(
      new Set(['OPENAI_API_KEY']),
    );
  });

  it('tells a client whether 127.0.0.1 would mean the container, without rewriting it', () => {
    expect(hostInfo(() => false)).toEqual({
      containerized: false,
      loopback_alias: LOOPBACK_ALIAS,
    });
    expect(hostInfo((path) => path === '/.dockerenv').containerized).toBe(true);
    // Podman's marker counts too.
    expect(hostInfo((path) => path === '/run/.containerenv').containerized).toBe(true);
  });
});
