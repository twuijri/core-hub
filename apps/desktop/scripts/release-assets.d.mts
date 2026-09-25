// Types for release-assets.mjs, for the unit tests.
export interface ReleaseAsset {
  key: string;
  label: string;
  /** The file's name on the GitHub release. */
  name: string;
  /** The file's name in the workflow artifact it comes from. */
  source: string;
}

export function msixVersion(version: string): string;
export function releaseAssets(version: string): ReleaseAsset[];
export function collect(options: { version: string; from: string; to: string }): string[];
export function releaseNotes(options: {
  tag: string;
  generated: string;
  repository: string;
}): string;
