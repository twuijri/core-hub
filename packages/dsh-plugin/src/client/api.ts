/**
 * The page's calls to the plugin's host half: exact routes on the harness's `/api` channel
 * (`/api/corehub/<name>`), relative to the page so a mounted harness works too, with the page's
 * own harness credential (`panel.ts` answers).
 */
import type { SettingsPatch, StatusView } from '../core.js';

export type { SettingsPatch, StatusView };

export interface Outcome {
  ok: boolean;
  text: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Where the harness is mounted: the prefix its plugin scripts load from (`…/plugins/??…`), so a
 * page under a client-side route or behind a prefix proxy still reaches `/api`.
 */
export function harnessBase(doc: Pick<Document, 'scripts' | 'baseURI'> = document): string {
  for (const script of Array.from(doc.scripts)) {
    const at = script.src.indexOf('plugins/??');
    if (at > 0) return script.src.slice(0, at);
  }
  return new URL('/', doc.baseURI).href;
}

export class PanelApi {
  constructor(
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly base: () => string = () => harnessBase(),
  ) {}

  private async call<T>(endpoint: string, payload: unknown = {}): Promise<T> {
    const response = await this.fetcher(`${this.base()}api/corehub/${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = (await response.json()) as
      { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
    if (!result.ok) throw new Error(result.error.message || result.error.code);
    return result.value as T;
  }

  state(): Promise<StatusView> {
    return this.call<StatusView>('state');
  }

  link(pairing: string): Promise<{ outcome: Outcome; state: StatusView }> {
    return this.call('link', { pairing });
  }

  unlink(): Promise<{ outcome: Outcome; state: StatusView }> {
    return this.call('unlink');
  }

  models(): Promise<{ outcome: Outcome; state: StatusView }> {
    return this.call('models');
  }

  settings(patch: SettingsPatch): Promise<{ state: StatusView }> {
    return this.call('settings', { patch });
  }

  pickFolder(): Promise<{ path: string | null }> {
    return this.call('pick-folder');
  }
}
