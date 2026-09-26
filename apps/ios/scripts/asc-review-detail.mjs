#!/usr/bin/env node
// Makes sure the App Store version has its (empty) App Review Information record before
// `fastlane deliver` runs: deliver reads that record while uploading the listing and crashes with
// "No data" when the version was just created and has none. Nothing is filled in here — the demo
// account, notes and contact are the owner's to type in App Store Connect — and nothing is
// submitted. Reads the key JSON that asc-api-key-json.sh wrote ($ASC_API_KEY_JSON).
//
//   node apps/ios/scripts/asc-review-detail.mjs <bundle id> <marketing version>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient, findApp } from './testflight-distribute.mjs';

const q = encodeURIComponent;

/** The iOS App Store version `version` of `appId`, created in "Prepare for Submission" if missing. */
export async function ensureVersion(api, appId, version) {
  const res = await api(
    'GET',
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${q(version)}&limit=5`,
  );
  const found = (res.data ?? [])[0];
  if (found) return found;
  const made = await api('POST', '/appStoreVersions', {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: version },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  return made.data;
}

/** Creates the version's empty appStoreReviewDetail when it has none; returns 'exists' | 'created'. */
export async function ensureReviewDetail(api, versionId) {
  const res = await api('GET', `/appStoreVersions/${versionId}/appStoreReviewDetail`).catch((e) => {
    if (e.status === 404) return { data: null };
    throw e;
  });
  if (res.data) return 'exists';
  await api('POST', '/appStoreReviewDetails', {
    data: {
      type: 'appStoreReviewDetails',
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
    },
  });
  return 'created';
}

async function main() {
  const [bundleId, version] = process.argv.slice(2);
  const jsonPath = process.env.ASC_API_KEY_JSON;
  if (!bundleId || !version || !jsonPath) {
    console.error(
      'usage: ASC_API_KEY_JSON=… asc-review-detail.mjs <bundle id> <marketing version>',
    );
    return 2;
  }
  const { key_id: keyId, issuer_id: issuer, key } = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const api = createClient({ keyId, issuer, privateKey: key });
  const app = await findApp(api, bundleId);
  if (!app) {
    console.error(`::error::No App Store Connect app with bundle id ${bundleId}`);
    return 1;
  }
  const v = await ensureVersion(api, app.id, version);
  const state = await ensureReviewDetail(api, v.id);
  console.log(`App Store version ${version}: review information record ${state}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`::error::${error.message}`);
      process.exit(1);
    },
  );
}
