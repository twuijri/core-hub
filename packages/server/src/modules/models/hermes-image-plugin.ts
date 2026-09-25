/**
 * The image backend the hub gives Hermes (contract decision §72).
 *
 * Hermes's `image_generate` tool calls whichever backend `image_gen.provider` names, and a
 * backend is a plugin folder under `plugins/image_gen/` of a Hermes home (read from Hermes's
 * MIT source; the change record of 2026-09-26 says what was observed). None of the backends
 * Hermes ships takes an arbitrary OpenAI-compatible address, key and model, so the hub brings
 * its own: `skill-library/_hermes-plugin/` (its `plugin.yaml` and `__init__.py`), plus the
 * `image_api.py` the `image-generate` and `image-edit` skills run — one implementation of the
 * image protocols, so the tool and the skills can never disagree about the chosen model.
 *
 * The folder is written only while the profile has an image model; the files are the hub's
 * and are rewritten whenever they differ from what this version ships. Removing the choice
 * leaves them in place, inert: `config.yaml` no longer lists or names the backend.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_IMAGE_PLUGIN } from './images.js';

/** `packages/server/skill-library/`, from `src/modules/models/` and `dist/modules/models/`. */
const LIBRARY = fileURLToPath(new URL('../../../skill-library/', import.meta.url));

export interface PluginFile {
  /** Name inside the plugin folder. */
  name: string;
  data: Buffer;
}

/** The plugin's files as this version ships them. */
export function imagePluginFiles(root: string = LIBRARY): PluginFile[] {
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts));
  return [
    { name: 'plugin.yaml', data: read('_hermes-plugin', 'plugin.yaml') },
    { name: '__init__.py', data: read('_hermes-plugin', '__init__.py') },
    { name: 'image_api.py', data: read('image-generate', 'scripts', 'image_api.py') },
  ];
}

let shipped: PluginFile[] | null = null;
function shippedFiles(): PluginFile[] {
  shipped ??= imagePluginFiles();
  return shipped;
}

/** Where the plugin lives in a Hermes home. */
export function imagePluginDir(home: string): string {
  return path.join(home, 'plugins', 'image_gen', HERMES_IMAGE_PLUGIN.name);
}

/**
 * Puts the plugin into one Hermes home when `wanted`, rewriting only a file whose bytes
 * differ. Returns the names written — a written file means the gateway must reload.
 */
export function writeHermesImagePlugin(
  home: string,
  wanted: boolean,
  files?: readonly PluginFile[],
): string[] {
  if (!wanted) return [];
  const dir = imagePluginDir(home);
  const written: string[] = [];
  for (const file of files ?? shippedFiles()) {
    const target = path.join(dir, file.name);
    if (existsSync(target) && readFileSync(target).equals(file.data)) continue;
    mkdirSync(dir, { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, file.data, { mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, target);
    written.push(`plugins/image_gen/${HERMES_IMAGE_PLUGIN.name}/${file.name}`);
  }
  return written;
}
