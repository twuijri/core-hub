#!/usr/bin/env node
// One version for every Core Hub deliverable (owner, 2026-09-26): the root package.json
// `version`. The hub, the web client, the desktop app, the Android `versionName` and the iOS
// `MARKETING_VERSION` all carry it (docs/RELEASING.md).
//
//   node scripts/version-check.mjs           fail when a copy differs from the root version
//   node scripts/version-check.mjs --write   write the root version into every copy
//   node scripts/version-check.mjs --tag v1.2.3   also check a release tag against it
//
// On GitHub a run on a `v*` tag (GITHUB_REF=refs/tags/v…) checks that tag without `--tag`.
// The copies: every workspace package.json, the iOS MARKETING_VERSION (XcodeGen cannot read
// JSON) and the Dockerfile's default COREHUB_VERSION. Android's versionName must be read from
// the root package.json by Gradle; a written-out one fails.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain X.Y.Z: the App Store's CFBundleShortVersionString takes nothing else. A preview adds its
// suffix at build time (release.yml), never in package.json.
const RELEASE = /^\d+\.\d+\.\d+$/;

export const IOS_PROJECT = 'apps/ios/project.yml';
export const ANDROID_GRADLE = 'apps/android/app/build.gradle.kts';
export const DOCKERFILE = 'packages/server/Dockerfile';

const read = (root, file) => readFileSync(path.join(root, file), 'utf8');

/** The workspace's package.json files (pnpm-workspace.yaml `packages:` globs of the form `dir/*`). */
export function workspacePackages(root) {
  const yaml = read(root, 'pnpm-workspace.yaml');
  const block = yaml.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const globs = [...block.matchAll(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  const files = [];
  for (const glob of globs) {
    const dirs = glob.endsWith('/*')
      ? readdirSync(path.join(root, glob.slice(0, -2)), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${glob.slice(0, -2)}/${d.name}`)
      : [glob];
    for (const dir of dirs) {
      const file = `${dir}/package.json`;
      if (existsSync(path.join(root, file))) files.push(file);
    }
  }
  return files.sort();
}

export function rootVersion(root) {
  return JSON.parse(read(root, 'package.json')).version;
}

/** The tag being built on GitHub, or undefined. */
export function tagFromEnv(env = process.env) {
  const ref = env.GITHUB_REF ?? '';
  return ref.startsWith('refs/tags/v') ? ref.slice('refs/tags/'.length) : undefined;
}

/** Every place that carries the version, as { where, found } (found = null when missing). */
export function copies(root) {
  const out = workspacePackages(root).map((file) => ({
    where: file,
    found: JSON.parse(read(root, file)).version ?? null,
  }));

  const ios = read(root, IOS_PROJECT);
  const marketing = [...ios.matchAll(/^\s*MARKETING_VERSION:\s*['"]?([^'"\s#]+)['"]?/gm)];
  if (marketing.length === 0) out.push({ where: `${IOS_PROJECT} MARKETING_VERSION`, found: null });
  for (const m of marketing) out.push({ where: `${IOS_PROJECT} MARKETING_VERSION`, found: m[1] });

  const docker = read(root, DOCKERFILE).match(/^ARG COREHUB_VERSION=(\S*)[ \t]*$/m);
  out.push({ where: `${DOCKERFILE} ARG COREHUB_VERSION`, found: docker ? docker[1] : null });

  // Android reads the root package.json itself (`versionName = rootVersion`); anything else,
  // even a written-out copy of the right number, is a second place to forget.
  const gradle = read(root, ANDROID_GRADLE);
  const derived =
    /^\s*versionName\s*=\s*rootVersion\s*$/m.test(gradle) &&
    /File\(repoRoot,\s*"package\.json"\)/.test(gradle);
  if (!derived) {
    const literal = gradle.match(/^\s*versionName\s*=\s*(.+)$/m)?.[1]?.trim();
    out.push({
      where: `${ANDROID_GRADLE} versionName (must be read from the root package.json)`,
      found: literal ?? null,
      derived: false,
    });
  }
  return out;
}

/** The problems, one line each; empty when everything carries the root version. */
export function check(root, { tag } = {}) {
  const version = rootVersion(root);
  const problems = [];
  if (typeof version !== 'string' || !RELEASE.test(version)) {
    problems.push(`package.json: version "${version}" is not a plain X.Y.Z version`);
  }
  for (const { where, found, derived } of copies(root)) {
    if (found !== version || derived === false)
      problems.push(`${where}: ${found ?? 'missing'} (root is ${version})`);
  }
  if (tag !== undefined && tag.replace(/^v/, '') !== version) {
    problems.push(`tag ${tag}: does not match the root version ${version}`);
  }
  return problems;
}

/**
 * Writes the root version into the workspace package.json files, the iOS MARKETING_VERSION and
 * the Dockerfile default. Returns the files changed. (Android reads the root itself.)
 */
export function write(root) {
  const version = rootVersion(root);
  const changed = [];
  const update = (file, next) => {
    if (read(root, file) !== next) {
      writeFileSync(path.join(root, file), next);
      changed.push(file);
    }
  };
  for (const file of workspacePackages(root)) {
    const text = read(root, file);
    update(file, text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`));
  }
  update(
    IOS_PROJECT,
    read(root, IOS_PROJECT).replace(/^([ \t]*MARKETING_VERSION:[ \t]*).*$/gm, `$1${version}`),
  );
  update(
    DOCKERFILE,
    read(root, DOCKERFILE).replace(
      /^ARG COREHUB_VERSION=\S*[ \t]*$/m,
      `ARG COREHUB_VERSION=${version}`,
    ),
  );
  return changed;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tagIndex = argv.indexOf('--tag');
  const tag = tagIndex >= 0 ? argv[tagIndex + 1] : tagFromEnv();
  if (argv.includes('--write')) {
    const changed = write(root);
    console.log(
      changed.length === 0
        ? `version: every copy already says ${rootVersion(root)}`
        : `version: wrote ${rootVersion(root)} into\n  ${changed.join('\n  ')}`,
    );
  }
  const problems = check(root, { tag });
  if (problems.length > 0) {
    console.error(
      `version: these differ from the root package.json version (docs/RELEASING.md):\n  ${problems.join('\n  ')}`,
    );
    console.error('Bump the root package.json only, then run `pnpm version:check --write`.');
    process.exit(1);
  }
  console.log(
    `version: ${rootVersion(root)} everywhere (${copies(root).length} places${tag ? `, tag ${tag}` : ''})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
