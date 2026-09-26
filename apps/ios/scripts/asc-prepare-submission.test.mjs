// pnpm scripts:test — readying an App Store version for review, against a fake App Store Connect.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  AGE_RATING,
  EXCLUDED_TERRITORIES,
  prepare,
  reviewDetailGaps,
} from './asc-prepare-submission.mjs';
import { createClient } from './testflight-distribute.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'demo-password-never-logged';

const COMPLETE_REVIEW = {
  contactFirstName: 'T',
  contactLastName: 'W',
  contactPhone: '+966500000000',
  contactEmail: 'owner@example.com',
  demoAccountRequired: true,
  demoAccountName: 'reviewer',
  demoAccountPassword: SECRET,
  notes: 'Core Hub is a client for a self-hosted server.',
};

let fake;
function reset() {
  fake = {
    requests: [],
    app: {
      type: 'apps',
      id: 'app-1',
      attributes: { bundleId: 'com.twuijri.corehub', contentRightsDeclaration: null },
    },
    version: {
      type: 'appStoreVersions',
      id: 'ver-1',
      attributes: {
        versionString: '1.1.1',
        appVersionState: 'PREPARE_FOR_SUBMISSION',
        releaseType: 'AFTER_APPROVAL',
        copyright: '2026 twuijri',
      },
    },
    attached: null,
    builds: [
      build('b-109', '109', 'VALID', '2026-09-20T00:00:00Z'),
      build('b-110', '110', 'VALID', '2026-09-26T00:00:00Z'),
      build('b-111', '111', 'PROCESSING', '2026-09-26T05:00:00Z'),
    ],
    age: { type: 'ageRatingDeclarations', id: 'ard-1', attributes: {} },
    ageUnknown: [], // attributes the fake App Store Connect does not know
    ageLegacyOnly: false, // refuses INFREQUENT, takes INFREQUENT_OR_MILD
    category: { type: 'appCategories', id: 'PRODUCTIVITY' },
    locs: [
      { attributes: { locale: 'en-US', privacyPolicyUrl: 'https://example.com/p' } },
      { attributes: { locale: 'ar-SA', privacyPolicyUrl: 'https://example.com/p.ar' } },
    ],
    manualPrices: null, // null = no price schedule
    availability: null,
    territories: ['USA', 'SAU', 'CHN', 'GBR'],
    review: { type: 'appStoreReviewDetails', id: 'rd-1', attributes: {} },
    submissions: [],
    items: [],
  };
}

function build(id, version, processingState, uploadedDate) {
  return {
    type: 'builds',
    id,
    attributes: { version, processingState, uploadedDate },
    internalBuildState: 'IN_BETA_TESTING',
  };
}

let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const body = raw ? JSON.parse(raw) : null;
      const p = url.pathname;
      fake.requests.push({ method: req.method, path: p, url, body });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      const notFound = () =>
        send(404, { errors: [{ code: 'NOT_FOUND', title: 'none', detail: p }] });
      const route = `${req.method} ${p}`;
      switch (route) {
        case 'GET /v1/apps':
          return send(200, { data: [fake.app] });
        case 'PATCH /v1/apps/app-1':
          Object.assign(fake.app.attributes, body.data.attributes);
          return send(200, { data: fake.app });
        case 'GET /v1/apps/app-1/appStoreVersions':
          return send(200, { data: [fake.version] });
        case 'PATCH /v1/appStoreVersions/ver-1':
          Object.assign(fake.version.attributes, body.data.attributes);
          return send(200, { data: fake.version });
        case 'GET /v1/builds': {
          const number = url.searchParams.get('filter[version]');
          let list = fake.builds;
          if (number) list = list.filter((b) => b.attributes.version === number);
          if (url.searchParams.get('filter[processingState]')) {
            list = list.filter(
              (b) =>
                b.attributes.processingState === url.searchParams.get('filter[processingState]'),
            );
          }
          if (url.searchParams.get('sort') === '-uploadedDate') {
            list = [...list].sort((a, b) =>
              b.attributes.uploadedDate.localeCompare(a.attributes.uploadedDate),
            );
          }
          const first = list[0];
          return send(200, {
            data: first ? [{ type: 'builds', id: first.id, attributes: first.attributes }] : [],
            included: first
              ? [
                  {
                    type: 'buildBetaDetails',
                    id: `bbd-${first.id}`,
                    attributes: { internalBuildState: first.internalBuildState },
                  },
                ]
              : [],
          });
        }
        case 'GET /v1/appStoreVersions/ver-1/build':
          return send(200, { data: fake.attached ? { type: 'builds', id: fake.attached } : null });
        case 'PATCH /v1/appStoreVersions/ver-1/relationships/build':
          fake.attached = body.data.id;
          return send(204);
        case 'GET /v1/apps/app-1/appInfos':
          return send(200, {
            data: [
              {
                type: 'appInfos',
                id: 'info-live',
                attributes: { state: 'READY_FOR_DISTRIBUTION' },
              },
              { type: 'appInfos', id: 'info-1', attributes: { state: 'PREPARE_FOR_SUBMISSION' } },
            ],
          });
        case 'GET /v1/appInfos/info-1/ageRatingDeclaration':
          return send(200, { data: fake.age });
        case 'PATCH /v1/ageRatingDeclarations/ard-1': {
          const attrs = body.data.attributes;
          const errors = [];
          for (const key of Object.keys(attrs)) {
            if (fake.ageUnknown.includes(key)) {
              errors.push({
                code: 'ENTITY_ERROR.ATTRIBUTE.UNKNOWN',
                title: 'unknown',
                detail: key,
                source: { pointer: `/data/attributes/${key}` },
              });
            } else if (fake.ageLegacyOnly && attrs[key] === 'INFREQUENT') {
              errors.push({
                code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
                title: 'invalid',
                detail: key,
                source: { pointer: `/data/attributes/${key}` },
              });
            }
          }
          if (errors.length) return send(409, { errors });
          Object.assign(fake.age.attributes, attrs);
          return send(200, { data: fake.age });
        }
        case 'GET /v1/appInfos/info-1/primaryCategory':
          return send(200, { data: fake.category });
        case 'GET /v1/appInfos/info-1/appInfoLocalizations':
          return send(200, { data: fake.locs });
        case 'GET /v1/apps/app-1/appPriceSchedule':
          return fake.manualPrices
            ? send(200, { data: { type: 'appPriceSchedules', id: 'app-1' } })
            : notFound();
        case 'GET /v1/appPriceSchedules/app-1/manualPrices':
          return send(200, {
            data: fake.manualPrices.map((_, i) => ({ type: 'appPrices', id: `ap-${i}` })),
            included: fake.manualPrices.map((price, i) => ({
              type: 'appPricePoints',
              id: `pp-${i}`,
              attributes: { customerPrice: price },
            })),
          });
        case 'GET /v1/apps/app-1/appPricePoints':
          return send(200, {
            data: [
              { type: 'appPricePoints', id: 'pp-free', attributes: { customerPrice: '0.0' } },
              { type: 'appPricePoints', id: 'pp-099', attributes: { customerPrice: '0.99' } },
            ],
          });
        case 'POST /v1/appPriceSchedules':
          fake.manualPrices = ['0.0'];
          return send(201, { data: { type: 'appPriceSchedules', id: 'app-1' } });
        case 'GET /v1/apps/app-1/appAvailabilityV2':
          return fake.availability ? send(200, { data: fake.availability }) : notFound();
        case 'GET /v1/territories':
          return send(200, { data: fake.territories.map((id) => ({ type: 'territories', id })) });
        case 'POST /v2/appAvailabilities':
          fake.availability = { type: 'appAvailabilities', id: 'app-1' };
          return send(201, { data: fake.availability });
        case 'GET /v1/appStoreVersions/ver-1/appStoreReviewDetail':
          return fake.review ? send(200, { data: fake.review }) : notFound();
        case 'GET /v1/reviewSubmissions':
          return send(200, { data: fake.submissions });
        case 'POST /v1/reviewSubmissions': {
          const s = {
            type: 'reviewSubmissions',
            id: 'rs-1',
            attributes: { state: 'READY_FOR_REVIEW' },
          };
          fake.submissions.push(s);
          return send(201, { data: s });
        }
        case 'GET /v1/reviewSubmissions/rs-1/items':
          return send(200, { data: fake.items });
        case 'POST /v1/reviewSubmissionItems': {
          const item = {
            type: 'reviewSubmissionItems',
            id: 'rsi-1',
            relationships: body.data.relationships,
          };
          fake.items.push(item);
          return send(201, { data: item });
        }
        case 'PATCH /v1/reviewSubmissions/rs-1':
          if (body.data.attributes.submitted)
            fake.submissions[0].attributes.state = 'WAITING_FOR_REVIEW';
          return send(200, { data: fake.submissions[0] });
        default:
          return notFound();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
beforeEach(reset);

async function run({ buildNumber = '110', submit = false } = {}) {
  const lines = [];
  const log = {};
  for (const level of ['info', 'notice', 'warning', 'error', 'summary']) {
    log[level] = (m) => lines.push({ level, m });
  }
  const opts = { keyId: 'K', issuer: 'I', privateKey: pem };
  const code = await prepare({
    api: createClient({ ...opts, base: `${base}/v1` }),
    apiV2: createClient({ ...opts, base: `${base}/v2` }),
    bundleId: 'com.twuijri.corehub',
    version: '1.1.1',
    buildNumber,
    submit,
    log,
  });
  const text = lines.map((l) => l.m).join('\n');
  const missing = text.includes('Still missing before submission:')
    ? text
        .split('Still missing before submission:')[1]
        .split('\n')
        .filter((l) => /^ {2}\d+\. /.test(l))
        .map((l) => l.replace(/^ {2}\d+\. /, ''))
    : [];
  return { code, lines, text, missing };
}

const sent = (method, path) => fake.requests.filter((r) => r.method === method && r.path === path);

describe('asc-prepare-submission', () => {
  it('attaches the given build, sets manual release and content rights, and never submits', async () => {
    const { code, text } = await run();
    assert.equal(code, 0);
    assert.equal(fake.attached, 'b-110');
    assert.deepEqual(sent('PATCH', '/v1/appStoreVersions/ver-1/relationships/build')[0].body, {
      data: { type: 'builds', id: 'b-110' },
    });
    assert.equal(fake.version.attributes.releaseType, 'MANUAL');
    assert.equal(fake.app.attributes.contentRightsDeclaration, 'DOES_NOT_USE_THIRD_PARTY_CONTENT');
    assert.match(text, /applied {2}Attached build 110 to 1\.1\.1\./);
    assert.equal(sent('POST', '/v1/reviewSubmissions').length, 0);
    assert.equal(sent('PATCH', '/v1/reviewSubmissions/rs-1').length, 0);
  });

  it('picks the newest VALID build of the version when no number is given', async () => {
    const { code } = await run({ buildNumber: '' });
    assert.equal(code, 0);
    assert.equal(fake.attached, 'b-110', 'not 109 (older) nor 111 (still processing)');
  });

  it('does not attach a build that is not VALID, and lists it', async () => {
    const { missing } = await run({ buildNumber: '111' });
    assert.equal(fake.attached, null);
    assert.ok(
      missing.some((m) => /build 111 \(1\.1\.1\) is PROCESSING/.test(m)),
      missing.join('\n'),
    );
  });

  it('leaves an attached build, release type and content rights alone', async () => {
    fake.attached = 'b-110';
    fake.version.attributes.releaseType = 'MANUAL';
    fake.app.attributes.contentRightsDeclaration = 'USES_THIRD_PARTY_CONTENT';
    await run();
    assert.equal(sent('PATCH', '/v1/appStoreVersions/ver-1/relationships/build').length, 0);
    assert.equal(sent('PATCH', '/v1/appStoreVersions/ver-1').length, 0);
    assert.equal(sent('PATCH', '/v1/apps/app-1').length, 0);
  });

  it('answers the age rating questionnaire of the editable App Information', async () => {
    const { code, text } = await run();
    assert.equal(code, 0);
    assert.deepEqual(fake.age.attributes, { ...AGE_RATING });
    assert.equal(fake.age.attributes.messagingAndChat, true);
    assert.equal(fake.age.attributes.profanityOrCrudeHumor, 'INFREQUENT');
    assert.match(text, /Age rating: answered 23 questions/);
    // A second run changes nothing.
    fake.requests = [];
    await run();
    assert.equal(sent('PATCH', '/v1/ageRatingDeclarations/ard-1').length, 0);
  });

  it('falls back to the older frequency names and lists questions App Store Connect does not know', async () => {
    fake.ageLegacyOnly = true;
    fake.ageUnknown = ['socialMedia'];
    const { code, missing } = await run();
    assert.equal(code, 0);
    assert.equal(fake.age.attributes.profanityOrCrudeHumor, 'INFREQUENT_OR_MILD');
    assert.equal(fake.age.attributes.medicalOrTreatmentInformation, 'INFREQUENT_OR_MILD');
    assert.equal(fake.age.attributes.socialMedia, undefined);
    assert.ok(missing.some((m) => m.startsWith('Age rating') && m.includes('socialMedia')));
  });

  it('makes the app free and available everywhere but the excluded territories when unset', async () => {
    const { text } = await run();
    const price = sent('POST', '/v1/appPriceSchedules')[0].body;
    assert.equal(price.data.relationships.baseTerritory.data.id, 'USA');
    assert.equal(price.data.relationships.app.data.id, 'app-1');
    assert.equal(price.included[0].relationships.appPricePoint.data.id, 'pp-free');
    assert.equal(price.included[0].id, price.data.relationships.manualPrices.data[0].id);

    const avail = sent('POST', '/v2/appAvailabilities')[0].body;
    assert.equal(avail.data.attributes.availableInNewTerritories, true);
    const territories = avail.included.map((t) => t.relationships.territory.data.id);
    assert.deepEqual(territories, ['USA', 'SAU', 'GBR']);
    for (const id of EXCLUDED_TERRITORIES) assert.ok(!territories.includes(id));
    assert.ok(avail.included.every((t) => t.attributes.available === true));
    assert.match(text, /Price: free \(0\.00, base territory USA\)/);
  });

  it('leaves a price and availability that are already set', async () => {
    fake.manualPrices = ['0.0'];
    fake.availability = { type: 'appAvailabilities', id: 'app-1' };
    const { text } = await run();
    assert.equal(sent('POST', '/v1/appPriceSchedules').length, 0);
    assert.equal(sent('POST', '/v2/appAvailabilities').length, 0);
    assert.match(text, /ok {7}Price: free\./);

    fake.requests = [];
    fake.manualPrices = ['4.99'];
    const paid = await run();
    assert.equal(sent('POST', '/v1/appPriceSchedules').length, 0);
    assert.ok(paid.lines.some((l) => l.level === 'warning' && /not free/.test(l.m)));
  });

  it('reports what only the owner can enter, without printing the demo password', async () => {
    fake.category = null;
    fake.version.attributes.copyright = '';
    fake.locs[1].attributes.privacyPolicyUrl = null;
    fake.review.attributes = { contactFirstName: 'T', demoAccountPassword: SECRET };
    const { code, missing, text, lines } = await run();
    assert.equal(code, 0, 'the report alone is not a failure');
    assert.deepEqual(missing, [
      'Copyright of the version (App Store tab → the version → Copyright: "2026 twuijri").',
      'Primary category (App Information → Category: Productivity).',
      'Privacy policy URL for ar-SA (App Information).',
      'App Review Information → Contact: last name, phone, email.',
      'App Review Information → tick "Sign-in required" (the app only works signed in to a hub).',
      "App Review Information → Sign-in required: the demo account's user name.",
      'App Review Information → Notes: paste docs/store/apple/review-notes.md with the demo hub address.',
    ]);
    assert.match(text, /App Privacy .* never checked here/);
    assert.ok(!lines.some((l) => l.m.includes(SECRET)));
  });

  it('lists nothing when everything the API can see is complete', () => {
    assert.deepEqual(reviewDetailGaps({ attributes: COMPLETE_REVIEW }), []);
    assert.equal(reviewDetailGaps(null).length, 4);
  });

  it('--submit refuses while App Review Information is incomplete', async () => {
    fake.review.attributes = { ...COMPLETE_REVIEW, demoAccountName: '', demoAccountPassword: '' };
    const { code, lines } = await run({ submit: true });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.level === 'error' && /Not submitted: 1 item/.test(l.m)));
    assert.equal(sent('POST', '/v1/reviewSubmissions').length, 0);
    assert.equal(sent('POST', '/v1/reviewSubmissionItems').length, 0);
    assert.equal(sent('PATCH', '/v1/reviewSubmissions/rs-1').length, 0);
    assert.equal(sent('PATCH', '/v1/appStoreReviewDetails/rd-1').length, 0, 'never fills it in');
  });

  it('--submit adds the version to a review submission and submits it when complete', async () => {
    fake.review.attributes = { ...COMPLETE_REVIEW };
    const { code } = await run({ submit: true });
    assert.equal(code, 0);
    assert.equal(sent('POST', '/v1/reviewSubmissions')[0].body.data.attributes.platform, 'IOS');
    assert.equal(
      sent('POST', '/v1/reviewSubmissionItems')[0].body.data.relationships.appStoreVersion.data.id,
      'ver-1',
    );
    assert.deepEqual(sent('PATCH', '/v1/reviewSubmissions/rs-1')[0].body.data.attributes, {
      submitted: true,
    });
    assert.equal(fake.submissions[0].attributes.state, 'WAITING_FOR_REVIEW');
    // Running it again does not submit twice.
    fake.requests = [];
    assert.equal((await run({ submit: true })).code, 0);
    assert.equal(sent('PATCH', '/v1/reviewSubmissions/rs-1').length, 0);
  });

  it('changes nothing on a version that is already waiting for review', async () => {
    fake.version.attributes.appVersionState = 'WAITING_FOR_REVIEW';
    const { code } = await run();
    assert.equal(code, 0);
    assert.ok(fake.requests.every((r) => r.method === 'GET'));
  });
});
