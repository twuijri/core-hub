/**
 * The model list of a provider signed in through Hermes, asked of the provider itself
 * (contract decision §83 — the owner: «كل الموديلات خله هو يسحب الي يقدمه المزود ما يخترع من
 * نفسه»).
 *
 * What was observed (Hermes v2026.9.14, MIT; read, described here in our words, nothing
 * copied): Hermes's own picker (`/api/model/options`) lists a signed-in provider's models from a
 * live call when it can, but falls back **silently** to a list kept in its code when that call
 * fails or returns nothing — for the ChatGPT subscription a curated list of eight ids plus
 * `-900k` names Hermes invents itself (a large-context switch it strips before the request, not a
 * model the backend lists). Nous Portal's picker shows only Hermes's curated agentic list. The
 * hub could not tell a live list from a remembered one, so an account could be shown a list that
 * was never its own (the owner's Pro account missed the `gpt-6-*` family).
 *
 * So the hub asks the provider directly, from inside Hermes's own Python and with the Hermes
 * home the provider was signed in to: Hermes's own credential resolver gives the account's token
 * (refreshing it when it is about to expire, and once more after a 401), and the provider's own
 * models endpoint answers. The token never leaves that process — the hub reads only the ids.
 * Hermes's list is used only when the provider cannot be asked, and it is then marked
 * `fallback`, with the reason, for a client to say so.
 */

/** Runs Hermes's Python with `HERMES_HOME` set; `argv` follows `-c` (agents' `HermesPython`). */
export type HermesPythonRun = (
  home: string,
  argv: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** One model as the provider listed it. */
export interface LiveModel {
  id: string;
  label: string;
}

export type LiveModels = { ok: true; models: LiveModel[] } | { ok: false; reason: string };

/**
 * The Codex CLI version the hub asks the ChatGPT subscription's model list as (decision §83).
 *
 * The backend reads `client_version` as the version of the official Codex CLI asking and leaves
 * out every model whose `minimal_client_version` is newer. The Codex CLI (openai/codex,
 * Apache-2.0) sends its own release version (`codex-rs/models-manager`: `client_version_to_whole`,
 * the crate version) on `GET …/codex/models?client_version=…`. `0.0.0` — what this file sent
 * until 2026-09-26 — now answers a frozen older list: the owner's Pro account got `gpt-6-astra`
 * and the 5.6 trio but not `gpt-6-sol` / `gpt-6-luna` (Hermes found the same, live 2026-09-22).
 *
 * So the hub sends the latest Codex CLI release: **0.157.0** (`rust-v0.157.0`, 2026-09-25). To
 * bump it, take the newest `rust-v*` tag of github.com/openai/codex. An owner can move it without
 * a release by setting `COREHUB_CODEX_CLIENT_VERSION` in the hub's environment. When this
 * version is refused or lists nothing, `0.0.0` is asked once more rather than showing nothing.
 */
export const CODEX_CLIENT_VERSION = '0.157.0';

/** The version sent, as the hub's environment may override it. */
export function codexClientVersion(env: NodeJS.ProcessEnv): string {
  const override = (env.COREHUB_CODEX_CLIENT_VERSION ?? '').trim();
  return /^\d+\.\d+\.\d+$/.test(override) ? override : CODEX_CLIENT_VERSION;
}

/**
 * The program. Its only inputs are the Hermes provider id and the Codex client version
 * (arguments, never program text) and the environment; it prints one JSON line and never the
 * token.
 *
 * - `openai-codex`: `GET {base}/models?client_version=<version>` with the account id taken from
 *   the token's claims (`ChatGPT-Account-Id`: without it the backend answers an empty list with
 *   a 200) and Hermes's identity headers when Hermes has them; `0.0.0` once more when that
 *   version is refused or lists nothing. A model marked hidden is left out; the rest keep the
 *   backend's order (`priority`). Nothing is added and nothing is renamed.
 * - every other provider: the OpenAI-shaped `GET {base}/models` (`data[].id`).
 */
export const LIVE_MODELS_PROGRAM = `
import base64, json, sys, urllib.error, urllib.request
provider = sys.argv[1]
client_version = sys.argv[2] if len(sys.argv) > 2 else "0.0.0"

def out(value):
    print(json.dumps(value))
    sys.exit(0)

def resolve(force):
    import hermes_cli.auth as auth
    if provider == "openai-codex":
        return auth.resolve_codex_runtime_credentials(force_refresh=force, refresh_if_expiring=True)
    if provider == "xai-oauth":
        return auth.resolve_xai_oauth_runtime_credentials(force_refresh=force)
    if provider == "nous":
        return auth.resolve_nous_runtime_credentials(force_refresh=force)
    if provider == "minimax-oauth":
        return auth.resolve_minimax_oauth_runtime_credentials()
    raise LookupError("no sign-in resolver for " + provider)

def account_of(token):
    try:
        part = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        value = (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
        return value if isinstance(value, str) and value else None
    except Exception:
        return None

def ask(creds, version=None):
    token = str(creds.get("api_key") or "").strip()
    base = str(creds.get("base_url") or "").strip().rstrip("/")
    if not token or not base:
        raise LookupError("the signed-in account has no usable credential")
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    if provider == "openai-codex":
        url = base + "/models?client_version=" + (version or client_version)
        try:
            from agent.codex_headers import codex_cloudflare_headers
            headers.update(codex_cloudflare_headers(token, base_url=base))
        except Exception:
            pass
        account = account_of(token)
        if account:
            headers["ChatGPT-Account-Id"] = account
    else:
        url = base + "/models"
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))

def listed(body):
    rows = []
    if provider == "openai-codex":
        entries = body.get("models") if isinstance(body, dict) else None
        for index, item in enumerate(entries or []):
            if not isinstance(item, dict):
                continue
            slug = str(item.get("slug") or item.get("id") or "").strip()
            if not slug:
                continue
            if str(item.get("visibility") or "").strip().lower() in ("hide", "hidden"):
                continue
            rank = item.get("priority")
            rank = rank if isinstance(rank, (int, float)) else 10000
            label = str(item.get("display_name") or slug).strip() or slug
            rows.append((rank, index, slug, label))
        rows.sort()
    else:
        entries = body.get("data") if isinstance(body, dict) else body
        if isinstance(body, dict) and entries is None:
            entries = body.get("models")
        for index, item in enumerate(entries or []):
            slug = item if isinstance(item, str) else (item.get("id") if isinstance(item, dict) else None)
            slug = str(slug or "").strip()
            if slug:
                label = str((item.get("name") if isinstance(item, dict) else None) or slug)
                rows.append((0, index, slug, label))
    seen, models = set(), []
    for _, _, slug, label in rows:
        if slug in seen:
            continue
        seen.add(slug)
        models.append({"id": slug, "label": label})
    return models

try:
    creds = resolve(False)
except Exception as exc:
    out({"ok": False, "reason": "not signed in: " + type(exc).__name__ + ": " + str(exc)[:200]})
def ask_once(creds, version=None):
    try:
        return ask(creds, version)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
        return ask(resolve(True), version)

try:
    try:
        body = ask_once(creds)
        models = listed(body)
    except urllib.error.HTTPError:
        if provider != "openai-codex" or client_version == "0.0.0":
            raise
        models = []
    if not models and provider == "openai-codex" and client_version != "0.0.0":
        # The versioned ask was refused or listed nothing: the older, ungated question.
        body = ask_once(creds, "0.0.0")
        models = listed(body)
except urllib.error.HTTPError as error:
    detail = error.read().decode("utf-8", "replace")[:200]
    out({"ok": False, "reason": "the provider answered HTTP " + str(error.code) + (": " + detail if detail else "")})
except Exception as exc:
    out({"ok": False, "reason": "the provider could not be asked: " + type(exc).__name__ + ": " + str(exc)[:200]})
if not models:
    out({"ok": False, "reason": "the provider listed no models"})
out({"ok": True, "models": models})
`;

/** The live list for one provider in one Hermes home, never throwing. */
export async function liveModels(
  run: HermesPythonRun,
  home: string,
  hermesProvider: string,
  clientVersion: string = CODEX_CLIENT_VERSION,
): Promise<LiveModels> {
  let answer: { code: number; stdout: string; stderr: string };
  try {
    answer = await run(home, [LIVE_MODELS_PROGRAM, hermesProvider, clientVersion]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Hermes did not run' };
  }
  const line = answer.stdout.trim().split('\n').pop() ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Never pass stderr on: a traceback may quote the request it failed on.
    return { ok: false, reason: `Hermes's Python ended with code ${String(answer.code)}` };
  }
  const body = parsed as { ok?: unknown; models?: unknown; reason?: unknown };
  if (body.ok === true && Array.isArray(body.models)) {
    const models = body.models
      .map((item) => item as { id?: unknown; label?: unknown })
      .filter((item): item is { id: string; label?: unknown } => typeof item.id === 'string')
      // The name shown stays the id, as for every other provider; a person's own alias goes
      // on top of it (`Model.alias`).
      .map((item) => ({ id: item.id, label: item.id }));
    if (models.length > 0) return { ok: true, models };
  }
  return {
    ok: false,
    reason: typeof body.reason === 'string' ? body.reason : 'the provider listed no models',
  };
}
