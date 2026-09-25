#!/usr/bin/env node
// Finds or makes the App Store provisioning profiles the signed iOS build needs, through the App
// Store Connect API key (docs/RELEASING.md), and installs them where Xcode looks for profiles.
//
//   node apps/ios/scripts/asc-profiles.mjs <certificate SHA-1> <bundle id>…
//
// Reads ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_PATH (the .p8 file) from the
// environment. The certificate is the Apple Distribution certificate already imported into the
// build's keychain, named by its SHA-1 as `security find-identity` prints it. For each bundle id
// it reuses an active profile this script made earlier for that certificate, or creates one; it
// never deletes anything in the account. Prints one line per bundle id, `<bundle id>=<profile
// name>`, and nothing secret: profile names and ids are not credentials.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const API = 'https://api.appstoreconnect.apple.com/v1';
const [certSha1, ...bundleIds] = process.argv.slice(2);
const { ASC_API_KEY_ID: keyId, ASC_API_ISSUER_ID: issuer, ASC_API_KEY_PATH: keyPath } = process.env;
if (!certSha1 || bundleIds.length === 0 || !keyId || !issuer || !keyPath) {
  console.error(
    'usage: ASC_API_KEY_ID=… ASC_API_ISSUER_ID=… ASC_API_KEY_PATH=… asc-profiles.mjs <cert sha1> <bundle id>…',
  );
  process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const key = createPrivateKey(readFileSync(keyPath));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${head}.${body}.${b64url(signature)}`;
}
const jwt = token();

async function api(method, pathAndQuery, body) {
  const res = await fetch(`${API}${pathAndQuery}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Apple's own words (e.g. a key without access to Certificates, Identifiers & Profiles).
    const why = (json.errors ?? []).map((e) => `${e.code}: ${e.title} — ${e.detail}`).join('; ');
    throw new Error(
      `App Store Connect ${method} ${pathAndQuery.split('?')[0]} → ${res.status} ${why}`,
    );
  }
  return json;
}

const wanted = certSha1.toLowerCase();
const certs = await api(
  'GET',
  '/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200',
);
const cert = certs.data.find(
  (c) =>
    createHash('sha1')
      .update(Buffer.from(c.attributes.certificateContent, 'base64'))
      .digest('hex') === wanted,
);
if (!cert) {
  throw new Error(
    "The Apple Distribution certificate in IOS_CSC_LINK is not one of the team's distribution certificates " +
      '(revoked, expired, or from another team).',
  );
}

const ids = await api(
  'GET',
  `/bundleIds?filter[platform]=IOS&filter[identifier]=${bundleIds.join(',')}&limit=200`,
);
const profiles = await api('GET', '/profiles?filter[profileType]=IOS_APP_STORE&limit=200');
const dirs = [
  path.join(homedir(), 'Library/MobileDevice/Provisioning Profiles'),
  path.join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
];
for (const dir of dirs) mkdirSync(dir, { recursive: true });

for (const identifier of bundleIds) {
  const bundle = ids.data.find((b) => b.attributes.identifier === identifier);
  if (!bundle) throw new Error(`The App ID ${identifier} is not registered for iOS in the team.`);
  // Profile names take letters, digits and spaces; the certificate's id keeps one per certificate.
  const prefix = `CoreHub CI ${identifier.replace(/[^A-Za-z0-9]+/g, ' ')} ${cert.id}`;
  let profile = profiles.data.find(
    (p) => p.attributes.name.startsWith(prefix) && p.attributes.profileState === 'ACTIVE',
  );
  if (!profile) {
    // A new name when an older one of ours went invalid (an App ID capability changed).
    const stale = profiles.data.some((p) => p.attributes.name.startsWith(prefix));
    const name = stale
      ? `${prefix} ${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
      : prefix;
    const made = await api('POST', '/profiles', {
      data: {
        type: 'profiles',
        attributes: { name, profileType: 'IOS_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundle.id } },
          certificates: { data: [{ type: 'certificates', id: cert.id }] },
        },
      },
    });
    profile = made.data;
    console.error(`created profile "${name}"`);
  } else {
    console.error(`reusing profile "${profile.attributes.name}"`);
  }
  const content = Buffer.from(profile.attributes.profileContent, 'base64');
  for (const dir of dirs)
    writeFileSync(path.join(dir, `${profile.attributes.uuid}.mobileprovision`), content);
  console.log(`${identifier}=${profile.attributes.name}`);
}
