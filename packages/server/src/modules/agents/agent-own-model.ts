/**
 * The model a coding agent's own settings name as its default (owner, 2026-09-29: the chat's
 * model picker said "Default model" without saying which). A coding agent over ACP runs on the
 * model its own config chooses — the hub hands it no model — so that is the default a person
 * gets, read from the same files the Config files page edits:
 *
 * - Claude Code: `model` in `settings.json` (its config folder);
 * - Codex: the top-level `model = "…"` of `config.toml`;
 * - Gemini CLI / Qwen Code: `model.name` (or a string `model`) in `settings.json`;
 * - Goose: `GOOSE_MODEL` in `config.yaml`;
 * - OpenCode: `model` in `~/.config/opencode/opencode.json`.
 *
 * `null` when the file names none (the agent then uses its vendor's default, which the hub
 * cannot know) or cannot be read. Never a guess.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { stripJsonComments } from './config-files.js';

const MAX_READ = 1024 * 1024;

function read(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_READ) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function json(file: string): Record<string, unknown> | null {
  const text = read(file);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(stripJsonComments(text));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const named = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;

/** `model` as a string, or `model.name`: the two shapes Gemini's settings have had. */
function modelOf(doc: Record<string, unknown> | null): string | null {
  if (!doc) return null;
  const model = doc.model;
  if (model && typeof model === 'object') return named((model as { name?: unknown }).name);
  return named(model);
}

const dirOf = (env: NodeJS.ProcessEnv, variable: string, fallback: string): string => {
  const value = env[variable]?.trim();
  return value ? path.resolve(value) : fallback;
};

export function agentOwnModel(
  slug: string,
  options: { env: NodeJS.ProcessEnv; home?: string },
): string | null {
  const env = options.env;
  const home = path.resolve(options.home ?? (env.HOME || homedir()));
  switch (slug) {
    case 'claude-code':
      return named(
        json(
          path.join(dirOf(env, 'CLAUDE_CONFIG_DIR', path.join(home, '.claude')), 'settings.json'),
        )?.model,
      );
    case 'codex': {
      const text = read(
        path.join(dirOf(env, 'CODEX_HOME', path.join(home, '.codex')), 'config.toml'),
      );
      if (!text) return null;
      // Only the top level, before the first table: `[profiles.x] model = …` is not the default.
      const top = text.split(/^\s*\[/m)[0] ?? '';
      const match = /^\s*model\s*=\s*"([^"\n]+)"/m.exec(top);
      return named(match?.[1]);
    }
    case 'gemini-cli':
      return modelOf(
        json(path.join(dirOf(env, 'GEMINI_CLI_HOME', home), '.gemini', 'settings.json')),
      );
    case 'qwen-code':
      return modelOf(
        json(path.join(dirOf(env, 'QWEN_HOME', path.join(home, '.qwen')), 'settings.json')),
      );
    case 'goose': {
      const text = read(path.join(home, '.config', 'goose', 'config.yaml'));
      if (!text) return null;
      try {
        const doc = parseYaml(text) as { GOOSE_MODEL?: unknown } | null;
        return named(doc?.GOOSE_MODEL);
      } catch {
        return null;
      }
    }
    case 'opencode':
      return named(json(path.join(home, '.config', 'opencode', 'opencode.json'))?.model);
    default:
      return null;
  }
}
