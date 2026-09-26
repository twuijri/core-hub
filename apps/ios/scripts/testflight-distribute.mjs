#!/usr/bin/env node
// Adds a build just uploaded to TestFlight to TestFlight groups, through the App Store Connect API
// key the signed iOS build already uses (docs/RELEASING.md). App Store Connect adds builds to an
// internal group by itself only when they come from Xcode's own upload ("Automatic for Xcode
// Builds"); builds uploaded by CI with altool have to be added through the API.
//
//   node apps/ios/scripts/testflight-distribute.mjs <bundle id> <build number> <marketing version> <groups>
//
// <groups> is a comma-separated list of group names (e.g. "Owner" or "Owner, Friends").
// Reads ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_PATH (the .p8 file) from the environment,
// and optionally TESTFLIGHT_WAIT_MINUTES (default 30) and TESTFLIGHT_POLL_SECONDS (default 30).
//
// It waits until App Store Connect has processed the build (processingState VALID), then adds it
// to each group. Apple being slow is a warning, not a failure: the build is still in TestFlight
// and can be added by hand. A build Apple rejected, an unknown app or an unknown group fails the
// step. Nothing secret is printed: the token never reaches the log.
import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API = 'https://api.appstoreconnect.apple.com/v1';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** An App Store Connect JWT (ES256, 15 minutes; Apple allows at most 20). */
export function makeToken({ keyId, issuer, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ iss: issuer, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${head}.${body}.${b64url(signature)}`;
}

export class AscError extends Error {
  constructor(message, status, errors = []) {
    super(message);
    this.status = status;
    /** Apple's error objects ({ code, title, detail, source }), for callers that act on them. */
    this.errors = errors;
  }
}

/**
 * A small API client. The token is remade every 10 minutes, since waiting for processing can
 * outlast one token.
 */
export function createClient({ base = API, keyId, issuer, privateKey, clock = () => Date.now() }) {
  let jwt = '';
  let madeAt = -Infinity;
  const bearer = () => {
    const now = clock();
    if (now - madeAt > 10 * 60_000) {
      jwt = makeToken({ keyId, issuer, privateKey, now });
      madeAt = now;
    }
    return jwt;
  };
  return async function api(method, pathAndQuery, body) {
    const res = await fetch(`${base}${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      // Apple's own words (e.g. a key whose role cannot manage TestFlight).
      const why = (json.errors ?? []).map((e) => `${e.code}: ${e.title} — ${e.detail}`).join('; ');
      throw new AscError(
        `App Store Connect ${method} ${pathAndQuery.split('?')[0]} → ${res.status} ${why}`.trim(),
        res.status,
        json.errors ?? [],
      );
    }
    return json;
  };
}

const q = encodeURIComponent;

export async function findApp(api, bundleId) {
  const res = await api('GET', `/apps?filter[bundleId]=${q(bundleId)}&limit=10`);
  return (res.data ?? []).find((a) => a.attributes?.bundleId === bundleId) ?? null;
}

/** The build and its TestFlight state (buildBetaDetail), or null when it is not listed yet. */
export async function findBuild(api, { appId, buildNumber, version }) {
  const res = await api(
    'GET',
    `/builds?filter[app]=${q(appId)}&filter[version]=${q(buildNumber)}` +
      `&filter[preReleaseVersion.version]=${q(version)}&include=buildBetaDetail&limit=10`,
  );
  const build = (res.data ?? [])[0];
  if (!build) return null;
  const detailId = build.relationships?.buildBetaDetail?.data?.id;
  const detail = (res.included ?? []).find(
    (i) => i.type === 'buildBetaDetails' && (!detailId || i.id === detailId),
  );
  return { build, beta: detail?.attributes ?? {} };
}

// A network error, a rate limit or a 5xx while waiting is Apple being slow, not a verdict.
const transient = (err) => !(err instanceof AscError) || err.status === 429 || err.status >= 500;

/**
 * Polls until processingState is VALID (or FAILED/INVALID), or the time runs out.
 * Returns { status: 'valid' | 'rejected' | 'timeout', found? }.
 */
export async function waitForBuild(
  api,
  { appId, buildNumber, version, timeoutMs, intervalMs, sleep, clock, log },
) {
  const start = clock();
  let last = '';
  for (;;) {
    let found = null;
    let seen;
    try {
      found = await findBuild(api, { appId, buildNumber, version });
      seen = found
        ? `processingState ${found.build.attributes?.processingState}`
        : 'not listed yet';
    } catch (err) {
      if (!transient(err)) throw err;
      seen = `App Store Connect did not answer (${err.message})`;
    }
    if (seen !== last) {
      const minutes = Math.round((clock() - start) / 60_000);
      log.info(`build ${buildNumber} (${version}) after ${minutes} min: ${seen}`);
      last = seen;
    }
    const state = found?.build.attributes?.processingState;
    if (state === 'VALID') return { status: 'valid', found };
    if (state === 'FAILED' || state === 'INVALID') return { status: 'rejected', found };
    if (clock() - start + intervalMs > timeoutMs) return { status: 'timeout', found };
    await sleep(intervalMs);
  }
}

/**
 * A group name as a person means it: invisible direction and joiner marks (U+200B–U+200F,
 * U+202A–U+202E, U+2060–U+2069, U+FEFF) dropped, spaces trimmed, case ignored. A name pasted from
 * right-to-left text carries such marks (the owner's "Owner" group did: "Owner" + U+2069), which
 * App Store Connect keeps and a person cannot see.
 */
export const groupKey = (name) =>
  String(name ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .trim()
    .toLowerCase();

/** Matches group names (see groupKey) to the app's beta groups. */
export async function resolveGroups(api, appId, names) {
  const res = await api('GET', `/apps/${q(appId)}/betaGroups?limit=200`);
  const groups = res.data ?? [];
  const found = [];
  const missing = [];
  for (const name of names) {
    const group = groups.find((g) => groupKey(g.attributes?.name) === groupKey(name));
    if (group) {
      found.push({
        id: group.id,
        name: group.attributes.name,
        internal: group.attributes.isInternalGroup === true,
      });
    } else {
      missing.push(name);
    }
  }
  return { found, missing, available: groups.map((g) => g.attributes?.name).filter(Boolean) };
}

export async function addToGroups(api, buildId, groups) {
  await api('POST', `/builds/${q(buildId)}/relationships/betaGroups`, {
    data: groups.map((g) => ({ type: 'betaGroups', id: g.id })),
  });
}

export const parseGroups = (value) => [
  ...new Set(
    String(value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/** GitHub annotations, and the step summary when there is one. */
export const githubLog = {
  info: (m) => console.log(m),
  notice: (m) => console.log(`::notice::${m}`),
  warning: (m) => console.log(`::warning::${m}`),
  error: (m) => console.log(`::error::${m}`),
  summary: (m) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${m}\n`);
  },
};

/** The whole job. Returns the process exit code. */
export async function distribute({
  api,
  bundleId,
  buildNumber,
  version,
  groups,
  timeoutMs = 30 * 60_000,
  intervalMs = 30_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now(),
  log = githubLog,
}) {
  const names = parseGroups(groups);
  if (names.length === 0) {
    log.info('No TestFlight groups asked for; nothing to do.');
    return 0;
  }
  const label = `build ${buildNumber} (${version})`;
  const byHand = 'Add it by hand: App Store Connect → TestFlight → the group → Builds → +.';

  const app = await findApp(api, bundleId);
  if (!app) {
    log.error(`No app with bundle id ${bundleId} in App Store Connect (or the key cannot see it).`);
    return 1;
  }

  const waited = await waitForBuild(api, {
    appId: app.id,
    buildNumber,
    version,
    timeoutMs,
    intervalMs,
    sleep,
    clock,
    log,
  });
  if (waited.status === 'timeout') {
    const minutes = Math.round(timeoutMs / 60_000);
    log.warning(
      `App Store Connect had not finished processing ${label} after ${minutes} minutes ` +
        `(${waited.found ? `processingState ${waited.found.build.attributes?.processingState}` : 'not listed yet'}), ` +
        `so it was NOT added to ${names.join(', ')}. The upload itself succeeded. ${byHand}`,
    );
    log.summary(`- TestFlight: ${label} still processing; not added to ${names.join(', ')}.`);
    return 0;
  }
  if (waited.status === 'rejected') {
    log.error(
      `App Store Connect rejected ${label}: processingState ${waited.found.build.attributes?.processingState}. ` +
        'Apple emails the reason to the account holder.',
    );
    return 1;
  }

  const { build, beta } = waited.found;
  if (beta.internalBuildState === 'MISSING_EXPORT_COMPLIANCE') {
    log.warning(
      `${label} is missing export compliance, so testers cannot install it yet ` +
        '(ITSAppUsesNonExemptEncryption should have answered it; check apps/ios/project.yml). ' +
        'Answer it in App Store Connect → TestFlight → the build → Manage. ' +
        'The build is still added to the groups and becomes installable once answered.',
    );
    log.summary(`- TestFlight: ${label} is missing export compliance.`);
  }

  const { found, missing, available } = await resolveGroups(api, app.id, names);
  if (found.length > 0) {
    await addToGroups(api, build.id, found);
    for (const g of found) {
      log.notice(`Added ${label} to TestFlight group "${g.name}".`);
      if (!g.internal) {
        log.notice(
          `"${g.name}" is an external group: its testers get the build only after Beta App ` +
            'Review approves it. This workflow does not submit for review.',
        );
      }
    }
    log.summary(
      `- TestFlight: ${label} added to ${found.map((g) => g.name).join(', ')}` +
        (found.some((g) => !g.internal) ? ' (external groups wait for Beta App Review)' : '') +
        '.',
    );
  }
  if (missing.length > 0) {
    log.error(
      `No TestFlight group named ${missing.map((n) => `"${n}"`).join(', ')} for ${bundleId}. ` +
        `The app's groups: ${available.length ? available.map((n) => `"${n}"`).join(', ') : 'none'}.`,
    );
    return 1;
  }
  return 0;
}

async function main() {
  const [bundleId, buildNumber, version, groups] = process.argv.slice(2);
  const {
    ASC_API_KEY_ID: keyId,
    ASC_API_ISSUER_ID: issuer,
    ASC_API_KEY_PATH: keyPath,
  } = process.env;
  if (!bundleId || !buildNumber || !version || !keyId || !issuer || !keyPath) {
    console.error(
      'usage: ASC_API_KEY_ID=… ASC_API_ISSUER_ID=… ASC_API_KEY_PATH=… ' +
        'testflight-distribute.mjs <bundle id> <build number> <marketing version> <groups>',
    );
    return 2;
  }
  const api = createClient({ keyId, issuer, privateKey: readFileSync(keyPath) });
  const minutes = Number(process.env.TESTFLIGHT_WAIT_MINUTES) || 30;
  const seconds = Number(process.env.TESTFLIGHT_POLL_SECONDS) || 30;
  return distribute({
    api,
    bundleId,
    buildNumber,
    version,
    groups,
    timeoutMs: minutes * 60_000,
    intervalMs: seconds * 1000,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error::${err.message}`);
      process.exit(1);
    },
  );
}
