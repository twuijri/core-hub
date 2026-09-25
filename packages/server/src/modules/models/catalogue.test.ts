/**
 * The preset catalogue: the list the "Add provider" dialog and `corehub providers presets`
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

  it('catches a local entry that claims Hermes variables it cannot have', () => {
    const broken: ProviderCatalogueEntry[] = [
      { ...entry('lmstudio'), hermesEnvVars: ['LMSTUDIO_API_KEY'] },
    ];
    expect(() => assertCatalogueIsWellFormed(broken)).toThrow(/claims Hermes variables/);
  });

  it('catches an entry whose Hermes slug and Hermes route disagree', () => {
    // A slug without the route is a name nothing writes; a route without the slug is a
    // `builtin` the hub has nothing to call. Both are the same mistake, caught twice.
    expect(() =>
      assertCatalogueIsWellFormed([{ ...entry('lmstudio'), hermesProvider: 'lmstudio' }]),
    ).toThrow(/names a Hermes slug but is not routed to it/);
    expect(() =>
      assertCatalogueIsWellFormed([{ ...entry('anthropic'), hermesProvider: null }]),
    ).toThrow(/builtin but names no Hermes slug/);
  });

  it('catches a chat provider the hub could not say to Hermes at all', () => {
    // Every `llm` entry must be expressible: that a provider loaded its models and then
    // reached nothing is the whole of the 2026-09-22 defect.
    expect(() =>
      assertCatalogueIsWellFormed([
        { ...entry('lmstudio'), hermesRoute: 'none' as const, hermesApiMode: null },
      ]),
    ).toThrow(/must be expressible to Hermes/);
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
        // A provider used by signing in is `oauth` (contract decision §50): still no key refused.
        expect(authKindOf(preset)).toBe(
          preset.signIn ? 'oauth' : preset.keyRequirement === 'required' ? 'api_key' : 'none',
        );
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
