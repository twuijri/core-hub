/**
 * Propagation — the half of ADR 0010 that makes "add the key once" true.
 *
 * The owner adds a provider in one screen. Nothing else in the product asks for a key
 * again; the hub is what carries it to each kind of agent:
 *
 * - **Hermes** keeps its own configuration in its own home, and it keeps it in two
 *   files with two different jobs (docs/inspirations/hermes-agent.md §Provider keys):
 *   `${HERMES_HOME}/.env` holds the provider keys, `${HERMES_HOME}/config.yaml` holds
 *   the selected model as `model.default` + `model.provider`. The hub writes both the
 *   way Hermes's own writers do — one key at a time, preserving every line it does not
 *   own — and then recycles the gateway it supervises. `hermes config` and `hermes model`
 *   keep working on everything else in those files.
 * - **ACP and harness agents** are processes the hub starts. Their environment is built
 *   here, at start, from the same providers — so installing a new coding agent is an
 *   install and nothing else.
 *
 * Nothing in this file logs a value. The functions return which **names** changed, which
 * is what a log line and an audit row are allowed to carry.
 */
import { LEGACY, derived } from '@corehub/contracts';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MANAGED_MARKER, mergeEnv } from './dotenv.js';

/** One resolved credential: a family, the names it is known by, and the key itself. */
export interface ResolvedCredential {
  family: string;
  /** The name the outside world knows the key by (`ANTHROPIC_API_KEY`). */
  envVar: string;
  /** Every name Hermes reads it from; usually `[envVar]`. */
  hermesEnvVars: string[];
  /** Plaintext. Only ever placed into a child's environment or Hermes's own `.env`. */
  value: string;
}

/** A model choice expressed the way Hermes names one. */
export interface HermesModelChoice {
  /** Hermes's provider slug (`anthropic`, `openai-api`, `gemini`, …). */
  provider: string;
  /** The model id as the provider names it. */
  model: string;
}

/**
 * One OpenAI-compatible endpoint, as a block under Hermes's `providers:`.
 *
 * This is Hermes's own vocabulary for "an endpoint I do not ship a provider for", read
 * from its MIT source (`hermes_cli/config_providers.py` declares the accepted keys;
 * `hermes_cli/runtime_provider_custom.py` §`_match_new_style_provider` resolves the block
 * into a runtime with this `base_url`, this transport and the key named by `key_env`).
 * Writing it is what lets LM Studio, LiteLLM, Groq, Mistral and somebody's own endpoint
 * be the model that actually runs.
 */
export interface HermesProviderRoute {
  /** The block's key and `name`, always prefixed (`catalogue.ts` §HERMES_PROVIDER_PREFIX). */
  name: string;
  baseUrl: string;
  /** null leaves the transport to Hermes's own URL detection. */
  apiMode: 'chat_completions' | 'responses' | null;
  /** The variable Hermes reads this endpoint's key from; the `.env` merge owns it. */
  keyEnv: string;
}

/** What the workspace currently wants every agent to use. */
export interface PropagationState {
  credentials: ResolvedCredential[];
  /**
   * Every OpenAI-compatible endpoint the workspace has, as Hermes's `providers:` blocks.
   * Written whether or not one of them is the current default: a provider the owner added
   * is one they may switch to, and a run may name any of them per request.
   */
  hermesProviders: HermesProviderRoute[];
  /**
   * The chat default in Hermes's vocabulary, or null — either because the owner set
   * none, or because the provider it names is one Hermes cannot be told about at all.
   * Null means "leave Hermes's own selection alone", never "guess".
   */
  hermesModel: HermesModelChoice | null;
  /** Why `hermesModel` is null, when the owner did choose a default. */
  hermesModelBlocked: string | null;
  /**
   * Every variable name the hub writes a key under, including those of providers it had and
   * removed. The hub owns these names in Hermes's `.env`: one with no key any more is removed
   * from the file (contract decision §37 — removing a provider applies everywhere). Absent,
   * only the names of the current credentials are owned, as before.
   */
  ownedEnv?: string[];
}

// --------------------------------------------------------------- process agents

/**
 * The environment a coding agent starts with.
 *
 * `declared` is the agent's own catalog line: credential family -> the variable that
 * agent expects (`{ anthropic: 'ANTHROPIC_API_KEY' }`). An agent that declares nothing
 * inherits nothing, which is the safe default: a CLI is not handed every key in the
 * workspace because it happens to be installed.
 *
 * Precedence, lowest to highest: the workspace's shared credentials, then the agent's own
 * non-secret `env`, then its explicit `secret_refs`. A person who pinned one agent to one
 * key therefore always wins over the shared store (ADR 0010 §Overrides).
 */
export function agentEnvironment(options: {
  credentials: readonly ResolvedCredential[];
  declared: Readonly<Record<string, string>>;
  settingsEnv?: Readonly<Record<string, string>>;
  secretRefValues?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const credential of options.credentials) {
    const name = options.declared[credential.family];
    if (!name) continue;
    env[name] = credential.value;
  }
  for (const [key, value] of Object.entries(options.settingsEnv ?? {})) env[key] = value;
  for (const [key, value] of Object.entries(options.secretRefValues ?? {})) env[key] = value;
  return env;
}

// ----------------------------------------------------------------------- Hermes

/**
 * The `config.yaml` keys the hub owns. Exactly the pair `hermes model` writes, plus the
 * two route keys Hermes clears when the provider changes — leaving a stale `base_url`
 * from a previous provider behind is how a run ends up talking to the wrong endpoint
 * (docs/inspirations/hermes-agent.md §`hermes model`).
 */
export const HERMES_MODEL_KEYS = [
  ['model', 'default'],
  ['model', 'provider'],
  ['model', 'base_url'],
  ['model', 'api_mode'],
] as const;

export interface HermesEnvPlan {
  /** Absolute path of the file that would be written. */
  file: string;
  /** Variable names the hub owns in that file. */
  owned: string[];
  /** The values it wants them to have (absent = remove the variable). */
  values: Record<string, string>;
}

/**
 * What the hub wants Hermes's `.env` to say, given the workspace's providers.
 *
 * Every credential family the catalogue knows contributes its variable(s), whether or not
 * Hermes is currently using that provider: a key the owner added is a key Hermes may use
 * the moment they switch to it, and leaving it out would make switching a second chore.
 */
export function hermesEnvPlan(home: string, state: PropagationState): HermesEnvPlan {
  const values: Record<string, string> = {};
  const owned = new Set<string>(state.ownedEnv ?? []);
  for (const credential of state.credentials) {
    for (const name of credential.hermesEnvVars) {
      owned.add(name);
      values[name] = credential.value;
    }
  }
  return { file: path.join(home, '.env'), owned: [...owned], values };
}

export interface HermesWriteResult {
  file: string;
  /** Names whose value changed. Never the values. */
  changed: string[];
  removed: string[];
  /** True when the file on disk is now different from what it was. */
  dirty: boolean;
}

/**
 * Writes a file the way Hermes's own writers do: temp file in the same directory, then
 * an atomic rename, mode 0600. A half-written `.env` next to a running gateway is the
 * one failure mode worth this much care.
 */
function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.corehub-${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * Applies the `.env` plan. Rewrites the file only when the merge actually changed
 * something, so a hub that restarts twice does not restart Hermes twice.
 */
export function writeHermesEnv(plan: HermesEnvPlan): HermesWriteResult {
  const existing = existsSync(plan.file) ? readFileSync(plan.file, 'utf8') : '';
  const merged = mergeEnv(existing, plan.values, plan.owned);
  // An empty merge over an empty file is nothing to say: creating a file that holds only
  // the marker leaves the next merge appending a *second* marker above the first
  // variable. Over a file that had content, the marker is what explains the emptiness.
  const text = merged.text === '' && existing !== '' ? `${MANAGED_MARKER}\n` : merged.text;
  const dirty = text !== existing;
  if (dirty && text !== '') writeAtomic(plan.file, text);
  return { file: plan.file, changed: merged.changed, removed: merged.removed, dirty };
}

/**
 * Writes `model.default` and `model.provider` into Hermes's `config.yaml`, one key at a
 * time through a round-trip parse, so comments, ordering and every sibling key survive —
 * the same rule Hermes's own `persist_model_selection()` states: a block rewrite destroys
 * sibling keys the user set there.
 *
 * `choice` of null leaves the selection untouched: the hub never clears a model Hermes is
 * using just because this workspace has not chosen one.
 */
export function writeHermesModel(
  home: string,
  choice: HermesModelChoice | null,
): HermesWriteResult {
  return editHermesConfig(home, (document, result) => applyModel(document, choice, result));
}

/**
 * Writes the workspace's OpenAI-compatible endpoints as `providers:` blocks.
 *
 * Only blocks whose key carries the hub's prefix are ours: one that is gone from the
 * workspace is removed, one a person wrote by hand is copied through untouched. Every
 * field is one Hermes documents (`_KNOWN_PROVIDER_KEYS`), so the gateway logs no
 * "unknown config keys ignored" warning about a file the hub wrote.
 */
export function writeHermesProviders(
  home: string,
  routes: readonly HermesProviderRoute[],
): HermesWriteResult {
  return editHermesConfig(home, (document, result) => applyProviders(document, routes, result));
}

export interface HermesPropagation {
  env: HermesWriteResult;
  /** `config.yaml`: the `providers:` blocks and the model selection, written once. */
  config: HermesWriteResult;
  /** True when either file changed and the gateway should be recycled. */
  dirty: boolean;
}

/**
 * Both files, in one call. `config.yaml` is opened once and written once: the endpoints
 * and the selection that names one of them must never be two writes, or a crash between
 * them leaves Hermes pointed at a provider block that does not exist yet.
 *
 * Throws only on a corrupt `config.yaml`; the caller logs it.
 */
export function writeHermesConfiguration(home: string, state: PropagationState): HermesPropagation {
  const env = writeHermesEnv(hermesEnvPlan(home, state));
  const config = editHermesConfig(home, (document, result) => {
    applyProviders(document, state.hermesProviders, result);
    applyModel(document, state.hermesModel, result);
  });
  return { env, config, dirty: env.dirty || config.dirty };
}

/**
 * The endpoints and the model selection alone, in one write of `config.yaml` — what a
 * messaging gateway reads to know which provider answers (`gateway/run.py`
 * §_resolve_runtime_agent_kwargs resolves `model.provider` against the `providers:` blocks of
 * **its own** profile). No `.env`: keys reach every gateway through its environment.
 */
export function writeHermesRoute(home: string, state: PropagationState): HermesWriteResult {
  return editHermesConfig(home, (document, result) => {
    applyProviders(document, state.hermesProviders, result);
    applyModel(document, state.hermesModel, result);
  });
}

// ---------------------------------------------------------------- config.yaml

/**
 * One round-trip over Hermes's `config.yaml`: parse, mutate key by key, write when the
 * text actually changed. The round-trip is the point — comments, ordering and every
 * sibling key survive, which is the rule Hermes's own `persist_model_selection()` states.
 */
function editHermesConfig(
  home: string,
  mutate: (document: YAML.Document, result: HermesWriteResult) => void,
): HermesWriteResult {
  const file = path.join(home, 'config.yaml');
  const result: HermesWriteResult = { file, changed: [], removed: [], dirty: false };
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const document: YAML.Document = YAML.parseDocument(existing);
  if (document.errors.length > 0) {
    // A config we cannot parse is a config we must not rewrite: Hermes serves the last
    // known good one, and a clobbered file would take that away too.
    throw new Error(`${file} is not valid YAML; refusing to rewrite it`);
  }
  // An empty file parses to a null scalar, which is not a collection: setting a key on it
  // throws. Hermes ships exactly that on a fresh install, so make it a mapping first —
  // and only when there is something to put in it (below).
  const empty =
    document.contents === null ||
    (YAML.isScalar(document.contents) && document.contents.value == null);
  if (empty) document.contents = new YAML.YAMLMap();
  mutate(document, result);
  // Nothing to say, nothing to write. Without this a hub with no chat default would
  // *create* a `config.yaml` saying `null`, which Hermes then cannot be given a model in
  // at all — the file the next write has to parse is already not a mapping.
  if (result.changed.length === 0 && result.removed.length === 0) return result;
  const text = document.toString();
  result.dirty = text !== existing;
  if (result.dirty) writeAtomic(file, text);
  return result;
}

/** `model.default` + `model.provider`; null leaves Hermes's own selection alone. */
function applyModel(
  document: YAML.Document,
  choice: HermesModelChoice | null,
  result: HermesWriteResult,
): void {
  if (!choice) return;
  // A fresh install ships `model: ""` (an empty-string sentinel). Replace it with the
  // mapping Hermes itself upgrades it to, rather than setting a key inside a string.
  const current = document.get('model');
  if (typeof current === 'string' || current === null || current === undefined) {
    document.set('model', { default: choice.model, provider: choice.provider });
    result.changed.push('model.default', 'model.provider');
    return;
  }
  if (document.getIn(['model', 'default']) !== choice.model) {
    document.setIn(['model', 'default'], choice.model);
    result.changed.push('model.default');
  }
  const previousProvider = document.getIn(['model', 'provider']);
  if (previousProvider !== choice.provider) {
    document.setIn(['model', 'provider'], choice.provider);
    result.changed.push('model.provider');
    // The route of the provider we just left does not belong to the new one.
    for (const key of ['base_url', 'api_mode'] as const) {
      if (document.hasIn(['model', key])) {
        document.deleteIn(['model', key]);
        result.removed.push(`model.${key}`);
      }
    }
  }
}

/**
 * Which `providers:` keys the hub owns — and no others: its own prefix, and the prefix the
 * same blocks had before the rename (`majlis-`), which a write replaces.
 */
function isOwnedProviderKey(key: unknown): boolean {
  return (
    typeof key === 'string' &&
    (key.startsWith(OWNED_PROVIDER_PREFIX) || key.startsWith(LEGACY_PROVIDER_PREFIX))
  );
}

/**
 * Kept here rather than imported from `catalogue.ts` so this file stays a pure writer
 * with no opinion about which providers exist. The two are compared by a unit test.
 */
const OWNED_PROVIDER_PREFIX = derived.hermesProviderPrefix;
const LEGACY_PROVIDER_PREFIX = LEGACY.hermesProviderPrefix;

/**
 * Renames the hub's blocks from before the rename, and everything in the file that names
 * one of them (ADR 0017).
 *
 * A profile's `model.provider` — or a fallback, an auxiliary task, a delegation — may say
 * `majlis-custom-cli-proxy-api`, written by an older hub or picked in `hermes model`. The
 * block is about to be written as `corehub-custom-cli-proxy-api` and the old one removed as
 * no longer wanted, so a reference left alone would name nothing, and Hermes would answer
 * "Unknown provider". Every scalar **value** equal to an old name the hub owns (a block in
 * this file, or the old name of a block it is writing) becomes the new name; keys, and
 * every string that is not exactly such a name, are left as they are.
 */
function migrateLegacyProviders(
  document: YAML.Document,
  wanted: ReadonlyMap<string, HermesProviderRoute>,
  result: HermesWriteResult,
): void {
  const legacyNames = new Set<string>();
  for (const name of wanted.keys()) {
    if (name.startsWith(OWNED_PROVIDER_PREFIX)) {
      legacyNames.add(`${LEGACY_PROVIDER_PREFIX}${name.slice(OWNED_PROVIDER_PREFIX.length)}`);
    }
  }
  const block = document.get('providers');
  if (YAML.isMap(block)) {
    for (const item of block.items) {
      const key = YAML.isScalar(item.key) ? item.key.value : item.key;
      if (typeof key === 'string' && key.startsWith(LEGACY_PROVIDER_PREFIX)) legacyNames.add(key);
    }
  }
  if (legacyNames.size === 0) return;
  const renamed = (name: string) =>
    `${OWNED_PROVIDER_PREFIX}${name.slice(LEGACY_PROVIDER_PREFIX.length)}`;
  YAML.visit(document, {
    Pair(_, pair, path) {
      // The `providers:` block itself is written by `applyProviders`; its old keys go there.
      const parent = path.at(-1);
      if (YAML.isMap(parent) && parent === block) return YAML.visit.SKIP;
      return undefined;
    },
    Scalar(key, node, path) {
      if (key === 'key') return undefined;
      if (typeof node.value !== 'string' || !legacyNames.has(node.value)) return undefined;
      const where = path
        .filter((step): step is YAML.Pair => YAML.isPair(step))
        .map((pair) => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key))
        .join('.');
      node.value = renamed(node.value);
      result.changed.push(where || 'provider reference');
      return undefined;
    },
  });
}

function applyProviders(
  document: YAML.Document,
  routes: readonly HermesProviderRoute[],
  result: HermesWriteResult,
): void {
  const wanted = new Map(routes.map((route) => [route.name, route]));
  migrateLegacyProviders(document, wanted, result);
  const existing = document.get('providers');
  const hasBlock = YAML.isMap(existing);
  if (!hasBlock && routes.length === 0) return;
  if (!hasBlock && existing !== undefined && existing !== null) {
    // Somebody's `providers:` is not a mapping. Rewriting it would lose whatever it is.
    throw new Error('config.yaml: `providers` is not a mapping; refusing to rewrite it');
  }
  // A real node, not a plain object: `setIn` below has to descend into it.
  if (!hasBlock) document.set('providers', new YAML.YAMLMap());

  for (const [name, route] of wanted) {
    const desired: Record<string, string> = {
      name,
      base_url: route.baseUrl,
      key_env: route.keyEnv,
    };
    if (route.apiMode) desired.api_mode = route.apiMode;
    const current = document.getIn(['providers', name]);
    const currentPlain = YAML.isMap(current) ? (current.toJSON() as Record<string, unknown>) : null;
    if (currentPlain && sameBlock(currentPlain, desired)) continue;
    document.setIn(['providers', name], desired);
    result.changed.push(`providers.${name}`);
  }

  const block = document.get('providers');
  if (!YAML.isMap(block)) return;
  for (const item of [...block.items]) {
    const key = YAML.isScalar(item.key) ? item.key.value : item.key;
    if (!isOwnedProviderKey(key) || wanted.has(key as string)) continue;
    document.deleteIn(['providers', key as string]);
    result.removed.push(`providers.${String(key)}`);
  }
  const after = document.get('providers');
  if (YAML.isMap(after) && after.items.length === 0) document.delete('providers');
}

/** A block is unchanged when it says exactly what we want it to say, and nothing else. */
function sameBlock(current: Record<string, unknown>, desired: Record<string, string>): boolean {
  const currentKeys = Object.keys(current);
  const desiredKeys = Object.keys(desired);
  if (currentKeys.length !== desiredKeys.length) return false;
  return desiredKeys.every((key) => current[key] === desired[key]);
}
