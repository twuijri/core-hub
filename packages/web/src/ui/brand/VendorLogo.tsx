/**
 * A company's logo beside a provider (DECISIONS §146, owner 2026-09-30): small, one colour,
 * tinted in the brand accent by its container — there only so people recognise the company at a
 * glance in a long list. A company with no logo of its own in the sources we carry (LiteLLM,
 * Nous Portal) wears a neutral monogram of its name; a custom endpoint wears the models icon.
 *
 * The path data is generated (`scripts/icons/vendor-logos.mjs`, `vendor-logos.generated.ts`);
 * where it comes from and under which licence is in THIRD-PARTY-NOTICES.md. The marks belong to
 * their owners; Core Hub is not affiliated with any of them.
 */
import { IconModels } from '../icons.js';
import { VENDOR_LOGO_PATHS } from './vendor-logos.generated.js';

/** A preset's company logo, by the preset's id (`ProviderPreset.id`, `SubscriptionVendor.preset`). */
const LOGO_OF_PRESET: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-stt': 'openai',
  'openai-tts': 'openai',
  'openai-codex': 'openai',
  'chatgpt-subscription': 'openai',
  'claude-subscription': 'claude',
  openrouter: 'openrouter',
  google: 'gemini',
  'antigravity-subscription': 'antigravity',
  groq: 'groq',
  'groq-stt': 'groq',
  'groq-tts': 'groq',
  mistral: 'mistral',
  deepseek: 'deepseek',
  xai: 'xai',
  'xai-oauth': 'grok',
  'xai-subscription': 'grok',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  elevenlabs: 'elevenlabs',
  'elevenlabs-stt': 'elevenlabs',
  'deepgram-stt': 'deepgram',
  'deepgram-tts': 'deepgram',
  'azure-tts': 'azure',
  'azure-stt': 'azure',
  'minimax-oauth': 'minimax',
  'kimi-subscription': 'kimi',
  'kimi-ai-subscription': 'kimi',
  'meta-subscription': 'meta',
  'devin-subscription': 'devin',
};

/** The presets that are an endpoint of the person's own, not a company. */
const OWN_ENDPOINT = new Set(['openai-compatible', '__custom__']);

export function hasVendorLogo(preset: string): boolean {
  return LOGO_OF_PRESET[preset] !== undefined;
}

export function VendorLogo({
  preset,
  name,
  size = 20,
}: {
  preset: string;
  /** The provider's name, for the monogram of a company with no logo here. */
  name: string;
  size?: number;
}) {
  const logo = LOGO_OF_PRESET[preset];
  const paths = logo ? VENDOR_LOGO_PATHS[logo] : undefined;
  if (paths) {
    return (
      <svg
        className="vendor-logo"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        aria-hidden
        data-logo={logo}
      >
        {paths.map((d) => (
          <path key={d.slice(0, 24)} d={d} />
        ))}
      </svg>
    );
  }
  if (OWN_ENDPOINT.has(preset)) {
    return (
      <span className="vendor-logo" data-logo="endpoint" aria-hidden>
        <IconModels size={size} />
      </span>
    );
  }
  // The first letter of the name (a whole grapheme, whatever the script), drawn by the style
  // sheet — not text, so a list's text and a row's accessible name stay the provider's name.
  const letter = [...new Intl.Segmenter().segment(name.trim())][0]?.segment ?? '·';
  return (
    <span
      className="vendor-logo-monogram"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      data-logo="monogram"
      data-letter={letter.toLocaleUpperCase()}
      aria-hidden
    />
  );
}
