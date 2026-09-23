/**
 * What this product is called, and what it must keep calling itself.
 *
 * The owner may rename the product (it has been Core Hub and it is Majlis). A rename
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
 * Change these two and everything in `derived` follows: the config folder, the
 * environment prefix, the browser's storage keys, the command's name, the outgoing
 * webhook header. All of them are conventions — losing one costs a person a preference
 * or one re-login, and nothing is silently wrong afterwards.
 */
export const PRODUCT = {
  /** Lowercase, used in paths, keys and prefixes. */
  id: 'majlis',
  /** What a person sees when the hub introduces itself. */
  name: 'Majlis',
} as const;

/** The conventions named after the product. One rename moves all of them together. */
export const derived = {
  /** `$XDG_CONFIG_HOME/<id>/config.json` — where the terminal client keeps its token. */
  configDir: PRODUCT.id,
  /** `MAJLIS_VERSION`, `MAJLIS_CONFIG`, … */
  envPrefix: `${PRODUCT.id.toUpperCase()}_`,
  /** `majlis.session`, `majlis.display`, … in the browser. */
  storagePrefix: `${PRODUCT.id}.`,
  /** The folder a run's files live in, inside the session's working directory. */
  runFilesDir: `.${PRODUCT.id}`,
  /** The signature header on an outgoing webhook. */
  webhookSignatureHeader: `x-${PRODUCT.id}-signature`,
  /** What the logs call this service, and what an ACP agent is told it is talking to. */
  serviceName: PRODUCT.id,
  /** The QR payload's `type`, so a scanner knows whose code it is reading. */
  pairingType: `${PRODUCT.id}.pairing`,
} as const;

/**
 * **Identifiers that must never change, whatever the product is called.**
 *
 * Each of these is a name the hub has already written somewhere it cannot take back — in
 * a token it signed, in an id it derived, in somebody else's configuration file. Deriving
 * them from `PRODUCT.id` would make a rename do something a rename must never do:
 *
 * - `idNamespace` seeds **deterministic ids**. Change the seed and every workspace id
 *   derived from it becomes a different id. Nothing errors; the hub simply stops finding
 *   the rows it wrote yesterday. This is the dangerous one, because it is silent.
 * - `jwtIssuer` is inside every token already issued. Change it and every signed-in
 *   person is signed out at once — including whoever is renaming the product.
 * - `hermesProviderPrefix` marks the providers this hub owns **inside Hermes's own
 *   config.yaml**. Change it and those entries are orphaned: the hub no longer recognises
 *   what it put there, and Hermes keeps using it.
 *
 * So they are literals, frozen on purpose, and `product.test.ts` fails if a future rename
 * drags them along.
 */
export const STABLE = {
  idNamespace: 'majlis',
  jwtIssuer: 'majlis',
  hermesProviderPrefix: 'majlis-',
} as const;
