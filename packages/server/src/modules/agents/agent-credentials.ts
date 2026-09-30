/**
 * Whether an installed coding agent has something to answer with: a provider key it will be
 * handed, or its own sign-in (owner, 2026-09-29: Goose, installed with no `config.yaml`, and
 * Claude Code, signed in nowhere, both looked ready on their cards and failed the first
 * message with "Internal error" / "Authentication required").
 *
 * Said only where the hub can know it, from what each agent itself reads — never a guess:
 *
 * - **a key it is handed**: one of the variables the agent's catalog entry declares (the hub's
 *   shared providers, ADR 0010), or one the agent reads from the environment the hub runs it
 *   in;
 * - **its own sign-in or provider setting**: the file the agent keeps it in, under the hub
 *   user's home (the same home as the Config files page).
 *
 * `missing` when none is there, `ready` when one is; an agent not listed here has no answer
 * (`null`), and its card says nothing either way. Goose is `ready` only once its own config
 * names a provider (`GOOSE_PROVIDER`): a key alone does not start an ACP session.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type CredentialState = 'ready' | 'missing';

interface Where {
  env: NodeJS.ProcessEnv;
  home: string;
}

interface AgentSources {
  /** Variables beyond the catalog's declared ones that give the agent a way in. */
  env: readonly string[];
  /** Files whose presence is a sign-in. */
  files(where: Where): string[];
  /** Files whose text names a provider or key setting. */
  mentions?(where: Where): { file: string; pattern: RegExp }[];
  /** Only the agent's own provider setting counts, not a key alone (Goose). */
  needsOwnSetting?: boolean;
}

const dirOf = (env: NodeJS.ProcessEnv, variable: string, fallback: string): string => {
  const value = env[variable]?.trim();
  return value ? path.resolve(value) : fallback;
};

const SOURCES: Readonly<Record<string, AgentSources>> = {
  'claude-code': {
    env: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
    ],
    // `claude login` keeps its credential in `.credentials.json` in its config folder.
    files: ({ env, home }) => [
      path.join(dirOf(env, 'CLAUDE_CONFIG_DIR', path.join(home, '.claude')), '.credentials.json'),
    ],
    mentions: ({ env, home }) => [
      {
        file: path.join(
          dirOf(env, 'CLAUDE_CONFIG_DIR', path.join(home, '.claude')),
          'settings.json',
        ),
        pattern: /ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|apiKeyHelper|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX)/,
      },
    ],
  },
  codex: {
    env: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    // `codex login` (ChatGPT or a key) writes `auth.json`; a custom provider is `config.toml`'s.
    files: ({ env, home }) => [
      path.join(dirOf(env, 'CODEX_HOME', path.join(home, '.codex')), 'auth.json'),
    ],
    mentions: ({ env, home }) => [
      {
        file: path.join(dirOf(env, 'CODEX_HOME', path.join(home, '.codex')), 'config.toml'),
        pattern: /^\s*(?:model_provider\s*=|\[model_providers\.)/m,
      },
    ],
  },
  'gemini-cli': {
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'],
    // A Google sign-in is `oauth_creds.json`; a key may sit in the folder's own `.env`.
    files: ({ env, home }) => [
      path.join(dirOf(env, 'GEMINI_CLI_HOME', home), '.gemini', 'oauth_creds.json'),
    ],
    mentions: ({ env, home }) => [
      {
        file: path.join(dirOf(env, 'GEMINI_CLI_HOME', home), '.gemini', '.env'),
        pattern: /^\s*(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*\S/m,
      },
    ],
  },
  'qwen-code': {
    env: ['DASHSCOPE_API_KEY'],
    files: ({ env, home }) => [
      path.join(dirOf(env, 'QWEN_HOME', path.join(home, '.qwen')), 'oauth_creds.json'),
    ],
  },
  goose: {
    env: ['GOOSE_PROVIDER'],
    files: () => [],
    mentions: ({ home }) => [
      {
        file: path.join(home, '.config', 'goose', 'config.yaml'),
        pattern: /^\s*GOOSE_PROVIDER\s*:\s*\S/m,
      },
    ],
    needsOwnSetting: true,
  },
};

/**
 * The variables beyond its catalog keys that give an agent a way in — each must reach the agent
 * when it runs (the allow-list, DECISIONS §139, is tested against this).
 */
export function credentialVariables(slug: string): readonly string[] {
  return Object.hasOwn(SOURCES, slug) ? SOURCES[slug]!.env : [];
}

const MAX_READ = 1024 * 1024;

function mentions(file: string, pattern: RegExp): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_READ) return false;
    return pattern.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

const present = (env: NodeJS.ProcessEnv, name: string): boolean => !!env[name]?.trim();

export interface CredentialProbeOptions {
  /** The environment the hub hands its coding agents. */
  env: NodeJS.ProcessEnv;
  /** The home, when not `env.HOME` (tests). */
  home?: string;
}

/**
 * `ready` / `missing` for an agent the hub can answer for, else `null`. `handed` is what the
 * hub will add to the agent's environment for this profile (its shared provider keys and the
 * agent's own settings); `declared` the variables its catalog entry maps them to.
 */
export function credentialState(
  slug: string,
  declared: readonly string[],
  handed: Readonly<Record<string, string>>,
  options: CredentialProbeOptions,
): CredentialState | null {
  const sources = Object.hasOwn(SOURCES, slug) ? SOURCES[slug] : undefined;
  if (!sources) return null;
  const env: NodeJS.ProcessEnv = { ...options.env, ...handed };
  const where: Where = { env, home: path.resolve(options.home ?? (options.env.HOME || homedir())) };
  const own =
    sources.env.some((name) => present(env, name)) ||
    sources.files(where).some((file) => existsSync(file)) ||
    (sources.mentions?.(where) ?? []).some(({ file, pattern }) => mentions(file, pattern));
  if (own) return 'ready';
  if (sources.needsOwnSetting) return 'missing';
  return declared.some((name) => present(env, name)) ? 'ready' : 'missing';
}

/**
 * Whether an agent has an account or provider of its own on this computer — its sign-in file, a
 * provider its own settings name, or a key in the environment the hub runs it in — leaving out
 * what the hub itself would hand it. On a person's computer such an agent keeps using it until the
 * person switches it to the hub's models (ADR 0029: the automatic model source). `false` for an
 * agent the hub cannot answer for.
 */
export function ownSignIn(slug: string, options: CredentialProbeOptions): boolean {
  const sources = Object.hasOwn(SOURCES, slug) ? SOURCES[slug] : undefined;
  if (!sources) return false;
  const env = options.env;
  const where: Where = { env, home: path.resolve(options.home ?? (env.HOME || homedir())) };
  return (
    sources.env.some((name) => present(env, name)) ||
    sources.files(where).some((file) => existsSync(file)) ||
    (sources.mentions?.(where) ?? []).some(({ file, pattern }) => mentions(file, pattern))
  );
}
