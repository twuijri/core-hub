/**
 * The one piece of a coding agent's own configuration the model gateway (ADR 0029) cannot say in
 * the environment, written and kept by the hub — DECISIONS §141.
 *
 * Most agents take the gateway from variables alone (`catalog/*.ts`, `gateway.env`). Three do not:
 *
 * - **Gemini CLI** needs nothing written while it has no sign-in type chosen, or an API key:
 *   `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` reach the gateway. But it reads the person's
 *   `security.auth.selectedType` before the variables (0.60.0 `zedIntegration`:
 *   `settings.merged.security.auth.selectedType || (baseUrl ? "gateway" : …)`), so one signed in
 *   with Google or Vertex would never reach it; the only settings above the person's are the
 *   system ones, which it reads only from a root-owned folder (checked: "is not owned by root",
 *   skipped). So it gets a home of the hub's own (`GEMINI_CLI_HOME`, under
 *   `<DATA_DIR>/gateway/agents/gemini-cli/home`): its `.gemini` holds a link to each entry of the
 *   person's own (sessions, memory, extensions, credentials — the same files) and a copy of their
 *   `settings.json` with `selectedType: "gateway"`. The person's files are not changed.
 * - **Grok Build** takes a model with its own address only from a `[model.<id>]` table of
 *   `$GROK_HOME/config.toml` (`~/.grok`); its `GROK_CONFIG` overlay does not define models (1.0.41,
 *   checked). The hub keeps one table, `[model.corehub-gateway]`, between two marker lines at the
 *   end of that file, and chooses it with `GROK_DEFAULT_MODEL` — the person's own `[models]
 *   default` stays as it was. Its key is named, never written: `env_key = "COREHUB_GATEWAY_TOKEN"`.
 * - **Pi** takes a provider only from `$PI_CODING_AGENT_DIR/models.json` (`~/.pi/agent`). The hub
 *   keeps one key there, `providers["corehub-gateway"]`, with `apiKey: "$COREHUB_GATEWAY_TOKEN"`,
 *   and every other key of the file as it was; the ACP session is then switched to it
 *   (`session/set_config_option`, which does not change Pi's saved default).
 *
 * What is written holds no key: the token is in the agent's environment only. The gateway's port
 * is in it (a new one each time the hub starts), so the block is rewritten when it differs. It is
 * left in place when the agent later runs on its own account — another conversation may be using
 * it at that moment — and without the token it serves nothing.
 *
 * Refused, with the reason, so the agent keeps its own account (the log says why): a file that
 * does not parse, a file or folder that is a link leading out of the home, a table or provider of
 * the same name the person wrote themselves, a file larger than 1 MiB.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { GatewayConfigKind, GatewayContext } from './catalog/types.js';
import { stripJsonComments } from './config-files.js';

/** The model id / provider id the hub keeps in an agent's own file. */
export const GATEWAY_CONFIG_ID = 'corehub-gateway';
/** The variable the written block names for its key. */
export const GATEWAY_TOKEN_VARIABLE = 'COREHUB_GATEWAY_TOKEN';

const MAX_BYTES = 1024 * 1024;
const BEGIN = '# >>> Core Hub model gateway (written by Core Hub; do not edit between these lines)';
const END = '# <<< Core Hub model gateway';

export interface GatewayConfigInput {
  kind: GatewayConfigKind;
  context: GatewayContext;
  /** The environment the agent will run with (the host's, then its own settings). */
  env: NodeJS.ProcessEnv;
  /** The home it runs in. */
  home: string;
  /** The hub's own folder for files it writes for agents (`<DATA_DIR>/gateway/agents`). */
  stateDir: string;
  platform?: NodeJS.Platform;
}

export type GatewayConfigResult =
  | {
      ok: true;
      /** Variables the agent is started with, on top of its wiring's. */
      env: Record<string, string>;
      /** ACP session options to set once the session exists (`session/set_config_option`). */
      sessionConfig?: Record<string, string>;
    }
  | { ok: false; reason: string };

export function applyGatewayConfig(input: GatewayConfigInput): GatewayConfigResult {
  try {
    switch (input.kind) {
      case 'gemini-settings':
        return geminiSettings(input);
      case 'grok-model':
        return grokModel(input);
      case 'pi-models':
        return piModels(input);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------------------ Gemini CLI

/** The sign-in types under which `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` reach the gateway. */
const GEMINI_GATEWAY_TYPES = new Set(['gateway', 'gemini-api-key']);

function geminiSettings(input: GatewayConfigInput): GatewayConfigResult {
  const personHome = input.env.GEMINI_CLI_HOME?.trim()
    ? path.resolve(input.env.GEMINI_CLI_HOME.trim())
    : input.home;
  const personDir = path.join(personHome, '.gemini');
  const settingsFile = path.join(personDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    const text = readCapped(settingsFile);
    if (text.trim()) {
      const parsed = JSON.parse(stripJsonComments(text)) as unknown;
      if (!isObject(parsed)) throw new Error(`${settingsFile} is not a JSON object`);
      settings = parsed;
    }
  }
  const security = isObject(settings.security) ? settings.security : {};
  const auth = isObject(security.auth) ? security.auth : {};
  const selected = typeof auth.selectedType === 'string' ? auth.selectedType : null;
  // No sign-in chosen, or an API key: the variables alone reach the gateway.
  if (!selected || GEMINI_GATEWAY_TYPES.has(selected)) return { ok: true, env: {} };
  if (typeof auth.enforcedType === 'string' && auth.enforcedType !== 'gateway') {
    throw new Error(`Gemini CLI's settings enforce the sign-in type "${auth.enforcedType}"`);
  }
  if ((input.platform ?? process.platform) === 'win32') {
    throw new Error(
      `Gemini CLI is signed in with "${selected}"; on Windows the hub cannot lend it a home of its own`,
    );
  }
  // Signed in another way (Google, Vertex): the person's choice wins over the variables, and only
  // a root-owned system file could outrank it. So Gemini CLI gets a home of the hub's own for this
  // run (`GEMINI_CLI_HOME`): the same `.gemini` — every entry a link to the person's own, so its
  // sessions, memory, extensions and credentials are the same ones — except `settings.json`,
  // which is the person's with the sign-in type set to `gateway`. Nothing of the person's changes.
  const home = path.join(input.stateDir, 'gemini-cli', 'home');
  const dir = path.join(home, '.gemini');
  mkdirSync(personDir, { recursive: true, mode: 0o700 });
  // Where it keeps its sessions: made in the person's folder now, so it is linked, not copied.
  mkdirSync(path.join(personDir, 'tmp'), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wanted = new Set<string>();
  for (const name of readdirSync(personDir)) {
    if (name === 'settings.json' || name.startsWith('.corehub-')) continue;
    wanted.add(name);
    linkTo(path.join(dir, name), path.join(personDir, name));
  }
  for (const name of readdirSync(dir)) {
    if (name === 'settings.json' || wanted.has(name)) continue;
    // A link to something the person has since removed; anything else is left alone.
    if (lstatSync(path.join(dir, name)).isSymbolicLink()) rmSync(path.join(dir, name));
  }
  // `~/.agents` (its global agents and skills) is read from the home too.
  const agents = path.join(personHome, '.agents');
  if (existsSync(agents)) linkTo(path.join(home, '.agents'), agents);
  const merged = {
    ...settings,
    security: { ...security, auth: { ...auth, selectedType: 'gateway' } },
  };
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  const target = path.join(dir, 'settings.json');
  if (!existsSync(target) || readFileSync(target, 'utf8') !== text) writeOwned(dir, target, text);
  return { ok: true, env: { GEMINI_CLI_HOME: home } };
}

/** `link` points at `target` (made, or remade when it points elsewhere); a real file is kept. */
function linkTo(link: string, target: string): void {
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) return;
    if (readlinkSync(link) === target) return;
    rmSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    symlinkSync(target, link);
  } catch (error) {
    // Another conversation made it a moment ago.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

// ------------------------------------------------------------------------ Grok Build

function grokModel(input: GatewayConfigInput): GatewayConfigResult {
  const grokHome = input.env.GROK_HOME?.trim()
    ? path.resolve(input.env.GROK_HOME.trim())
    : path.join(input.home, '.grok');
  const file = path.join(grokHome, 'config.toml');
  const { context } = input;
  const block = [
    BEGIN,
    `[model.${GATEWAY_CONFIG_ID}]`,
    `name = "Core Hub"`,
    `description = "The model picked in Core Hub (works only when Core Hub starts Grok Build)"`,
    `model = ${tomlString(context.mainModel)}`,
    `base_url = ${tomlString(context.openaiBaseUrl)}`,
    `api_backend = "chat_completions"`,
    `env_key = "${GATEWAY_TOKEN_VARIABLE}"`,
    `context_window = ${Math.max(8_192, Math.floor(context.contextWindow ?? 128_000))}`,
    END,
  ].join('\n');
  const real = safeTarget(file, input.home, grokHome);
  const current = existsSync(real) ? readCapped(real) : '';
  const outside = withoutBlock(current);
  if (outside === null) throw new Error(`${file} has a Core Hub block that is not closed`);
  if (
    new RegExp(`^\\s*\\[\\s*model\\.("?)${GATEWAY_CONFIG_ID}\\1\\s*\\]`, 'm').test(outside) ||
    new RegExp(`^\\s*model\\.("?)${GATEWAY_CONFIG_ID}\\1\\s*[.=]`, 'm').test(outside)
  ) {
    throw new Error(`${file} already defines a model named ${GATEWAY_CONFIG_ID}`);
  }
  const next = replaceBlock(current, block);
  if (next !== current) writeOwned(path.dirname(real), real, next);
  return { ok: true, env: { GROK_DEFAULT_MODEL: GATEWAY_CONFIG_ID } };
}

/** A TOML basic string. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The text with the hub's block taken out; `null` when a block is opened and never closed. */
function withoutBlock(text: string): string | null {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return null;
  return text.slice(0, start) + text.slice(end + END.length);
}

/** The block put where it was, or at the end; the rest of the file byte for byte. */
function replaceBlock(text: string, block: string): string {
  const start = text.indexOf(BEGIN);
  if (start >= 0) {
    const end = text.indexOf(END, start);
    return text.slice(0, start) + block + text.slice(end + END.length);
  }
  if (!text) return `${block}\n`;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

// ------------------------------------------------------------------------ Pi

function piModels(input: GatewayConfigInput): GatewayConfigResult {
  const agentDir = input.env.PI_CODING_AGENT_DIR?.trim()
    ? path.resolve(input.env.PI_CODING_AGENT_DIR.trim())
    : path.join(input.home, '.pi', 'agent');
  const file = path.join(agentDir, 'models.json');
  const real = safeTarget(file, input.home, agentDir);
  let document: Record<string, unknown> = {};
  let current = '';
  if (existsSync(real)) {
    current = readCapped(real);
    if (current.trim()) {
      const parsed = JSON.parse(current) as unknown;
      if (!isObject(parsed)) throw new Error(`${file} is not a JSON object`);
      document = parsed;
    }
  }
  const providers = isObject(document.providers) ? document.providers : {};
  const existing = providers[GATEWAY_CONFIG_ID];
  // The hub's own entry is known by its address: the gateway's loopback Chat Completions path.
  const ours =
    isObject(existing) &&
    typeof existing.baseUrl === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+\/gateway\/openai\/v1$/.test(existing.baseUrl);
  if (existing !== undefined && !ours) {
    throw new Error(`${file} already has a provider named ${GATEWAY_CONFIG_ID}`);
  }
  const { context } = input;
  const window = Math.max(8_192, Math.floor(context.contextWindow ?? 128_000));
  const provider = {
    name: 'Core Hub',
    baseUrl: context.openaiBaseUrl,
    api: 'openai-completions',
    apiKey: `$${GATEWAY_TOKEN_VARIABLE}`,
    models: [
      { id: context.mainModel, name: 'Core Hub', contextWindow: window, maxTokens: 32_000 },
      {
        id: context.smallModel,
        name: 'Core Hub (small)',
        contextWindow: window,
        maxTokens: 32_000,
      },
    ],
  };
  const next = {
    ...document,
    providers: { ...providers, [GATEWAY_CONFIG_ID]: provider },
  };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text !== current) writeOwned(path.dirname(real), real, text);
  return {
    ok: true,
    env: {},
    sessionConfig: { model: `${GATEWAY_CONFIG_ID}/${context.mainModel}` },
  };
}

// ------------------------------------------------------------------------ files

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readCapped(file: string): string {
  if (statSync(file).size > MAX_BYTES) throw new Error(`${file} is larger than 1 MiB`);
  return readFileSync(file, 'utf8');
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The file to write: the real path when it (or a folder on the way) is a link that stays in the
 * home or the agent's own folder; refused when it leads elsewhere.
 */
function safeTarget(file: string, home: string, agentDir: string): string {
  let existing = file;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(realpathSync(existing), ...missing);
  const roots = [home, agentDir].flatMap((root) => {
    try {
      return [path.resolve(root), realpathSync(root)];
    } catch {
      return [path.resolve(root)];
    }
  });
  if (!roots.some((root) => inside(real, root))) {
    throw new Error(`${file} leads outside the home (${real})`);
  }
  return real;
}

/** A new file beside the target, renamed over it; the target's mode kept (`0600` for a new one). */
function writeOwned(dir: string, target: string, content: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`${target} is a link`);
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
