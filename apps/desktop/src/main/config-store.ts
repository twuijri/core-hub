/**
 * `desktop.json` in the app-data folder: read once at start, written whole on each change
 * (to a temporary file, then renamed, so a crash mid-write never leaves half a file).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, type DesktopConfig } from '../shared/config.js';

export class ConfigStore {
  private current: DesktopConfig;
  private readonly file: string;

  constructor(dir: string, makeId: () => string = randomUUID) {
    this.file = path.join(dir, 'desktop.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      raw = null;
    }
    this.current = parseConfig(raw, makeId);
    // The device key must survive the first launch even if nothing else is changed.
    if (raw === null) this.write();
  }

  get(): DesktopConfig {
    return this.current;
  }

  update(change: (config: DesktopConfig) => DesktopConfig): DesktopConfig {
    this.current = change(this.current);
    this.write();
    return this.current;
  }

  private write(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      // A read-only profile folder: the app still works for this run.
    }
  }
}

/** The saved language, read before the app is ready (Chromium takes `--lang` only then). */
export function parseConfigLanguage(dir: string): 'ar' | 'en' | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'desktop.json'), 'utf8')) as {
      language?: unknown;
    };
    return raw.language === 'ar' || raw.language === 'en' ? raw.language : null;
  } catch {
    return null;
  }
}
