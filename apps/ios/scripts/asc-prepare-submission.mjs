#!/usr/bin/env node
// Readies an App Store version of the iOS app for App Review through the App Store Connect API,
// and says what is still missing (docs/RELEASING.md → App Store submission). Run by
// .github/workflows/ios-submit.yml.
//
//   node apps/ios/scripts/asc-prepare-submission.mjs <bundle id> <version> [build number] [--submit]
//
// Without --submit it changes only what this repository decides and never submits:
//   - attaches the build (the given build number, else the newest VALID build of that version);
//   - answers the age rating questionnaire with AGE_RATING below (docs/store/apple/README.md);
//   - makes the app free (price point 0.00, base territory USA) when no price is set, and
//     available in every territory but EXCLUDED_TERRITORIES when no availability is set;
//   - declares "does not use third-party content" when nothing is declared;
//   - sets the release to manual after approval (releaseType MANUAL);
// then prints what the owner still has to do in App Store Connect.
//
// With --submit it does the same, and only when nothing is missing it adds the version to a
// review submission and submits it; otherwise it exits 1 with the list. It never writes the App
// Review contact, the notes or the demo account: those are the owner's own entries, and the demo
// password is never printed.
//
// App Privacy cannot be read or written through the public App Store Connect API (it has no
// endpoint for it, checked 2026-09-26); it is always listed as the owner's check, and Apple itself
// refuses a submission whose App Privacy answers were not published.
//
// Reads the key JSON that asc-api-key-json.sh wrote ($ASC_API_KEY_JSON).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { API, AscError, createClient, findApp, githubLog } from './testflight-distribute.mjs';

const q = encodeURIComponent;

/**
 * The age rating answers of docs/store/apple/README.md (proposed — owner to confirm), as App Store
 * Connect's AgeRatingDeclaration attributes. They give 13+.
 */
export const AGE_RATING = Object.freeze({
  parentalControls: false,
  ageAssurance: false,
  unrestrictedWebAccess: false,
  userGeneratedContent: false,
  socialMedia: false,
  messagingAndChat: true,
  advertising: false,
  profanityOrCrudeHumor: 'INFREQUENT',
  horrorOrFearThemes: 'NONE',
  alcoholTobaccoOrDrugUseOrReferences: 'NONE',
  medicalOrTreatmentInformation: 'INFREQUENT',
  healthOrWellnessTopics: false,
  matureOrSuggestiveThemes: 'INFREQUENT',
  sexualContentOrNudity: 'NONE',
  sexualContentGraphicAndNudity: 'NONE',
  violenceCartoonOrFantasy: 'NONE',
  violenceRealistic: 'NONE',
  violenceRealisticProlongedGraphicOrSadistic: 'NONE',
  gunsOrOtherWeapons: 'NONE',
  gambling: false,
  gamblingSimulated: 'NONE',
  contests: 'NONE',
  lootBox: false,
});

/** The older names of the frequency answers, which App Store Connect still accepts. */
const LEGACY_LEVEL = { INFREQUENT: 'INFREQUENT_OR_MILD', FREQUENT: 'FREQUENT_OR_INTENSE' };
const sameAnswer = (current, wanted) =>
  current === wanted || (current != null && LEGACY_LEVEL[wanted] === current);

/**
 * Territories left out when availability is first set (proposed — owner to confirm). China
 * mainland needs an ICP filing number and a permit for generative AI features; without them App
 * Review rejects the version or asks to remove China, which would hold up the whole review.
 */
export const EXCLUDED_TERRITORIES = Object.freeze(['CHN']);

export const BASE_TERRITORY = 'USA';

/** Version states in which the version can still be changed and submitted. */
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
  'READY_FOR_REVIEW',
]);

/** GET that treats 404 as "none". */
async function getOrNull(api, path) {
  try {
    const res = await api('GET', path);
    return res.data ?? null;
  } catch (err) {
    if (err instanceof AscError && err.status === 404) return null;
    throw err;
  }
}

export async function findVersion(api, appId, version) {
  const res = await api(
    'GET',
    `/apps/${q(appId)}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${q(version)}&limit=5`,
  );
  return (res.data ?? [])[0] ?? null;
}

/** The given build of `version`, or the newest VALID one; with its buildBetaDetail attributes. */
export async function resolveBuild(api, { appId, version, buildNumber }) {
  const filter = buildNumber
    ? `&filter[version]=${q(buildNumber)}`
    : '&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate';
  const res = await api(
    'GET',
    `/builds?filter[app]=${q(appId)}&filter[preReleaseVersion.version]=${q(version)}${filter}` +
      '&include=buildBetaDetail&limit=1',
  );
  const build = (res.data ?? [])[0];
  if (!build) return null;
  const beta = (res.included ?? []).find((i) => i.type === 'buildBetaDetails');
  return { build, beta: beta?.attributes ?? {} };
}

/** The app's App Information record that can still be edited (not the live one). */
export async function editableAppInfo(api, appId) {
  const res = await api('GET', `/apps/${q(appId)}/appInfos?limit=10`);
  const infos = res.data ?? [];
  const live = new Set(['READY_FOR_DISTRIBUTION', 'ACCEPTED', 'PENDING_RELEASE', 'READY_FOR_SALE']);
  return (
    infos.find((i) => !live.has(i.attributes?.state ?? i.attributes?.appStoreState)) ??
    infos[0] ??
    null
  );
}

/**
 * Answers the questionnaire with AGE_RATING where it differs. A question App Store Connect does not
 * know (the API changes) is left out and returned, for the owner to answer by hand; a frequency it
 * refuses is retried with the older name.
 */
export async function applyAgeRating(api, declaration) {
  const current = declaration.attributes ?? {};
  const attrs = {};
  for (const [key, value] of Object.entries(AGE_RATING)) {
    if (!sameAnswer(current[key], value)) attrs[key] = value;
  }
  const changed = Object.keys(attrs);
  if (changed.length === 0) return { changed: [], skipped: [] };
  const skipped = [];
  for (let attempt = 0; attempt < 6 && Object.keys(attrs).length > 0; attempt += 1) {
    try {
      await api('PATCH', `/ageRatingDeclarations/${q(declaration.id)}`, {
        data: { type: 'ageRatingDeclarations', id: declaration.id, attributes: attrs },
      });
      return { changed: Object.keys(attrs), skipped };
    } catch (err) {
      if (!(err instanceof AscError) || err.status >= 500 || err.status === 401) throw err;
      const bad = (err.errors ?? [])
        .map((e) => /^\/data\/attributes\/(\w+)/.exec(e.source?.pointer ?? '')?.[1])
        .filter((k) => k && k in attrs);
      if (bad.length === 0) throw err;
      for (const key of bad) {
        if (LEGACY_LEVEL[attrs[key]]) {
          attrs[key] = LEGACY_LEVEL[attrs[key]];
        } else {
          delete attrs[key];
          skipped.push(key);
        }
      }
    }
  }
  if (Object.keys(attrs).length === 0) return { changed: [], skipped };
  throw new Error('App Store Connect kept refusing the age rating answers.');
}

/** 'set' | 'free' (already) | 'paid' (left alone). */
export async function ensureFree(api, appId) {
  const schedule = await getOrNull(api, `/apps/${q(appId)}/appPriceSchedule`);
  if (schedule) {
    const res = await api(
      'GET',
      `/appPriceSchedules/${q(schedule.id)}/manualPrices?include=appPricePoint&limit=50`,
    );
    const points = (res.included ?? []).filter((i) => i.type === 'appPricePoints');
    if ((res.data ?? []).length > 0) {
      return points.every((p) => Number(p.attributes?.customerPrice) === 0) ? 'free' : 'paid';
    }
  }
  const res = await api(
    'GET',
    `/apps/${q(appId)}/appPricePoints?filter[territory]=${BASE_TERRITORY}&limit=200`,
  );
  const free = (res.data ?? []).find((p) => Number(p.attributes?.customerPrice) === 0);
  if (!free) throw new Error(`App Store Connect listed no 0.00 price point in ${BASE_TERRITORY}.`);
  await api('POST', '/appPriceSchedules', {
    data: {
      type: 'appPriceSchedules',
      relationships: {
        app: { data: { type: 'apps', id: appId } },
        baseTerritory: { data: { type: 'territories', id: BASE_TERRITORY } },
        manualPrices: { data: [{ type: 'appPrices', id: '${free}' }] },
      },
    },
    included: [
      {
        type: 'appPrices',
        id: '${free}',
        attributes: { startDate: null },
        relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } },
      },
    ],
  });
  return 'set';
}

/** 'exists' | { set: n } — every territory but EXCLUDED_TERRITORIES, and new ones as they come. */
export async function ensureAvailability(api, apiV2, appId) {
  const current = await getOrNull(api, `/apps/${q(appId)}/appAvailabilityV2`);
  if (current) return 'exists';
  const res = await api('GET', '/territories?limit=200');
  const ids = (res.data ?? []).map((t) => t.id).filter((id) => !EXCLUDED_TERRITORIES.includes(id));
  if (ids.length === 0) throw new Error('App Store Connect listed no territories.');
  const ref = (id) => `\${t-${id}}`;
  await apiV2('POST', '/appAvailabilities', {
    data: {
      type: 'appAvailabilities',
      attributes: { availableInNewTerritories: true },
      relationships: {
        app: { data: { type: 'apps', id: appId } },
        territoryAvailabilities: {
          data: ids.map((id) => ({ type: 'territoryAvailabilities', id: ref(id) })),
        },
      },
    },
    included: ids.map((id) => ({
      type: 'territoryAvailabilities',
      id: ref(id),
      attributes: { available: true },
      relationships: { territory: { data: { type: 'territories', id } } },
    })),
  });
  return { set: ids.length };
}

/** What App Review Information still lacks. Never returns or prints the values themselves. */
export function reviewDetailGaps(detail) {
  const a = detail?.attributes ?? {};
  const gaps = [];
  const contact = [
    ['contactFirstName', 'first name'],
    ['contactLastName', 'last name'],
    ['contactPhone', 'phone'],
    ['contactEmail', 'email'],
  ]
    .filter(([key]) => !String(a[key] ?? '').trim())
    .map(([, label]) => label);
  if (contact.length) {
    gaps.push(`App Review Information → Contact: ${contact.join(', ')}.`);
  }
  if (a.demoAccountRequired !== true) {
    gaps.push(
      'App Review Information → tick "Sign-in required" (the app only works signed in to a hub).',
    );
  }
  const account = [
    ['demoAccountName', 'user name'],
    ['demoAccountPassword', 'password'],
  ]
    .filter(([key]) => !String(a[key] ?? '').trim())
    .map(([, label]) => label);
  if (account.length) {
    gaps.push(
      `App Review Information → Sign-in required: the demo account's ${account.join(' and ')}.`,
    );
  }
  if (!String(a.notes ?? '').trim()) {
    gaps.push(
      'App Review Information → Notes: paste docs/store/apple/review-notes.md with the demo hub address.',
    );
  }
  return gaps;
}

export const PRIVACY_NOTE =
  'App Privacy (App Store Connect → the app → App Privacy): answer "No, we do not collect data ' +
  'from this app" and Publish. The public API cannot read or set it, so this is never checked here; ' +
  'Apple refuses the submission while it is missing.';

/** Adds the version to a draft review submission (reusing one) and submits it. */
export async function submitForReview(api, { appId, versionId, log }) {
  const res = await api(
    'GET',
    `/reviewSubmissions?filter[app]=${q(appId)}&filter[platform]=IOS` +
      '&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=10',
  );
  const open = res.data ?? [];
  const waiting = open.find((s) =>
    ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(s.attributes?.state),
  );
  if (waiting) {
    log.notice(`A review submission is already ${waiting.attributes.state}; nothing submitted.`);
    return 0;
  }
  if (open.some((s) => s.attributes?.state === 'UNRESOLVED_ISSUES')) {
    log.error(
      'A review submission has unresolved issues: answer App Review in App Store Connect → ' +
        'App Review, then resubmit there.',
    );
    return 1;
  }
  let submission = open.find((s) => s.attributes?.state === 'READY_FOR_REVIEW');
  if (!submission) {
    const made = await api('POST', '/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    submission = made.data;
  }
  const items = await api(
    'GET',
    `/reviewSubmissions/${q(submission.id)}/items?include=appStoreVersion&limit=50`,
  );
  const has = (items.data ?? []).some(
    (i) => i.relationships?.appStoreVersion?.data?.id === versionId,
  );
  if (!has) {
    await api('POST', '/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
  }
  await api('PATCH', `/reviewSubmissions/${q(submission.id)}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  log.notice(
    'Submitted for App Review. App Store Connect emails the account holder with the result.',
  );
  log.summary('- Submitted for App Review.');
  return 0;
}

/** The whole job. Returns the process exit code. */
export async function prepare({
  api,
  apiV2,
  bundleId,
  version,
  buildNumber = '',
  submit = false,
  log = githubLog,
}) {
  const applied = [];
  const already = [];
  const missing = [];
  const note = (list, m) => {
    list.push(m);
    log.info(`${list === applied ? 'applied' : list === already ? 'already' : 'missing'}: ${m}`);
  };

  const app = await findApp(api, bundleId);
  if (!app) {
    log.error(`No app with bundle id ${bundleId} in App Store Connect (or the key cannot see it).`);
    return 1;
  }
  const v = await findVersion(api, app.id, version);
  if (!v) {
    log.error(
      `App Store version ${version} does not exist. Upload the listing first ` +
        '(ios-store-metadata.yml or ios-screenshots.yml with upload).',
    );
    return 1;
  }
  const state = v.attributes?.appVersionState ?? v.attributes?.appStoreState;
  if (state && !EDITABLE.has(state)) {
    log.notice(`App Store version ${version} is ${state}; it cannot be changed now. Nothing done.`);
    return submit && state !== 'WAITING_FOR_REVIEW' && state !== 'IN_REVIEW' ? 1 : 0;
  }

  // (a) The build.
  const found = await resolveBuild(api, { appId: app.id, version, buildNumber });
  const label = buildNumber ? `build ${buildNumber} (${version})` : `a build of ${version}`;
  if (!found) {
    note(missing, `Build: App Store Connect has no ${buildNumber ? label : `VALID ${label}`}.`);
  } else if (found.build.attributes?.processingState !== 'VALID') {
    note(
      missing,
      `Build: ${label} is ${found.build.attributes?.processingState}, not VALID; it cannot be attached.`,
    );
  } else {
    const number = found.build.attributes?.version;
    const attached = await getOrNull(api, `/appStoreVersions/${q(v.id)}/build`);
    if (attached?.id === found.build.id) {
      note(already, `Build ${number} is attached to ${version}.`);
    } else {
      await api('PATCH', `/appStoreVersions/${q(v.id)}/relationships/build`, {
        data: { type: 'builds', id: found.build.id },
      });
      note(applied, `Attached build ${number} to ${version}.`);
    }
    if (found.beta.internalBuildState === 'MISSING_EXPORT_COMPLIANCE') {
      note(
        missing,
        `Export compliance of build ${number} (App Store Connect → TestFlight → the build).`,
      );
    }
  }

  // (e) Manual release after approval.
  if (v.attributes?.releaseType === 'MANUAL') {
    note(already, 'Release: manual after approval.');
  } else {
    await api('PATCH', `/appStoreVersions/${q(v.id)}`, {
      data: { type: 'appStoreVersions', id: v.id, attributes: { releaseType: 'MANUAL' } },
    });
    note(applied, 'Release set to manual after approval.');
  }
  if (!String(v.attributes?.copyright ?? '').trim()) {
    note(
      missing,
      'Copyright of the version (App Store tab → the version → Copyright: "2026 twuijri").',
    );
  }

  // (d) Content rights.
  const rights = app.attributes?.contentRightsDeclaration;
  if (rights) {
    note(already, `Content rights: ${rights}.`);
  } else {
    await api('PATCH', `/apps/${q(app.id)}`, {
      data: {
        type: 'apps',
        id: app.id,
        attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' },
      },
    });
    note(applied, 'Content rights: does not use third-party content.');
  }

  // (b) Age rating, and the App Information the version needs.
  const info = await editableAppInfo(api, app.id);
  if (!info) {
    note(missing, 'App Information: App Store Connect returned none for the app.');
  } else {
    const declaration = await getOrNull(api, `/appInfos/${q(info.id)}/ageRatingDeclaration`);
    if (!declaration) {
      note(missing, 'Age rating: App Store Connect returned no questionnaire to answer.');
    } else {
      const { changed, skipped } = await applyAgeRating(api, declaration);
      if (changed.length) note(applied, `Age rating: answered ${changed.length} questions (13+).`);
      else if (!skipped.length)
        note(already, 'Age rating: answered as in docs/store/apple/README.md.');
      if (skipped.length) {
        note(
          missing,
          `Age rating (App Information → Age Rating): App Store Connect did not take ${skipped.join(', ')}; ` +
            'answer them by hand as in docs/store/apple/README.md.',
        );
      }
    }
    const category = await getOrNull(api, `/appInfos/${q(info.id)}/primaryCategory`);
    if (!category) {
      note(missing, 'Primary category (App Information → Category: Productivity).');
    }
    const locs = await api('GET', `/appInfos/${q(info.id)}/appInfoLocalizations?limit=50`);
    const noPolicy = (locs.data ?? [])
      .filter((l) => !String(l.attributes?.privacyPolicyUrl ?? '').trim())
      .map((l) => l.attributes?.locale);
    if (noPolicy.length) {
      note(missing, `Privacy policy URL for ${noPolicy.join(', ')} (App Information).`);
    }
  }

  // (c) Price and availability.
  const price = await ensureFree(api, app.id);
  if (price === 'set') note(applied, 'Price: free (0.00, base territory USA).');
  else if (price === 'free') note(already, 'Price: free.');
  else log.warning('The app has a price that is not free; it was left as it is.');
  const territories = await ensureAvailability(api, apiV2, app.id);
  if (territories === 'exists') {
    note(already, 'Availability: already set (not changed).');
  } else {
    note(
      applied,
      `Availability: ${territories.set} territories and new ones as they come` +
        (EXCLUDED_TERRITORIES.length ? `, not ${EXCLUDED_TERRITORIES.join(', ')}.` : '.'),
    );
  }

  // (f) What only the owner enters.
  const detail = await getOrNull(api, `/appStoreVersions/${q(v.id)}/appStoreReviewDetail`);
  for (const gap of reviewDetailGaps(detail)) note(missing, gap);

  const lines = [
    `App Store version ${version}:`,
    ...applied.map((m) => `  applied  ${m}`),
    ...already.map((m) => `  ok       ${m}`),
    '',
    missing.length ? 'Still missing before submission:' : 'Nothing missing that the API can see.',
    ...missing.map((m, i) => `  ${i + 1}. ${m}`),
    '',
    `Always the owner's check: ${PRIVACY_NOTE}`,
  ];
  for (const line of lines) log.info(line);
  log.summary(
    [
      `### App Store version ${version}`,
      ...applied.map((m) => `- applied: ${m}`),
      ...already.map((m) => `- ok: ${m}`),
      missing.length
        ? '\n**Still missing before submission**'
        : '\nNothing missing that the API can see.',
      ...missing.map((m, i) => `${i + 1}. ${m}`),
      `\n${PRIVACY_NOTE}`,
    ].join('\n'),
  );

  if (!submit) return 0;
  if (missing.length) {
    log.error(`Not submitted: ${missing.length} item(s) still missing (listed above).`);
    return 1;
  }
  return submitForReview(api, { appId: app.id, versionId: v.id, log });
}

async function main() {
  const args = process.argv.slice(2);
  const submit = args.includes('--submit');
  const [bundleId, version, buildNumber = ''] = args.filter((a) => a !== '--submit');
  const jsonPath = process.env.ASC_API_KEY_JSON;
  if (!bundleId || !version || !jsonPath) {
    console.error(
      'usage: ASC_API_KEY_JSON=… asc-prepare-submission.mjs <bundle id> <version> [build number] [--submit]',
    );
    return 2;
  }
  const { key_id: keyId, issuer_id: issuer, key } = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const api = createClient({ keyId, issuer, privateKey: key });
  const apiV2 = createClient({ base: API.replace(/\/v1$/, '/v2'), keyId, issuer, privateKey: key });
  return prepare({ api, apiV2, bundleId, version, buildNumber: buildNumber.trim(), submit });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.log(`::error::${error.message}`);
      process.exit(1);
    },
  );
}
