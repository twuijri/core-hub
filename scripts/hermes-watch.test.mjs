// pnpm scripts:test — the Hermes watch (DECISIONS §132), against the repository's own pins and
// stand-in releases.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  FILES,
  botBranch,
  bumpTexts,
  compareVersions,
  failingTests,
  findBumpPr,
  findWatchIssue,
  hermesStatus,
  issueRef,
  issueTitle,
  pickLatest,
  readPins,
  recordPath,
  recordText,
  releaseVersion,
  reportBody,
  verdict,
} from './hermes-watch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = () => ({
  dockerfile: readFileSync(path.join(ROOT, FILES.dockerfile), 'utf8'),
  versions: readFileSync(path.join(ROOT, FILES.versions), 'utf8'),
});

describe('the pins', () => {
  it('reads the floor and the tested pin, and the Dockerfile carries the tested one', () => {
    const pins = readPins(files());
    assert.match(pins.floor.ref, /^v\d{4}\.\d+\.\d+$/);
    assert.match(pins.tested.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pins.dockerfileRef, pins.tested.ref);
    assert.ok(compareVersions(pins.tested.version, pins.floor.version) >= 0);
  });

  it('moves the tested pin in both files and leaves the floor', () => {
    const next = bumpTexts(files(), { ref: 'v2026.10.2', version: '0.22.0' });
    const pins = readPins(next);
    assert.deepEqual(pins.tested, { ref: 'v2026.10.2', version: '0.22.0' });
    assert.equal(pins.dockerfileRef, 'v2026.10.2');
    assert.deepEqual(pins.floor, readPins(files()).floor);
    assert.equal(next.dockerfile.split('\n').length, files().dockerfile.split('\n').length);
  });

  it('refuses a tag or a version that could not be one', () => {
    assert.throws(() => bumpTexts(files(), { ref: 'main; rm -rf /', version: '0.22.0' }));
    assert.throws(() => bumpTexts(files(), { ref: 'v2026.10.2', version: 'latest' }));
  });
});

describe('the latest Hermes release', () => {
  const releases = [
    { tag_name: 'v2026.9.21', name: 'Hermes Agent v0.21.4 (v2026.9.21)', body: '' },
    {
      tag_name: 'v2026.10.1',
      name: 'Hermes Agent v0.22.0 (v2026.10.1)',
      body: '',
      prerelease: true,
    },
    { tag_name: 'v2026.9.24', name: 'Hermes Agent v0.21.5 (v2026.9.24)', body: '' },
    {
      tag_name: 'v2026.9.30',
      name: 'x',
      body: '# Hermes Agent v0.21.6 (v2026.9.30)\n',
      draft: true,
    },
    { tag_name: 'nightly', name: 'Nightly', body: 'no version here' },
  ];

  it('reads the version from the release name or its notes', () => {
    assert.equal(releaseVersion(releases[0]), '0.21.4');
    assert.equal(
      releaseVersion({ name: 'x', body: '# Hermes Agent v0.21.6 (v2026.9.30)' }),
      '0.21.6',
    );
    assert.equal(releaseVersion(releases[4]), null);
  });

  it('reads a version tag (v0.21.6 on) but never a date tag as a version', () => {
    assert.equal(releaseVersion({ tag_name: 'v0.21.6', name: 'Hermes Agent v0.21.6' }), '0.21.6');
    assert.equal(
      releaseVersion({ tag_name: 'v0.22.0', name: 'Something else', body: '' }),
      '0.22.0',
    );
    assert.equal(releaseVersion({ tag_name: 'v2026.9.24', name: 'x', body: '' }), null);
    assert.deepEqual(
      pickLatest([...releases, { tag_name: 'v0.21.6', name: 'Hermes Agent v0.21.6', body: '' }]),
      { ref: 'v0.21.6', version: '0.21.6' },
    );
  });

  it('takes the newest published release, never a draft or a pre-release', () => {
    assert.deepEqual(pickLatest(releases), { ref: 'v2026.9.24', version: '0.21.5' });
    assert.equal(pickLatest([]), null);
  });

  it('says newer only past the tested pin', () => {
    const tested = { ref: 'v2026.9.24', version: '0.21.5' };
    assert.equal(verdict({ ref: 'v2026.9.24', version: '0.21.5' }, tested).newer, false);
    assert.equal(verdict({ ref: 'v2026.9.30', version: '0.21.6' }, tested).newer, true);
    assert.equal(verdict({ ref: 'v2026.9.21', version: '0.21.4' }, tested).newer, false);
    assert.equal(verdict(null, tested).newer, false);
  });
});

describe('the report', () => {
  const vitest = {
    numTotalTests: 5,
    testResults: [
      {
        name: path.join(ROOT, 'packages/server/src/a.real.test.ts'),
        status: 'failed',
        assertionResults: [
          { status: 'passed', fullName: 'a works' },
          { status: 'failed', fullName: 'a keeps the key' },
        ],
      },
      {
        name: path.join(ROOT, 'packages/server/src/b.real.test.ts'),
        status: 'failed',
        message: 'Cannot find module x\n at …',
        assertionResults: [],
      },
      {
        name: path.join(ROOT, 'packages/server/src/c.real.test.ts'),
        status: 'passed',
        assertionResults: [],
      },
    ],
  };
  const pins = {
    latest: { ref: 'v2026.9.30', version: '0.21.6' },
    tested: { ref: 'v2026.9.24', version: '0.21.5' },
    floor: { ref: 'v2026.9.14', version: '0.21.3' },
    runUrl: 'https://example.invalid/run/1',
  };

  it('lists every failed test, and a file that failed before its tests ran', () => {
    assert.deepEqual(failingTests(vitest), [
      'packages/server/src/a.real.test.ts › a keeps the key',
      'packages/server/src/b.real.test.ts › (the file failed: Cannot find module x)',
    ]);
  });

  it('says what failed and that the pin stays when red', () => {
    const body = reportBody({ ...pins, failed: failingTests(vitest), total: 5 });
    assert.match(body, /\*\*2 of 5 tests failed\*\*, so the image stays on v2026\.9\.24/);
    assert.match(body, /a keeps the key/);
    assert.match(body, /example\.invalid\/run\/1/);
  });

  it('proposes the move, never merges, when green', () => {
    const body = reportBody({ ...pins, failed: [], total: 5 });
    assert.match(body, /All 5 tests passed/);
    assert.match(body, /Never merged automatically/);
  });
});

describe('the change record of the bot’s pull request', () => {
  it('has every section the change-record check asks for, and a block of what ran', () => {
    const text = recordText({
      latest: { ref: 'v2026.9.30', version: '0.21.6' },
      tested: { ref: 'v2026.9.24', version: '0.21.5' },
      floor: { ref: 'v2026.9.14', version: '0.21.3' },
      runUrl: 'https://example.invalid/run/1',
      branch: 'bot/hermes-v2026.9.30',
      total: 87,
    });
    const readme = readFileSync(path.join(ROOT, 'docs/changes/README.md'), 'utf8');
    for (const section of readme.match(/^## .+$/gm) ?? [])
      assert.ok(text.includes(section), section);
    assert.match(text, /^المسؤول: twuijri · الفرع: bot\/hermes-v2026\.9\.30 · الحالة: review$/m);
    assert.match(text.split('## الفحوص')[1], /```/);
    assert.equal(
      recordPath('2026-09-30', 'v2026.9.30'),
      'docs/changes/2026-09-30-twuijri-hermes-v2026-9-30.md',
    );
    assert.match(
      recordPath('2026-09-30', 'v2026.9.30'),
      /^docs\/changes\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/,
    );
  });
});

describe('what the watch left on GitHub, and the line a release prints', () => {
  const tested = { ref: 'v2026.9.24', version: '0.21.5' };
  const latest = { ref: 'v2026.9.30', version: '0.21.6' };

  it('names the bot branch and the issue after the tag, and reads the tag back', () => {
    assert.equal(botBranch('v2026.9.30'), 'bot/hermes-v2026.9.30');
    assert.equal(issueTitle('v2026.9.30'), 'Hermes v2026.9.30 is not supported yet');
    assert.equal(issueRef(issueTitle('v2026.9.30')), 'v2026.9.30');
    assert.equal(issueRef('Hermes watch: v2026.9.30 fails'), null);
    assert.equal(issueRef('Hermes main; rm -rf / is not supported yet'), null);
  });

  it('finds only the open pull request from this tag’s bot branch', () => {
    const pulls = [
      { number: 7, state: 'open', head: { ref: 'bot/hermes-v2026.9.28' }, html_url: 'u7' },
      { number: 8, state: 'closed', head: { ref: 'bot/hermes-v2026.9.30' }, html_url: 'u8' },
      { number: 9, state: 'open', head: { ref: 'bot/hermes-v2026.9.30' }, html_url: 'u9' },
    ];
    assert.deepEqual(findBumpPr(pulls, 'v2026.9.30'), { number: 9, url: 'u9' });
    assert.equal(findBumpPr(pulls, 'v2026.10.1'), null);
    assert.equal(findBumpPr([], 'v2026.9.30'), null);
  });

  it('finds the oldest open watch issue, never a pull request or another issue', () => {
    const issues = [
      {
        number: 12,
        state: 'open',
        title: 'Hermes v2026.9.30 is not supported yet',
        html_url: 'u12',
      },
      { number: 11, state: 'open', title: 'Something else', html_url: 'u11' },
      {
        number: 10,
        state: 'open',
        title: 'Hermes v2026.9.28 is not supported yet',
        pull_request: {},
        html_url: 'u10',
      },
      { number: 9, state: 'open', title: 'Hermes v2026.9.28 is not supported yet', html_url: 'u9' },
    ];
    assert.deepEqual(findWatchIssue(issues), { number: 9, url: 'u9', ref: 'v2026.9.28' });
    assert.equal(findWatchIssue([issues[1], issues[2]]), null);
  });

  it('a notice when the image carries the newest Hermes', () => {
    const status = hermesStatus({ latest: tested, tested, newer: false, pr: null, issue: null });
    assert.equal(status.level, 'notice');
    assert.match(status.text, /carries Hermes v2026\.9\.24 \(0\.21\.5\), the newest/);
  });

  it('a warning naming the newer release and the pull request when the watch found it supported', () => {
    const pr = { number: 230, url: 'https://example.invalid/pull/230' };
    const status = hermesStatus({ latest, tested, newer: true, pr, issue: null });
    assert.equal(status.level, 'warning');
    assert.match(status.text, /Hermes v2026\.9\.30 \(0\.21\.6\) is out/);
    assert.match(status.text, /found v2026\.9\.30 supported/);
    assert.match(status.text, /#230 moves the pin: https:\/\/example\.invalid\/pull\/230/);
  });

  it('a warning naming the issue when the watch found it not supported', () => {
    const issue = { number: 231, url: 'https://example.invalid/issues/231', ref: 'v2026.9.30' };
    const status = hermesStatus({ latest, tested, newer: true, pr: null, issue });
    assert.equal(status.level, 'warning');
    assert.match(status.text, /NOT supported yet/);
    assert.match(status.text, /issue #231/);
  });

  it('says the watch has not tried a release its issue is not about', () => {
    const issue = { number: 231, url: 'u', ref: 'v2026.9.28' };
    const status = hermesStatus({ latest, tested, newer: true, pr: null, issue });
    assert.equal(status.level, 'warning');
    assert.match(status.text, /has not tried v2026\.9\.30 yet/);
    assert.doesNotMatch(status.text, /#231/);
  });
});
