// Types for release-assets.mjs, for the unit tests.
export interface ReleaseAsset {
  key: string;
  label: string;
  /** The file's name on the GitHub release. */
  name: string;
  /** The file's name in the workflow artifact it comes from. */
  source: string;
}

export interface UpdateAsset extends ReleaseAsset {
  /** A blockmap: left out without harm when the build made none. */
  optional?: boolean;
  /** An update feed: the platform it serves and the installer it must name. */
  feed?: { platform: 'windows' | 'macos' | 'linux'; installer: string };
}

export function msixVersion(version: string): string;
export function updateAssets(version: string): UpdateAsset[];
export function readFeed(text: string): {
  version: string | null;
  path: string | null;
  urls: string[];
};
export function feedProblems(options: {
  version: string;
  feeds: Record<string, string | null>;
  published: string[];
  platforms?: string[];
}): string[];
export function checkFeedsIn(options: {
  version: string;
  dir: string;
  platforms?: string[];
}): string[];
export function releaseAssets(version: string): ReleaseAsset[];
export function collect(options: {
  version: string;
  from: string;
  to: string;
  /**
   * Keys of files this release does not carry: `windows-msix` for a tag before the MSIX,
   * `updates` for a tag before the self-updating apps (1.1.3).
   */
  without?: string[];
}): string[];
export function releaseNotes(options: {
  tag: string;
  generated: string;
  repository: string;
  without?: string[];
}): string;
