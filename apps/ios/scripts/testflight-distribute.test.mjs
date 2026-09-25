// pnpm scripts:test — the TestFlight group step against a fake App Store Connect API.
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createClient, distribute, makeToken, parseGroups } from './testflight-distribute.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_ID = 'TESTKEY123';
const ISSUER = '00000000-0000-0000-0000-000000000000';

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
function verifyToken(jwt) {
  const [head, body, sig] = jwt.split('.');
  return verify(
    'sha256',
    Buffer.from(`${head}.${body}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url'),
  );
}

describe('makeToken', () => {
  it('is an ES256 JWT for App Store Connect that the key verifies', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    const jwt = makeToken({ keyId: KEY_ID, issuer: ISSUER, privateKey: pem, now });
    const parts = jwt.split('.');
    assert.equal(parts.length, 3);
    assert.deepEqual(decode(parts[0]), { alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
    const claims = decode(parts[1]);
    assert.equal(claims.iss, ISSUER);
    assert.equal(claims.aud, 'appstoreconnect-v1');
    assert.equal(claims.iat, now / 1000);
    assert.ok(claims.exp - claims.iat <= 20 * 60, 'Apple refuses tokens longer than 20 minutes');
    assert.equal(Buffer.from(parts[2], 'base64url').length, 64, 'raw r||s, not DER');
    assert.ok(verifyToken(jwt));
  });
});

describe('parseGroups', () => {
  it('splits, trims and drops empties and repeats', () => {
    assert.deepEqual(parseGroups(' Owner, Friends ,,Owner'), ['Owner', 'Friends']);
    assert.deepEqual(parseGroups(''), []);
    assert.deepEqual(parseGroups(undefined), []);
  });
});

// The fake App Store Connect: one app, its groups, and a build whose state each test scripts.
const fake = {
  requests: [],
  builds: [], // one entry per poll: { processingState, internalBuildState } | null | { status }
  groups: [],
  apps: [],
};
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const auth = req.headers.authorization ?? '';
      fake.requests.push({ method: req.method, url, auth, body: raw ? JSON.parse(raw) : null });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      if (!auth.startsWith('Bearer ') || !verifyToken(auth.slice(7))) {
        return send(401, { errors: [{ code: 'NOT_AUTHORIZED', title: 'bad token', detail: '' }] });
      }
      if (req.method === 'GET' && url.pathname === '/v1/apps') {
        return send(200, { data: fake.apps });
      }
      if (req.method === 'GET' && url.pathname === '/v1/builds') {
        const step = fake.builds.length > 1 ? fake.builds.shift() : fake.builds[0];
        if (step?.status) {
          return send(step.status, { errors: [{ code: 'X', title: 'x', detail: '' }] });
        }
        if (!step) return send(200, { data: [] });
        return send(200, {
          data: [
            {
              type: 'builds',
              id: 'build-1',
              attributes: { version: '142', processingState: step.processingState },
              relationships: {
                buildBetaDetail: { data: { type: 'buildBetaDetails', id: 'bbd-1' } },
              },
            },
          ],
          included: [
            {
              type: 'buildBetaDetails',
              id: 'bbd-1',
              attributes: { internalBuildState: step.internalBuildState ?? 'PROCESSING' },
            },
          ],
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/apps/app-1/betaGroups') {
        return send(200, { data: fake.groups });
      }
      if (req.method === 'POST' && url.pathname === '/v1/builds/build-1/relationships/betaGroups') {
        return send(204);
      }
      return send(404, { errors: [{ code: 'NOT_FOUND', title: 'no route', detail: req.url }] });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  fake.requests = [];
  fake.apps = [{ type: 'apps', id: 'app-1', attributes: { bundleId: 'com.twuijri.corehub' } }];
  fake.groups = [
    { type: 'betaGroups', id: 'g-owner', attributes: { name: 'Owner', isInternalGroup: true } },
    {
      type: 'betaGroups',
      id: 'g-friends',
      attributes: { name: 'Friends', isInternalGroup: false },
    },
  ];
  fake.builds = [null];
});

function run(overrides = {}) {
  let now = 0;
  const lines = [];
  const log = {};
  for (const level of ['info', 'notice', 'warning', 'error', 'summary']) {
    log[level] = (m) => lines.push({ level, m });
  }
  const api = createClient({
    base,
    keyId: KEY_ID,
    issuer: ISSUER,
    privateKey: pem,
    clock: () => now,
  });
  return distribute({
    api,
    bundleId: 'com.twuijri.corehub',
    buildNumber: '142',
    version: '1.1.1',
    groups: 'Owner',
    timeoutMs: 30 * 60_000,
    intervalMs: 30_000,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log,
    ...overrides,
  }).then((code) => ({ code, lines, minutes: now / 60_000 }));
}

const posts = () => fake.requests.filter((r) => r.method === 'POST');
const has = (lines, level, text) => lines.some((l) => l.level === level && l.m.includes(text));

describe('distribute', () => {
  it('finds the app, waits for processing, and adds the build to the group', async () => {
    fake.builds = [
      null,
      { processingState: 'PROCESSING' },
      { processingState: 'VALID', internalBuildState: 'READY_FOR_BETA_TESTING' },
    ];
    const { code, lines } = await run();
    assert.equal(code, 0);

    const appQuery = fake.requests.find((r) => r.url.pathname === '/v1/apps');
    assert.equal(appQuery.url.searchParams.get('filter[bundleId]'), 'com.twuijri.corehub');

    const buildQueries = fake.requests.filter((r) => r.url.pathname === '/v1/builds');
    assert.equal(buildQueries.length, 3);
    const params = buildQueries[0].url.searchParams;
    assert.equal(params.get('filter[app]'), 'app-1');
    assert.equal(params.get('filter[version]'), '142');
    assert.equal(params.get('filter[preReleaseVersion.version]'), '1.1.1');

    assert.equal(posts().length, 1);
    assert.equal(posts()[0].url.pathname, '/v1/builds/build-1/relationships/betaGroups');
    assert.deepEqual(posts()[0].body, { data: [{ type: 'betaGroups', id: 'g-owner' }] });
    assert.ok(has(lines, 'notice', 'Added build 142 (1.1.1) to TestFlight group "Owner"'));
    assert.ok(!lines.some((l) => l.level === 'warning' || l.level === 'error'));
  });

  it('never prints the token', async () => {
    fake.builds = [{ processingState: 'VALID', internalBuildState: 'READY_FOR_BETA_TESTING' }];
    const { lines } = await run();
    const tokens = new Set(fake.requests.map((r) => r.auth.slice(7)));
    for (const l of lines) for (const t of tokens) assert.ok(!l.m.includes(t));
    assert.ok(!lines.some((l) => l.m.includes('eyJ')));
  });

  it('adds to several groups in one call and says external groups need Beta App Review', async () => {
    fake.builds = [{ processingState: 'VALID', internalBuildState: 'READY_FOR_BETA_TESTING' }];
    const { code, lines } = await run({ groups: 'owner, Friends' });
    assert.equal(code, 0);
    assert.deepEqual(posts()[0].body, {
      data: [
        { type: 'betaGroups', id: 'g-owner' },
        { type: 'betaGroups', id: 'g-friends' },
      ],
    });
    assert.ok(has(lines, 'notice', '"Friends" is an external group'));
    assert.ok(!has(lines, 'notice', '"Owner" is an external group'));
  });

  it('gives up after the timeout with a warning, not a failure, and adds nothing', async () => {
    fake.builds = [{ processingState: 'PROCESSING' }];
    const { code, lines, minutes } = await run();
    assert.equal(code, 0);
    assert.ok(minutes <= 30);
    assert.ok(
      has(lines, 'warning', 'had not finished processing build 142 (1.1.1) after 30 minutes'),
    );
    assert.ok(has(lines, 'warning', 'Add it by hand'));
    assert.equal(posts().length, 0);
    assert.equal(fake.requests.filter((r) => r.url.pathname.endsWith('/betaGroups')).length, 0);
  });

  it('keeps polling through a 5xx or a rate limit', async () => {
    fake.builds = [
      { status: 503 },
      { status: 429 },
      { processingState: 'VALID', internalBuildState: 'READY_FOR_BETA_TESTING' },
    ];
    const { code } = await run();
    assert.equal(code, 0);
    assert.equal(posts().length, 1);
  });

  it('fails when Apple rejects the build', async () => {
    fake.builds = [{ processingState: 'INVALID' }];
    const { code, lines } = await run();
    assert.equal(code, 1);
    assert.ok(has(lines, 'error', 'processingState INVALID'));
    assert.equal(posts().length, 0);
  });

  it('reports missing export compliance and still adds the build', async () => {
    fake.builds = [{ processingState: 'VALID', internalBuildState: 'MISSING_EXPORT_COMPLIANCE' }];
    const { code, lines } = await run();
    assert.equal(code, 0);
    assert.ok(has(lines, 'warning', 'missing export compliance'));
    assert.equal(posts().length, 1);
  });

  it('fails on an unknown group, naming the ones that exist, after adding the known ones', async () => {
    fake.builds = [{ processingState: 'VALID', internalBuildState: 'READY_FOR_BETA_TESTING' }];
    const { code, lines } = await run({ groups: 'Owner,Nobody' });
    assert.equal(code, 1);
    assert.deepEqual(posts()[0].body, { data: [{ type: 'betaGroups', id: 'g-owner' }] });
    assert.ok(has(lines, 'error', 'No TestFlight group named "Nobody"'));
    assert.ok(has(lines, 'error', '"Owner", "Friends"'));
  });

  it('fails when the app is not in App Store Connect', async () => {
    fake.apps = [];
    const { code, lines } = await run();
    assert.equal(code, 1);
    assert.ok(has(lines, 'error', 'No app with bundle id com.twuijri.corehub'));
    assert.equal(fake.requests.filter((r) => r.url.pathname === '/v1/builds').length, 0);
  });

  it('does nothing without groups', async () => {
    const { code } = await run({ groups: ' , ' });
    assert.equal(code, 0);
    assert.equal(fake.requests.length, 0);
  });

  it('remakes the token while waiting longer than one token lives', async () => {
    fake.builds = [
      ...Array.from({ length: 40 }, () => ({ processingState: 'PROCESSING' })),
      { processingState: 'VALID', internalBuildState: 'READY_FOR_BETA_TESTING' },
    ];
    const { code } = await run();
    assert.equal(code, 0);
    const tokens = new Set(fake.requests.map((r) => r.auth));
    assert.ok(tokens.size >= 2, `expected a fresh token, saw ${tokens.size}`);
  });
});
