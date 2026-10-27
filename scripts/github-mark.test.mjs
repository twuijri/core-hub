// GitHub's mark is drawn on three clients from one path: the web's GitHubMark.tsx. The phones
// carry it as an asset (an iOS template SVG, an Android vector drawable), so this keeps the copies
// identical to the web's — a mark changed in one place and not the others fails here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8');

const web = /GITHUB_MARK_PATH =\s*'([^']+)'/.exec(
  read('packages/web/src/ui/brand/GitHubMark.tsx'),
)?.[1];

test('the phones draw the same GitHub mark as the web', () => {
  assert.ok(web, 'GitHubMark.tsx exports GITHUB_MARK_PATH');
  const ios = read(
    'apps/ios/CoreHub/Resources/Assets.xcassets/GitHubMark.imageset/github-mark.svg',
  );
  assert.equal(/<path d="([^"]+)"/.exec(ios)?.[1], web);
  const android = read('apps/android/app/src/main/res/drawable/github_mark.xml');
  assert.equal(/android:pathData="([^"]+)"/.exec(android)?.[1], web);
});
