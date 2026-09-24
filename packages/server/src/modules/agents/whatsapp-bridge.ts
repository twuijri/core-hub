/**
 * A profile's copy of Hermes's WhatsApp bridge, pointed at the dependencies the image ships.
 *
 * Hermes runs its WhatsApp bridge (`scripts/whatsapp-bridge`, Node and Baileys) from its install
 * tree when it can write there, and otherwise from `<HERMES_HOME>/scripts/whatsapp-bridge`, which
 * it copies from the install tree the first time and then uses as it is
 * (`gateway/platforms/whatsapp_common.py` §resolve_whatsapp_bridge_dir, Hermes v2026.9.14, MIT).
 * Before it starts the bridge it runs `npm install` there unless `node_modules/.hermes-pkg-hash`
 * holds the hash of the bridge's `package.json` (`plugins/platforms/whatsapp/adapter.py`
 * §_ensure_bridge_deps); the pairing screen skips the install when `node_modules` exists at all
 * (`hermes_cli/web_routers/messaging.py`).
 *
 * The image's install tree is read-only and carries the bridge's dependencies already installed,
 * with that stamp (packages/server/Dockerfile). Left to itself, Hermes would copy all of it —
 * 71 MB — into every home that links a phone. So before Hermes can, the hub makes the home's copy:
 * the bridge's own files, and `node_modules` as a symlink to the image's. Hermes finds a copy,
 * uses it, reads the image's stamp through the link and installs nothing. Node resolves the
 * packages through the link and then by their real path, so a package's own dependencies are
 * found beside it in the image.
 *
 * The copy is made again whenever a file of the image's bridge differs from the home's (a new
 * Hermes in a new image). A home whose `node_modules` is a real folder — Hermes installed it
 * there before the image carried one — is left as it is while Hermes would still use it: same
 * bridge files and the same stamp as the image's. Otherwise it is replaced by the link.
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

/** Where the image puts Hermes's bridge, its dependencies installed (packages/server/Dockerfile). */
export const IMAGE_WHATSAPP_BRIDGE = '/opt/hermes/src/scripts/whatsapp-bridge';

/** The stamp Hermes's adapter compares with the hash of `package.json`. */
const STAMP = '.hermes-pkg-hash';

/**
 * What `prepareWhatsAppBridge` did:
 * - `no-image-bridge`: there is no installed bridge to point at (not the image) — nothing done;
 * - `created`: the home had no bridge, and now has the copy and the link;
 * - `refreshed`: the home's bridge differed from the image's and was replaced;
 * - `linked`: the files were current, the link was missing or pointed elsewhere, and was made;
 * - `kept-own`: the home's own installed `node_modules` still matches; left alone;
 * - `current`: already the copy and the link.
 */
export type BridgePreparation =
  'no-image-bridge' | 'created' | 'refreshed' | 'linked' | 'kept-own' | 'current';

function stat(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function read(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** The bridge's own files, relative to its folder: everything but `node_modules`. */
function bridgeFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (!prefix && entry.name === 'node_modules') continue;
    if (entry.isDirectory()) files.push(...bridgeFiles(dir, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * Makes `<home>/scripts/whatsapp-bridge` the image's bridge with the image's dependencies, before
 * a gateway or the pairing screen in that home would start it. `source` is the installed bridge
 * (the image's by default; tests pass their own).
 */
export function prepareWhatsAppBridge(
  home: string,
  source: string = IMAGE_WHATSAPP_BRIDGE,
): BridgePreparation {
  const modules = path.join(source, 'node_modules');
  if (!stat(modules)?.isDirectory() || !stat(path.join(source, 'package.json'))?.isFile()) {
    return 'no-image-bridge';
  }
  const target = path.join(home, 'scripts', 'whatsapp-bridge');
  const files = bridgeFiles(source);
  const existing = stat(target);

  if (existing?.isDirectory()) {
    const same = files.every((file) => {
      const theirs = read(path.join(target, file));
      return theirs !== null && theirs.equals(read(path.join(source, file)) ?? Buffer.alloc(0));
    });
    if (same) {
      const link = path.join(target, 'node_modules');
      const linkStat = stat(link);
      if (linkStat?.isSymbolicLink() && readlinkSync(link) === modules) return 'current';
      if (linkStat?.isDirectory()) {
        const own = read(path.join(link, STAMP))?.toString('utf8').trim();
        const image = read(path.join(modules, STAMP))?.toString('utf8').trim();
        if (own && own === image) return 'kept-own';
      }
      if (linkStat) rmSync(link, { recursive: true, force: true });
      symlinkSync(modules, link, 'dir');
      return 'linked';
    }
  }

  // A fresh copy beside the old one, swapped in by rename: a crash halfway leaves the old copy
  // or the new one in place, never half of each.
  const stamp = `${process.pid}-${Date.now()}`;
  const fresh = `${target}.new-${stamp}`;
  mkdirSync(fresh, { recursive: true });
  try {
    for (const file of files) {
      mkdirSync(path.dirname(path.join(fresh, file)), { recursive: true });
      copyFileSync(path.join(source, file), path.join(fresh, file));
    }
    symlinkSync(modules, path.join(fresh, 'node_modules'), 'dir');
    if (existing) {
      const old = `${target}.old-${stamp}`;
      renameSync(target, old);
      renameSync(fresh, target);
      rmSync(old, { recursive: true, force: true });
      return 'refreshed';
    }
    renameSync(fresh, target);
    return 'created';
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
}
