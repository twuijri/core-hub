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

/** What the workspace currently wants every agent to use. */
export interface PropagationState {
  credentials: ResolvedCredential[];
  /**
   * The chat default in Hermes's vocabulary, or null — either because the owner set
   * none, or because the provider it names is one Hermes has no slug for. Null means
   * "leave Hermes's own selection alone", never "guess".
   */
  hermesModel: HermesModelChoice | null;
  /** Why `hermesModel` is null, when the owner did choose a default. */
  hermesModelBlocked: string | null;
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
  const owned = new Set<string>();
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
  const temp = `${file}.majlis-${process.pid}.tmp`;
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
  const text = merged.text === '' ? `${MANAGED_MARKER}\n` : merged.text;
  const dirty = text !== existing;
  if (dirty) writeAtomic(plan.file, text);
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
  const file = path.join(home, 'config.yaml');
  const result: HermesWriteResult = { file, changed: [], removed: [], dirty: false };
  if (!choice) return result;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const document = YAML.parseDocument(existing);
  if (document.errors.length > 0) {
    // A config we cannot parse is a config we must not rewrite: Hermes serves the last
    // known good one, and a clobbered file would take that away too.
    throw new Error(`${file} is not valid YAML; refusing to rewrite it`);
  }
  // A fresh install ships `model: ""` (an empty-string sentinel). Replace it with the
  // mapping Hermes itself upgrades it to, rather than setting a key inside a string.
  const current = document.get('model');
  if (typeof current === 'string' || current === null || current === undefined) {
    document.set('model', { default: choice.model, provider: choice.provider });
    result.changed.push('model.default', 'model.provider');
  } else {
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
  const text = document.toString();
  result.dirty = text !== existing;
  if (result.dirty) writeAtomic(file, text);
  return result;
}

export interface HermesPropagation {
  env: HermesWriteResult;
  model: HermesWriteResult;
  /** True when either file changed and the gateway should be recycled. */
  dirty: boolean;
}

/** Both files, in one call. Throws only on a corrupt `config.yaml`; the caller logs it. */
export function writeHermesConfiguration(home: string, state: PropagationState): HermesPropagation {
  const env = writeHermesEnv(hermesEnvPlan(home, state));
  const model = writeHermesModel(home, state.hermesModel);
  return { env, model, dirty: env.dirty || model.dirty };
}
