/**
 * What this product is called, what it used to be called, and what it must keep calling
 * itself.
 *
 * The product was Majlis until 2026-09-24 and is Core Hub since (ADR 0017). A rename
 * should be one edit — but only for the things a rename is *allowed* to change, and the
 * distinction below is the whole point of this file.
 *
 * It lives in `contracts` because every package needs it and every package already
 * depends on this one; the product's own name is part of what a client and a server
 * agree on (`meta.get` answers it).
 */

/**
 * The renameable identity: what people read, and the conventions named after it.
 *
 * Change these and everything in `derived` follows: the config folder, the environment
 * prefix, the browser's storage keys, the command's name, the outgoing webhook header.
 */
export const PRODUCT = {
  /** Lowercase, used in paths, keys and prefixes. */
  id: 'corehub',
  /** What a person sees when the hub introduces itself. */
  name: 'Core Hub',
  /** The same name in Arabic, the way the owner writes it. */
  nameAr: 'كور هب',
  /** The repository and the published image (`ghcr.io/twuijri/core-hub`). */
  repository: 'twuijri/core-hub',
} as const;

/** The conventions named after the product. One rename moves all of them together. */
export const derived = {
  /** `$XDG_CONFIG_HOME/<id>/config.json` — where the terminal client keeps its token. */
  configDir: PRODUCT.id,
  /** `COREHUB_VERSION`, `COREHUB_CONFIG`, … */
  envPrefix: `${PRODUCT.id.toUpperCase()}_`,
  /** `corehub.session`, `corehub.display`, … in the browser. */
  storagePrefix: `${PRODUCT.id}.`,
  /** The folder a run's files live in, inside the session's working directory. */
  runFilesDir: `.${PRODUCT.id}`,
  /** The signature header on an outgoing webhook. */
  webhookSignatureHeader: `x-${PRODUCT.id}-signature`,
  /** The event name on an outgoing webhook delivery (decision §59). */
  webhookEventHeader: `x-${PRODUCT.id}-event`,
  /** The delivery id on an outgoing webhook delivery (decision §59). */
  webhookDeliveryHeader: `x-${PRODUCT.id}-delivery`,
  /** What the logs call this service, and what an ACP agent is told it is talking to. */
  serviceName: PRODUCT.id,
  /** The QR payload's `type`, so a scanner knows whose code it is reading. */
  pairingType: `${PRODUCT.id}.pairing`,
  /** The terminal client's command. */
  cliName: PRODUCT.id,
  /**
   * The prefix of the `providers:` blocks the hub owns inside Hermes's own `config.yaml`
   * (`corehub-groq`, `corehub-custom-<slug>`). It may follow the name only because the hub
   * migrates the old blocks itself (`LEGACY.hermesProviderPrefix`): on every write the
   * blocks under the old prefix are replaced and every reference to them is rewritten.
   */
  hermesProviderPrefix: `${PRODUCT.id}-`,
  /** The variable the hub mints for a provider key no other tool has a name for. */
  providerKeyEnvPrefix: `${PRODUCT.id.toUpperCase()}_PROVIDER_`,
  /** The file a profile archive carries its providers in. */
  providersFile: `${PRODUCT.id}-providers.json`,
  /** `format` of a providers bundle. */
  providersBundleFormat: `${PRODUCT.id}-providers`,
  /** Who signs an access token. Tokens signed under `LEGACY.jwtIssuer` are still accepted. */
  jwtIssuer: PRODUCT.id,
  /** The comment above the variables the hub owns in a Hermes `.env`. */
  managedMarker: `# managed by ${PRODUCT.name} — edit the provider in the hub, not here`,
} as const;

/**
 * **The names the product answered to before (Majlis).**
 *
 * Read, never written. Each one is accepted wherever something older than this release
 * may still say it: an environment variable in somebody's stack, a key in a browser, a
 * token already signed, a block in Hermes's config, an archive exported yesterday. Remove
 * an entry only together with the code that reads it, and only when nothing can say it
 * any more.
 */
export const LEGACY = {
  id: 'majlis',
  name: 'Majlis',
  envPrefix: 'MAJLIS_',
  storagePrefix: 'majlis.',
  configDir: 'majlis',
  pairingType: 'majlis.pairing',
  cliName: 'majlis',
  hermesProviderPrefix: 'majlis-',
  providerKeyEnvPrefix: 'MAJLIS_PROVIDER_',
  providersFile: 'majlis-providers.json',
  providersBundleFormat: 'majlis-providers',
  jwtIssuer: 'majlis',
  managedMarker: '# managed by Majlis — edit the provider in the hub, not here',
} as const;

/**
 * **Identifiers that must never change, whatever the product is called.**
 *
 * `idNamespace` seeds **deterministic ids**. Change the seed and every profile id derived
 * from it becomes a different id. Nothing errors; the hub simply stops finding the rows it
 * wrote yesterday. This is the dangerous one, because it is silent — so it keeps the first
 * product's name as a literal, and `product.test.ts` fails if a rename drags it along. It
 * is a hash seed: nobody ever reads it.
 */
export const STABLE = {
  idNamespace: 'majlis',
} as const;

/** One environment variable, read under its current name or the one it had before. */
export interface ProductEnvRead {
  value: string | undefined;
  /** The old name the value came from, when it did; the caller says so once. */
  legacyName: string | null;
}

/**
 * Reads `COREHUB_<suffix>`, falling back to `MAJLIS_<suffix>`. The current name wins when
 * both are set; an empty value counts as unset.
 */
export function readProductEnv(
  env: Readonly<Record<string, string | undefined>>,
  suffix: string,
): ProductEnvRead {
  const current = env[`${derived.envPrefix}${suffix}`];
  if (current !== undefined && current.trim() !== '') return { value: current, legacyName: null };
  const legacyName = `${LEGACY.envPrefix}${suffix}`;
  const legacy = env[legacyName];
  if (legacy !== undefined && legacy.trim() !== '') return { value: legacy, legacyName };
  return { value: undefined, legacyName: null };
}
