/**
 * 1.1.1 installed `corehub.app` on macOS; since then the app is `Core Hub.app`
 * (docs/changes/2026-09-26-twuijri-desktop-app-name.md). Updating by dragging the new app out of
 * the DMG leaves the old one beside it — same bundle id, same data folder — so the app offers,
 * once, to move the old copy to the Trash. It never deletes anything, and never asks twice.
 *
 * Only a real old Core Hub is offered: a `corehub.app` in the same folder as the running
 * `Core Hub.app`, not the running app itself, whose Info.plist names one of Core Hub's bundle ids.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_BUNDLE = 'corehub.app';
export const CURRENT_BUNDLE = 'Core Hub.app';
/** Every bundle id a Core Hub for macOS has had. */
export const CORE_HUB_BUNDLE_IDS = ['com.twuijri.corehub', 'io.github.twuijri.corehub'];

export interface LegacyFs {
  exists(file: string): boolean;
  realpath(file: string): string;
  read(file: string): Buffer;
}

const nodeFs: LegacyFs = {
  exists: existsSync,
  realpath: (file) => realpathSync(file),
  read: (file) => readFileSync(file),
};

/** `/Applications/Core Hub.app/Contents/MacOS/Core Hub` → `/Applications/Core Hub.app`. */
export function bundleOf(exePath: string): string | null {
  const macos = path.dirname(exePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  return path.basename(macos) === 'MacOS' &&
    path.basename(contents) === 'Contents' &&
    bundle.endsWith('.app')
    ? bundle
    : null;
}

/** Whether an Info.plist (XML or binary) belongs to a Core Hub. */
export function isCoreHubPlist(plist: Buffer): boolean {
  const text = plist.toString('latin1');
  return CORE_HUB_BUNDLE_IDS.some((id) =>
    text.startsWith('bplist')
      ? text.includes(id)
      : new RegExp(
          `<key>CFBundleIdentifier</key>\\s*<string>${id.replace(/\./g, '\\.')}</string>`,
        ).test(text),
  );
}

/** The old `corehub.app` to offer to the Trash, or null. */
export function findLegacyApp(
  input: { exePath: string; platform: string },
  fs: LegacyFs = nodeFs,
): string | null {
  if (input.platform !== 'darwin') return null;
  const bundle = bundleOf(input.exePath);
  if (!bundle || path.basename(bundle) !== CURRENT_BUNDLE) return null;
  const candidate = path.join(path.dirname(bundle), LEGACY_BUNDLE);
  try {
    if (!fs.exists(candidate)) return null;
    if (fs.realpath(candidate) === fs.realpath(bundle)) return null;
    const plist = path.join(candidate, 'Contents', 'Info.plist');
    if (!fs.exists(plist) || !isCoreHubPlist(fs.read(plist))) return null;
    return candidate;
  } catch {
    return null;
  }
}
