/**
 * Reading the files a push sender is set up from, before anything is sent (the owner,
 * 2026-09-26: setting up APNs by typing felt wrong — Apple and Firebase hand out files).
 *
 * - APNs: the `.p8` key Apple lets you download once, named `AuthKey_<KEY ID>.p8`; the name
 *   carries the key's id, so the form fills it in.
 * - FCM: the service-account JSON (Project settings → Service accounts → Generate new private
 *   key). `google-services.json` is the Android app's file, not the hub's: it is recognised and
 *   refused with that said plainly, since it is the file people have at hand.
 *
 * Nothing here is a check the hub relies on: it checks again (and signs a test token) on save.
 */

export type ServiceAccountCheck =
  | { ok: true; projectId: string; clientEmail: string }
  | { ok: false; reason: 'not_json' | 'google_services' | 'not_service_account' }
  | { ok: false; reason: 'missing'; fields: string[] };

export function inspectServiceAccount(text: string): ServiceAccountCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_json' };
  }
  const json = parsed as Record<string, unknown>;
  if ('project_info' in json && 'client' in json) return { ok: false, reason: 'google_services' };
  if (json.type !== undefined && json.type !== 'service_account') {
    return { ok: false, reason: 'not_service_account' };
  }
  const fields = ['type', 'project_id', 'client_email', 'private_key'].filter(
    (field) => typeof json[field] !== 'string' || !(json[field] as string).trim(),
  );
  if (fields.length > 0) return { ok: false, reason: 'missing', fields };
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(json.private_key as string)) {
    return { ok: false, reason: 'missing', fields: ['private_key'] };
  }
  return {
    ok: true,
    projectId: json.project_id as string,
    clientEmail: json.client_email as string,
  };
}

export type P8Check =
  { ok: true; keyId: string | null } | { ok: false; reason: 'not_a_key' | 'not_p8' };

/** Apple's key ids are ten upper-case letters and digits. */
const KEY_ID = /^[A-Z0-9]{10}$/;

/** The key id in `AuthKey_<KEY ID>.p8`, or null for any other name. */
export function keyIdFromFileName(name: string): string | null {
  const match = /^AuthKey_([A-Za-z0-9]+)(?: ?\(\d+\))?\.p8$/.exec(name.trim());
  const id = match?.[1]?.toUpperCase() ?? null;
  return id && KEY_ID.test(id) ? id : null;
}

export function inspectP8(fileName: string | null, text: string): P8Check {
  if (fileName && !/\.p8$/i.test(fileName.trim())) {
    // A `.json` or a certificate chosen by mistake: say it is the wrong file, not a bad key.
    if (!text.includes('PRIVATE KEY')) return { ok: false, reason: 'not_p8' };
  }
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(text)) {
    return { ok: false, reason: 'not_a_key' };
  }
  return { ok: true, keyId: fileName ? keyIdFromFileName(fileName) : null };
}

/** The last characters of an identifier, for "key ending …XXXX". */
export function ending(value: string, size = 4): string {
  return value.length <= size ? value : value.slice(-size);
}
