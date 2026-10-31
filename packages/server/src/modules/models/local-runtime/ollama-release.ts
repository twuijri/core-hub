/**
 * Ollama's releases as the hub reads them (ADR 0032 §2): the newest tag, the file for this
 * platform, and the SHA-256 the release publishes for it.
 *
 * Unlike a catalog agent (ADR 0018, pinned hashes moved by a pull request), the person updates
 * Ollama whenever they want, so the version is the vendor's latest. The newest tag comes from the
 * redirect of `releases/latest`, not the GitHub API, so the hub never meets its hourly limit.
 */
import { HubError } from '../../../lib/errors.js';

export const OLLAMA_REPO = 'https://github.com/ollama/ollama';

export type RuntimePlatform =
  'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64' | 'win32-arm64';

export type ArchiveFormat = 'tgz' | 'tar.zst' | 'zip';

export interface OllamaAsset {
  name: string;
  format: ArchiveFormat;
}

const ASSETS: Record<RuntimePlatform, OllamaAsset> = {
  'darwin-arm64': { name: 'ollama-darwin.tgz', format: 'tgz' },
  'darwin-x64': { name: 'ollama-darwin.tgz', format: 'tgz' },
  'linux-x64': { name: 'ollama-linux-amd64.tar.zst', format: 'tar.zst' },
  'linux-arm64': { name: 'ollama-linux-arm64.tar.zst', format: 'tar.zst' },
  'win32-x64': { name: 'ollama-windows-amd64.zip', format: 'zip' },
  'win32-arm64': { name: 'ollama-windows-arm64.zip', format: 'zip' },
};

export function runtimePlatform(platform: string, arch: string): RuntimePlatform | null {
  const key = `${platform}-${arch}`;
  return key in ASSETS ? (key as RuntimePlatform) : null;
}

export function assetFor(platform: RuntimePlatform): OllamaAsset {
  return ASSETS[platform];
}

export interface OllamaRelease {
  /** `v0.40.13`. */
  tag: string;
  /** `0.40.13`, comparable with what `/api/version` reports. */
  version: string;
}

export function versionOfTag(tag: string): string {
  return tag.replace(/^v/, '');
}

/** -1, 0 or 1; numeric parts compared in order, a missing part counting as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export async function latestOllamaRelease(
  fetchImpl: typeof fetch,
  timeoutMs = 15_000,
): Promise<OllamaRelease> {
  let response: Response;
  try {
    response = await fetchImpl(`${OLLAMA_REPO}/releases/latest`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new HubError('service_unavailable', {
      message: `could not reach ${OLLAMA_REPO}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  await response.body?.cancel().catch(() => undefined);
  const location = response.headers.get('location') ?? '';
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1];
  if (!tag) {
    throw new HubError('service_unavailable', {
      message: `${OLLAMA_REPO} did not say which release is the latest (HTTP ${response.status})`,
    });
  }
  const decoded = decodeURIComponent(tag);
  return { tag: decoded, version: versionOfTag(decoded) };
}

export function assetUrl(release: OllamaRelease, name: string): string {
  return `${OLLAMA_REPO}/releases/download/${encodeURIComponent(release.tag)}/${name}`;
}

/** The release's `sha256sum.txt`, as `{ file name → hex digest }`. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export async function releaseChecksum(
  fetchImpl: typeof fetch,
  release: OllamaRelease,
  name: string,
  timeoutMs = 15_000,
): Promise<string> {
  let text: string;
  try {
    const response = await fetchImpl(assetUrl(release, 'sha256sum.txt'), {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    throw new HubError('service_unavailable', {
      message: `could not read the checksums of Ollama ${release.tag}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const sum = parseChecksums(text).get(name);
  if (!sum) {
    throw new HubError('service_unavailable', {
      message: `Ollama ${release.tag} publishes no checksum for ${name}`,
    });
  }
  return sum;
}
