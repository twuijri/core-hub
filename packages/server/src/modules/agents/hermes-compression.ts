/**
 * A profile's automatic context compression, where Hermes reads it: the profile's
 * `config.yaml` (decision §52).
 *
 * What Hermes does with these keys (read in its MIT source at v2026.9.14,
 * `hermes_cli/config_defaults.py` §compression, `tui_gateway/session_compression.py`
 * §_apply_live_compression_config; specified here in our words):
 *
 *   compression.enabled         on/off; default on
 *   compression.threshold       compress when the conversation fills this share of the
 *                               window; default 0.50, raised to 0.75 for windows < 512K
 *   compression.target_ratio    share of the threshold kept word for word; default 0.20,
 *                               clamped by Hermes to 0.10–0.80
 *   compression.protect_first_n messages at the start always kept; default 3
 *   compression.protect_last_n  recent messages always kept; default 20
 *   model.context_length        the model's window when its metadata is wrong; absent = the
 *                               model's own
 *
 * The TUI gateway re-reads these at the start of every turn and applies them to a live
 * conversation in place, so a change here reaches the next message without a restart. A key
 * that is absent means Hermes's default, which is what the hub reports for it.
 *
 * Writes touch only these keys and leave every other byte of the file alone (the same
 * `yaml` document editing `mcp.ts` and `telegram-settings.ts` use). A file that is not YAML
 * Hermes could read is never rewritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';

export interface HermesCompression {
  enabled: boolean;
  threshold: number;
  targetRatio: number;
  protectFirst: number;
  protectLast: number;
  /** `null` = the model's own window. */
  contextLength: number | null;
}

/** Hermes's values when `config.yaml` names none. */
export const HERMES_COMPRESSION_DEFAULTS: HermesCompression = {
  enabled: true,
  threshold: 0.5,
  targetRatio: 0.2,
  protectFirst: 3,
  protectLast: 20,
  contextLength: null,
};

export class HermesCompressionError extends Error {
  constructor(readonly reason: 'config_unreadable') {
    super(reason);
    this.name = 'HermesCompressionError';
  }
}

const CONFIG_FILE = 'config.yaml';

function load(home: string): Document {
  const file = path.join(home, CONFIG_FILE);
  if (!existsSync(file)) return parseDocument('');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new HermesCompressionError('config_unreadable');
  return doc;
}

const numberOf = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** Hermes reads `true`/`1`/`yes` (any case) as on; anything else it was given is off. */
const flagOf = (value: unknown): boolean | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
};

/** The profile's settings as Hermes will use them: its file, else its defaults. */
export function readHermesCompression(home: string): HermesCompression {
  const doc = load(home);
  const config = (doc.toJS() ?? {}) as Record<string, unknown>;
  const block = (
    config.compression && typeof config.compression === 'object' ? config.compression : {}
  ) as Record<string, unknown>;
  const model = config.model as Record<string, unknown> | string | null | undefined;
  const defaults = HERMES_COMPRESSION_DEFAULTS;
  const whole = (value: unknown, fallback: number) => {
    const n = numberOf(value);
    return n === null ? fallback : Math.max(0, Math.trunc(n));
  };
  const contextLength = numberOf(
    model && typeof model === 'object' ? model.context_length : undefined,
  );
  return {
    enabled: flagOf(block.enabled) ?? defaults.enabled,
    threshold: numberOf(block.threshold) ?? defaults.threshold,
    targetRatio: numberOf(block.target_ratio) ?? defaults.targetRatio,
    protectFirst: whole(block.protect_first_n, defaults.protectFirst),
    protectLast: whole(block.protect_last_n, defaults.protectLast),
    contextLength: contextLength !== null && contextLength > 0 ? Math.trunc(contextLength) : null,
  };
}

/** Writes the six keys; `contextLength: null` removes `model.context_length`. */
export function writeHermesCompression(home: string, settings: HermesCompression): void {
  const doc = load(home);
  // A fresh install's file is empty, which parses to no mapping at all.
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as typeof doc.contents;
  const compression = doc.get('compression', true);
  // A scalar where Hermes expects a block: Hermes reads it as no block, so it becomes one.
  if (compression !== undefined && !isMap(compression)) doc.set('compression', doc.createNode({}));
  const model = doc.get('model');
  if (settings.contextLength !== null && typeof model === 'string') {
    // The older one-line form (`model: name`) is the default model: keep it as Hermes's own
    // upgrade of it does, `model.default`, rather than lose it to the new key.
    doc.set('model', doc.createNode(model.trim() ? { default: model } : {}));
  } else if (settings.contextLength !== null && !isMap(doc.get('model', true))) {
    doc.set('model', doc.createNode({}));
  }
  doc.setIn(['compression', 'enabled'], settings.enabled);
  doc.setIn(['compression', 'threshold'], settings.threshold);
  doc.setIn(['compression', 'target_ratio'], settings.targetRatio);
  doc.setIn(['compression', 'protect_first_n'], Math.trunc(settings.protectFirst));
  doc.setIn(['compression', 'protect_last_n'], Math.trunc(settings.protectLast));
  if (settings.contextLength === null) {
    if (isMap(doc.get('model', true)) && doc.hasIn(['model', 'context_length']))
      doc.deleteIn(['model', 'context_length']);
  } else {
    doc.setIn(['model', 'context_length'], Math.trunc(settings.contextLength));
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, CONFIG_FILE), doc.toString(), 'utf8');
}
