/**
 * Voices and models a provider documents but cannot list over its API (DECISIONS §92).
 *
 * The one editable list of them. Only a provider with **no** list endpoint belongs here:
 * everything else is asked live, so the picker never offers a voice that was true when this
 * file was written and is not true today. Each entry names the page it was read from and the
 * day it was checked; the web labels these lists "from the provider's documentation".
 *
 * To add a voice, add a line. `models` lists the models it speaks with (absent: every model
 * of the provider); `language` is BCP-47 or null for a voice that speaks any language the
 * model does; `gender` is `female`, `male`, `neutral` or null when the page does not say.
 */
import type { DiscoveredModel, DiscoveredVoice } from '../adapters/types.js';

export interface DocumentedList<T> {
  /** The public page the list was read from. */
  source: string;
  /** The day somebody last checked it against that page. */
  checked: string;
  items: readonly T[];
}

/** Voices, by the catalogue slug of the provider row that speaks them. */
export const DOCUMENTED_VOICES: Readonly<Record<string, DocumentedList<DiscoveredVoice>>> = {
  'groq-tts': {
    source: 'https://console.groq.com/docs/text-to-speech/orpheus',
    checked: '2026-09-26',
    items: [
      {
        id: 'autumn',
        name: 'Autumn',
        language: 'en',
        gender: 'female',
        models: ['canopylabs/orpheus-v1-english'],
      },
      {
        id: 'diana',
        name: 'Diana',
        language: 'en',
        gender: 'female',
        models: ['canopylabs/orpheus-v1-english'],
      },
      {
        id: 'hannah',
        name: 'Hannah',
        language: 'en',
        gender: 'female',
        models: ['canopylabs/orpheus-v1-english'],
      },
      {
        id: 'austin',
        name: 'Austin',
        language: 'en',
        gender: 'male',
        models: ['canopylabs/orpheus-v1-english'],
      },
      {
        id: 'daniel',
        name: 'Daniel',
        language: 'en',
        gender: 'male',
        models: ['canopylabs/orpheus-v1-english'],
      },
      {
        id: 'troy',
        name: 'Troy',
        language: 'en',
        gender: 'male',
        models: ['canopylabs/orpheus-v1-english'],
      },
      {
        id: 'abdullah',
        name: 'Abdullah',
        language: 'ar-SA',
        gender: 'male',
        description: 'Saudi dialect',
        models: ['canopylabs/orpheus-arabic-saudi'],
      },
      {
        id: 'fahad',
        name: 'Fahad',
        language: 'ar-SA',
        gender: 'male',
        description: 'Saudi dialect',
        models: ['canopylabs/orpheus-arabic-saudi'],
      },
      {
        id: 'sultan',
        name: 'Sultan',
        language: 'ar-SA',
        gender: 'male',
        description: 'Saudi dialect',
        models: ['canopylabs/orpheus-arabic-saudi'],
      },
      {
        id: 'lulwa',
        name: 'Lulwa',
        language: 'ar-SA',
        gender: 'female',
        description: 'Saudi dialect',
        models: ['canopylabs/orpheus-arabic-saudi'],
      },
      {
        id: 'noura',
        name: 'Noura',
        language: 'ar-SA',
        gender: 'female',
        description: 'Saudi dialect',
        models: ['canopylabs/orpheus-arabic-saudi'],
      },
      {
        id: 'aisha',
        name: 'Aisha',
        language: 'ar-SA',
        gender: 'female',
        description: 'Saudi dialect',
        models: ['canopylabs/orpheus-arabic-saudi'],
      },
    ],
  },
  'openai-tts': {
    source: 'https://developers.openai.com/api/docs/guides/text-to-speech',
    checked: '2026-09-26',
    items: [
      { id: 'alloy', name: 'Alloy', language: null, gender: null },
      { id: 'ash', name: 'Ash', language: null, gender: null },
      { id: 'ballad', name: 'Ballad', language: null, gender: null, models: ['gpt-4o-mini-tts'] },
      { id: 'coral', name: 'Coral', language: null, gender: null },
      { id: 'echo', name: 'Echo', language: null, gender: null },
      { id: 'fable', name: 'Fable', language: null, gender: null },
      { id: 'nova', name: 'Nova', language: null, gender: null },
      { id: 'onyx', name: 'Onyx', language: null, gender: null },
      { id: 'sage', name: 'Sage', language: null, gender: null },
      { id: 'shimmer', name: 'Shimmer', language: null, gender: null },
      { id: 'verse', name: 'Verse', language: null, gender: null, models: ['gpt-4o-mini-tts'] },
      { id: 'marin', name: 'Marin', language: null, gender: null, models: ['gpt-4o-mini-tts'] },
      { id: 'cedar', name: 'Cedar', language: null, gender: null, models: ['gpt-4o-mini-tts'] },
    ],
  },
};

/** Models, by the catalogue slug of the provider row, for a provider with no model list. */
export const DOCUMENTED_MODELS: Readonly<Record<string, DocumentedList<DiscoveredModel>>> = {
  'elevenlabs-stt': {
    source: 'https://elevenlabs.io/docs/overview/models',
    checked: '2026-09-26',
    items: [{ key: 'scribe_v2', label: 'Scribe v2', kind: 'stt' }],
  },
};

/** A provider row's documented voices as an adapter answers them, or null when it has none. */
export function documentedVoices(
  slug: string,
): { supported: true; voices: DiscoveredVoice[]; source: 'documented' } | null {
  const list = DOCUMENTED_VOICES[slug];
  if (!list) return null;
  return {
    supported: true,
    voices: list.items.map((voice) => ({ ...voice })),
    source: 'documented',
  };
}

/** A provider row's documented models as an adapter answers them, or null when it has none. */
export function documentedModels(slug: string): {
  supported: true;
  models: DiscoveredModel[];
  source: 'fallback';
  reason: string;
} | null {
  const list = DOCUMENTED_MODELS[slug];
  if (!list) return null;
  return {
    supported: true,
    models: list.items.map((model) => ({ ...model })),
    source: 'fallback',
    reason: `the provider has no model list endpoint; this is its documented list (${list.source}, checked ${list.checked})`,
  };
}
