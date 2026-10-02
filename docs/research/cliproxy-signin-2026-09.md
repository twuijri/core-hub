# Research: provider sign-in through CLIProxyAPI vs Hermes (and Hermes through the gateway)

Status: research, 2026-09-30. No product code. Everything in §7 is **proposed — owner to confirm**.

Facts were checked on 2026-09-30:

- CLIProxyAPI ("CPA") source at tag **v8.0.4**. It is also the latest release (published 2026-09-29).
- Hermes source at the pinned tag **v2026.9.24** (§132).
- The hub at `origin/main` (5fb7d414) and PR #229 (`feat/model-gateway`).
- The vendors' own pages.

Each claim carries a mark:

- **[V]** verified in source or an official page (link given);
- **[I]** inferred from source, not run;
- **[U]** unverified or secondary source.

Source links:

- CPA: `https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.4/<path>`, abbreviated `cpa:<path>`.
- Hermes: `https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/<path>`, abbreviated `hermes:<path>`.

---

## 0. The answer in short

1. **CPA's own sign-in is not the "device code everywhere" the owner hopes for.** In v8.0.4 its management API offers a short code only for **xAI, Kimi and Meta**.
   - **Claude, ChatGPT/Codex, Antigravity and Devin** use a browser redirect to a `localhost` callback. On a server that means "open a long URL, copy the address bar, paste it back".
   - Codex has a device-code login only as a **command-line flag** of the binary. The hub could run it as a child process, as it already does for Kimi Code and Grok Build (§106).
   - **Gemini CLI, Qwen and iFlow are gone from CPA.** They were removed on 2026-06-18, 2026-04-15 and 2026-04-17 respectively.
2. **CPA does give the provider-card dialog most of what the owner wants.** Per account it reports status, the last error message and the time it can be retried. It also reports success and failure counts, a 3 h 20 min request histogram, and when the token was last refreshed.
   - For Claude and ChatGPT it also reports **usage windows with reset times**, read passively from each answer's headers.
   - A live quota query exists only through plugins, or through a generic "call this URL with the account's token" endpoint. That endpoint is what CPA's own web panel uses against **undocumented** vendor endpoints.
3. **Routing Hermes through the hub gateway (the owner's direction) is feasible and worth doing for key providers.** Hermes already takes `providers:` blocks with `anthropic_messages`, `codex_responses` or `chat_completions` transports, and expands `${VAR}` in its config.
   - Most Hermes features survive if each model goes over its native wire (§6).
   - A few are lost or need rework: Codex images, the account's live model list, speech, embeddings and Codex app-server.
4. **Moving subscription sign-ins to CPA removes little code and no megabytes.**
   - Roughly 1.0–1.5k lines of TypeScript and Python could go.
   - About as much new code is needed for the CPA management client and the dialog.
   - The image size does not shrink: Hermes stays in the image, and CPA is already +22.6 MB from #229.
   - Nous Portal and MiniMax sign-ins must stay with Hermes, because CPA cannot do them.
5. **Terms, honestly.** The terms risk depends on which vendor account the sign-in uses and which programs then use its tokens. It does not depend on whether the sign-in is a device code or a redirect.
   - **Anthropic** forbids using Free/Pro/Max OAuth outside Claude Code and Anthropic's apps [V]. **Google** ended consumer Gemini CLI login and bans Antigravity OAuth in third-party tools [V]. Neither should be offered through CPA.
   - **OpenAI** launched an official "Sign in with ChatGPT" plan-usage program on 2026-09-29, with per-app client IDs and per-app weekly caps [V]. Hermes Agent is a launch partner [V]. Both CPA and Hermes v2026.9.24 still sign in with the Codex CLI's own client ID, which is not that program [V].
   - Serving one subscription to Hermes *and every agent* raises volume and concurrency. That is exactly what "ordinary, individual usage" clauses are about.
6. **Recommendation (§7):** one door for models, with a terms policy per provider.
   - Hermes goes through the hub gateway like every agent. It starts with key providers, behind a switch, and existing hubs are unchanged.
   - CPA becomes the one holder of **key providers and of the subscriptions whose terms allow it**: xAI and Kimi by device code, and ChatGPT by device code through the CPA binary.
   - Claude and Google subscriptions are **not** offered through CPA. Claude Code keeps its own sign-in.
   - Nous and MiniMax stay with Hermes.
   - The provider-card dialog is built from CPA's management API.
   - Apply for Core Hub's own "Sign in with ChatGPT" client ID. Core Hub is Apache-2.0, so it qualifies for the open-source path.

---

## 1. CPA sign-in, per provider (v8.0.4)

### 1.1 What is in and what is gone

- In v8.0.4 the management API's login endpoint accepts `claude`, `codex`, `antigravity`, `kimi`, `kimi-ai`, `xai`, `devin`, `meta`, or a plugin provider id. Vertex is an import of a service-account file [V] (`cpa:docs/management-api-v8.md` §OAuth).
- **Removed** [V] (commits in `router-for-me/CLIProxyAPI`):
  - Qwen, `8fac2963`, 2026-04-15;
  - iFlow, `f5dc6483`, 2026-04-17;
  - Gemini CLI, `78ba8ba7`, 2026-06-18. The same day Google ended consumer Gemini CLI login (§5).
  - The file store now **skips** `type: gemini` credential files (`cpa:sdk/auth/filestore.go` §readAuthFiles).
- The Google subscription left in CPA is **Antigravity** (`cloudcode-pa.googleapis.com`).

### 1.2 Flow per provider

"Paste-back" means the person opens a long authorization URL, the browser lands on a `localhost` address that does not load, and they copy that address back into the hub. CPA accepts it at `POST /v8/management/oauth/callback {"redirect_url": "..."}` [V] (`cpa:internal/api/handlers/management/oauth_callback.go`).

| Provider | Management API flow | Callback | CLI flag | Short code from the hub's web UI on a headless server? |
|---|---|---|---|---|
| `claude` (Claude Pro/Max) | PKCE redirect [V] | `http://localhost:54545/callback` [V] (`cpa:internal/auth/claude/anthropic_auth.go`) | `-claude-login` (waits for the callback; offers paste after 15 s) | **No**: paste-back only |
| `codex` (ChatGPT) | PKCE redirect [V] (`auth_files_provider_oauth.go` §RequestCodexToken) | `http://localhost:1455/auth/callback` [V] (`cpa:internal/auth/codex/openai_auth.go`) | `-codex-login`; **`-codex-device-login`** = device code [V] (`cpa:sdk/auth/codex_device.go`; prints `Codex device URL:` / `Codex device code:`) | Via the management API: paste-back. **Via a child process running `-codex-device-login -no-browser`: yes** [I] |
| `antigravity` (Google) | PKCE redirect [V] | `http://localhost:51121/oauth-callback` [V] | `-antigravity-login` | **No**: paste-back |
| `kimi` / `kimi-ai` | **Device code** [V]: the response carries `flow: "device"`, `user_code`, `expires_in` | none | `-kimi-login`, `-kimi-ai-login` | **Yes** |
| `xai` (SuperGrok / Premium+) | **Device code** [V] | none | `-xai-login` | **Yes** |
| `meta` | **Device code** [V] | none | `-meta-login` | **Yes** |
| `devin` | PKCE redirect [V]. Devin insists on `http://127.0.0.1:<CPA port>/callback` (`auth_files_devin_oauth.go`) | CPA's own port | `-devin-login` | **No**: paste-back |
| `vertex` | Upload a service-account JSON: `POST /v8/management/oauth/import?provider=vertex` [V] | none | `-vertex-import` | Yes (file upload, no sign-in) |

How a remote login runs through the management API [V] (`cpa:docs/management-api-v8.md`, `oauth_sessions.go`):

1. `GET /v8/management/oauth/auth-url?provider=<p>` returns `{url, state}`. Device-code providers also get `flow: "device"`, `user_code` and `expires_in`.
2. `GET /v8/management/oauth/status?state=<s>` returns `wait`, `ok` or `error`.
3. For redirect providers, `POST /v8/management/oauth/callback` with `redirect_url`, or with `code` + `state`.
4. `DELETE /v8/management/oauth/session?state=<s>` cancels.

PKCE sessions give up after 5 minutes. The session lifetime is sized for device flows ("xAI ~30m, Kimi ~15m").

`is_webui=true` makes CPA listen on the provider's callback port on `0.0.0.0` inside CPA's host and forward the callback [V] (`auth_files_oauth_callback.go` §startCallbackForwarder). This only helps when the person's browser runs on the same machine as CPA: the desktop app, yes; a Docker server, no.

**Which work from the hub's web UI on a Docker server with a short code:**

- **xAI, Kimi and Meta**, directly through the management API;
- **ChatGPT**, by running the CPA binary with `-codex-device-login` as a child process. The hub reads the code from its output, as §106 already does for `kimi login` and `grok login --device-auth` [I].
- Claude, Antigravity and Devin need paste-back. The hub's contract already has `accepts_code` and `completeProviderSignIn` for that. Older apps never show a paste box, so those providers would have to be offered only to clients that support it (§7.4).

---

## 2. How CPA keeps tokens

- **Where** [V]:
  - one JSON file per account in `oauth.auth-dir`. The default is `~/.cli-proxy-api`; the hub would point it under `<DATA_DIR>/gateway/`.
  - Files are written `0600` (`cpa:sdk/auth/filestore.go`).
  - Postgres, git or an object store can be chosen by environment (`PGSTORE_*`, `GITSTORE_*`, `OBJECTSTORE_*`; `cpa:cmd/server/main.go`). The hub does not need them.
- **Format** [V]:
  - Claude: `type`, `access_token`, `refresh_token`, `id_token`, `email`, `account_uuid`, `organization_uuid`, `expired`, `last_refresh` (`cpa:internal/auth/claude/token.go`).
  - Codex: the same plus `account_id` and `plan_type` (`cpa:internal/auth/codex/token.go`).
  - Optional top-level fields steer routing: `prefix`, `priority`, `weight`, `proxy_url`, `note`, `disabled`, `model_aliases`, `cloak_mode`.
  - File names come from the email plus organisation, account or plan, so **many accounts per provider** coexist.
- **Refresh** [V]:
  - a background worker pool, 16 workers by default (`oauth.auth-auto-refresh-workers`);
  - each provider has its own lead time: Claude 4 h, Codex 24 h before expiry (`cpa:sdk/auth/*.go` §RefreshLead);
  - a manual refresh is `POST /v8/management/credentials/refresh`.
- **Several accounts** [V] (`cpa:config.example.yaml` §routing):
  - `routing.strategy`: `round-robin` (default), `weighted-round-robin` or `fill-first`;
  - optional session affinity, so one conversation stays on one account;
  - retries across accounts on 403/408/429/5xx (`request-retry`, `max-retry-credentials`);
  - a **cooldown** on the account, or on one of its models, after a quota or rate-limit error, until the provider's reset time;
  - a credential `prefix` pins requests like `h12/gpt-5.5` to that account. PR #229 already uses prefixes for provider rows (`h<row id>`).
- **Caution** [I]: OpenAI and Anthropic rotate refresh tokens. The same account's refresh token must not be held by both Hermes and CPA: whichever refreshes second is logged out. Moving a sign-in means signing in again in CPA, not copying Hermes's file (§7.4).

---

## 3. The management API: what the provider-card dialog can show

### 3.1 Access and stability

- **Auth** [V] (`cpa:config.example.yaml` §management, `cpa:docs/management-api-v8.md`):
  - `management.secret-key` is written in plain text and hashed at start-up. Every request needs it (`Authorization: Bearer …` or `X-Management-Key`), even from localhost.
  - An **empty key turns the whole management API off** (404). That is how PR #229 runs it.
  - `allow-remote: false` (the default) accepts only localhost.
  - Wrong keys lead to an IP ban. Behind reverse proxies that ban had bugs (issues [#4013](https://github.com/router-for-me/CLIProxyAPI/issues/4013) and [#4733](https://github.com/router-for-me/CLIProxyAPI/issues/4733)), which do not matter on loopback.
  - **Bound to loopback with a random secret only the hub knows**, as #229 already does for the client key: yes [I].
- **Stability** [V]:
  - `/v8/management` appeared with v8.0.0 on 2026-09-27, three days ago. `/v0/management` is kept.
  - CPA releases about daily: v7.3.18 to v8.0.4 took four days.
  - The hub must pin the version (it does, by SHA-256) and cover every management call it uses with a contract test against the real binary, as `model-gateway.real.test.ts` does.

### 3.2 Per account: `GET /v8/management/credentials`

Each entry carries [V] (`cpa:internal/api/handlers/management/auth_files.go` §buildAuthFileEntryLocked):

- identity: `auth_index`, `name`, `provider`, `label`, `email`, `account_type` / `account`, `project_id`, the id-token claims (for ChatGPT: the plan);
- health:
  - `status` and `status_message` (the last failure in words), `disabled`, `unavailable`;
  - `next_retry_after` (when a cooling account is tried again);
  - `last_refresh`, `created_at`, `updated_at`;
- traffic: `success` and `failed` totals, and `recent_requests`, **20 buckets of 10 minutes** (the last 3 h 20 min) of success and failure counts (`cpa:sdk/cliproxy/auth/types.go`);
- **passive quota**, `quota.signals` + `quota.observed_at`, and per model `model_quotas`. These are copied from the provider's response headers on the last answer, for `claude`, `codex` and `devin` only (`cpa:sdk/cliproxy/auth/quota_signals.go`):
  - Claude: the `anthropic-ratelimit-unified-*` headers (utilisation and reset of the 5-hour and 7-day windows) and `retry-after`;
  - Codex: `x-codex-primary-*` and `x-codex-secondary-*` (used percent and reset of the short and weekly windows), `x-codex-plan-type`, `x-codex-credits-*`, `x-codex-limit-reached`.
  - They only exist after at least one request went through that account.

### 3.3 Live quota

- `POST /v8/management/credentials/quota/fetch` answers only when a **plugin** registers a quota provider, or when the credential carries a declarative `quota_probe`. Otherwise it returns `501` [V] (`cpa:internal/api/handlers/management/plugin_quota.go`). No built-in provider has one in v8.0.4.
- CPA's own web panel, the Management Center (MIT), gets quota another way. It calls `POST /v8/management/requests/api-call` with the account's `auth_index` and a `$TOKEN$` placeholder, which CPA replaces with that account's token [V] (`cpa:internal/api/handlers/management/api_tools.go`). The vendor endpoints it calls [V] (`Cli-Proxy-API-Management-Center: src/utils/quota/constants.ts`) are **all undocumented by the vendors**:
  - Claude: `api.anthropic.com/api/oauth/usage` and `/api/oauth/profile`;
  - ChatGPT: `chatgpt.com/backend-api/wham/usage` and `/backend-api/subscriptions`;
  - Antigravity: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`;
  - Kimi: `api.kimi.com/coding/v1/usages`;
  - xAI: `cli-chat-proxy.grok.com/v1/billing`.
- The hub could do the same through `api-call`, so the token never leaves CPA. It should be labelled "best effort": such endpoints change without notice.

### 3.4 Errors and usage

- **Error events** [V] (`cpa:sdk/cliproxy/auth/error_events.go`, `cpa:internal/redisqueue/queue.go`):
  - Each failed upstream call produces `{timestamp, provider, model, auth_index, status_code, body, code, retryable, auth_status{…next_retry_after, quota{exceeded, reason, next_recover_at}}}`.
  - They go into an **in-memory queue** read with `GET /v8/management/observability/usage/queue?count=N`. **Reading removes them.**
  - Items are kept 60 s by default (at most 3600 s), only while usage statistics are on.
  - The hub would poll the queue and keep the last N errors per account itself.
- **Error log files** [V]: `GET /observability/logs/errors` and `/errors/<name>`, at most 10 files, only while `request-log` is off. There is also `GET /observability/logs/requests/<id>`. Application logs need `logging-to-file`.
- **Usage**:
  - CPA "no longer ships built-in usage statistics since v6.10.0" [V] (README).
  - `GET /observability/usage/api-keys` gives success and failure counts per client key.
  - Token counts arrive only through the same queue.
  - The hub's gateway already reads usage from every answer and writes it to the ledger (#229). **The hub stays the ledger; CPA supplies account health and quota.**

### 3.5 Actions for the dialog [V]

- `POST /credentials/refresh`: refresh the token now.
- `POST /routing/cooldown/reset`: clear a cooldown.
- `PATCH /credentials/status`: disable or enable an account.
- `PATCH /credentials/fields`: prefix, priority, note, weight.
- `DELETE /credentials`: sign out, deleting the file.

---

## 4. Compared with today's sign-in through Hermes

| | Hermes (v2026.9.24), used by the hub (§55) | CPA v8.0.4 |
|---|---|---|
| **Providers with a sign-in** | In the web dashboard, by device code: **Nous Portal**, **ChatGPT/Codex**, **xAI**, **MiniMax** (device code with a PKCE binding) [V] (`hermes:hermes_cli/web_server_oauth.py` §_OAUTH_PROVIDER_CATALOG). Terminal only: Qwen (reads the Qwen CLI's login), GitHub Copilot, and **Anthropic, kept out of the dashboard on purpose**. The code comment says an HTTP button minting Claude subscription tokens would go "against its OAuth usage policies"; the card is labelled "Required Extra Usage Credits to Use Subscription" [V]. | Claude, ChatGPT/Codex, Antigravity, Kimi, xAI, Meta, Devin (§1) |
| **Flow** | Device code for all four. That is what the hub shows today: a short code and a link. | Device code only for xAI, Kimi and Meta; ChatGPT only by CLI flag; the others by paste-back |
| **Client identity** | ChatGPT: the **Codex CLI's OAuth client ID**, with a `hermes-cli/<version>` user agent. xAI: the Grok CLI's public client (`grok-cli:access` scope) [V] (`hermes:hermes_cli/auth_constants.py`) | The **same two client IDs** [V]. It also **"cloaks"** requests: it sends non-Claude-Code clients to Anthropic disguised as the Claude Code CLI, and does the same for Codex, unless switched off [V] (`cpa:config.example.yaml` §cloak, `disable-claude-cloak-mode`, `disable-codex-cloaking`) |
| **Storage** | Hermes's own auth store in the Hermes home of the profile that signed in | One `0600` JSON file per account in `auth-dir` (§2) |
| **Several accounts** | Hermes has a credential pool, but the hub signs in one account per provider row | Any number, round-robin with cooldown and failover (§2) |
| **Who uses the tokens** | Hermes. The hub's `direct` agent **borrows** it for one turn (§118, `signed-in-chat.ts`). The live model list (§83, `live-models.ts`) and the ChatGPT images (§84, `image_api.py` `codex` protocol) do the same. **Never given to coding agents** (§140: "Hermes-held subscriptions are never upstreams"). | Whatever calls CPA: with #229, every coding agent the gateway serves |
| **Agents' own sign-in** | Separate (§106): Kimi Code `kimi login`, Grok Build `grok login --device-auth`, run by the hub, kept by the agent | n/a |
| **Updates** | Releases every 3–7 days (9.7, 9.11, 9.14, 9.21, 9.24) [V]; the hub pins one (§132) | About daily [V]; the hub pins one (#229) |
| **Account's live model list** | The hub asks the provider itself through Hermes's Python (§83) | A **curated catalogue**, embedded or fetched from `router-for-me/models` [V] (`cpa:internal/registry/*_updater.go`), **not the account's own list**. That would be a regression against §83 unless the hub asks through `api-call` (§3.3). |

**Overlap:**

- Both do ChatGPT and xAI, with the same vendor client IDs.
- Only CPA does Claude, Antigravity, Kimi, Meta and Devin.
- Only Hermes does Nous and MiniMax.
- So Hermes's sign-in cannot be retired entirely while the Nous and MiniMax presets exist.

**"They keep up with the providers' latest methods":**

- True for CPA's cadence.
- Hermes also moves fast, and it is **already adopting OpenAI's official program**. Open PR [#128926](https://github.com/NousResearch/hermes-agent/pull/128926) adds an `openai-chatgpt` provider with dynamic client registration and the `chatgpt.tokens.use.direct` scope [V]. CPA has nothing like it.

---

## 5. Terms and ban risk, honestly

**The flow type does not change the risk.** A device code and a redirect produce the same tokens from the same vendor account. The risk depends on three things:

- whose OAuth client the sign-in presents (a vendor's own CLI's client, or an app the vendor approved);
- where the tokens are then used (the vendor's own agent, or other agents and models);
- how much and how parallel the use is.

Device code is simply the better experience on a server.

| Vendor | What the vendor says | Reports | Vendor's own agent with its own sign-in | Routing the subscription to other agents or Hermes |
|---|---|---|---|---|
| **Anthropic** (Claude Free/Pro/Max) | "OAuth authentication … is designed to support ordinary use of Claude Code and other native Anthropic applications." "Anthropic does not permit third-party developers to … route requests through Free, Pro, or Max plan credentials on behalf of their users." "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". "Advertised usage limits … assume ordinary, individual usage". Enforcement "without prior notice" [V] ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). Since **2026-04-04**, subscriptions no longer cover third-party harnesses; such use draws from paid "extra usage" [V] ([VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and), [HN](https://news.ycombinator.com/item?id=47633568)). | A CPA user asked about bans ([#5343](https://github.com/router-for-me/CLIProxyAPI/issues/5343), no answer) [U] | **Allowed**: the unmodified Claude Code binary with the person's own sign-in, also where a platform hosts it [V] | **Not allowed** [V]. CPA's cloaking, which makes other clients look like Claude Code, is evasion and makes it worse. Claude Code pointed at CPA's Claude OAuth is also intermediation: the credential sits in CPA, not in Claude Code. **Do not offer.** |
| **Google** (Gemini CLI login, Antigravity) | Consumer Gemini CLI "Login with Google" **ended 2026-06-18**. The Antigravity terms forbid third-party tools using Antigravity OAuth [V] ([OpenClaw's Google page](https://docs.openclaw.ai/providers/google)). | **Ban waves.** Gemini CLI maintainers (2026-02-27): bans for "using third-party software, tools, or services to harvest or piggyback on Gemini CLI's OAuth"; reinstatement by form; **a second violation is permanent** [V] ([gemini-cli#20632](https://github.com/google-gemini/gemini-cli/discussions/20632), [openclaw#14203](https://github.com/openclaw/openclaw/issues/14203)) | Gemini CLI with its own login (Code Assist tiers, not consumer) [U] | **Not allowed; actively enforced.** Use an AI Studio key or Vertex. **Do not offer.** |
| **OpenAI** (ChatGPT Plus/Pro/…) | **"Sign in with ChatGPT" plan usage**, launched **2026-09-29** [V] ([RuntimeWire](https://runtimewire.com/article/openai-launches-login-with-chatgpt-and-routes-plan-usage-into-third-party-ai-app), [ChatGPT Learn](https://learn.chatgpt.com/docs/sign-in-with-chatgpt), [developer docs](https://developers.openai.com/siwc)). Apps need their **own client ID**. Open-source apps apply through an interest form ([open-source path](https://developers.openai.com/siwc/token-sharing-open-source)). The person sets a **weekly cap per app**. Sign-in is a loopback PKCE redirect to `127.0.0.1`, with **no device code**, one registration per account and host, calling `api.openai.com/v1/responses` ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)). **Hermes Agent, OpenCode, Pi, Devin and Warp are launch partners** [V]. | One user reported a ban without a known cause ([#3431](https://github.com/router-for-me/CLIProxyAPI/issues/3431)) [U]. I found no published OpenAI prohibition of the Codex-client route, and no ban wave [U]. | **Allowed**: Codex CLI or codex-acp signed in with ChatGPT is the product's intended use | **Grey today, sanctioned tomorrow.** CPA (and Hermes v2026.9.24) present the *Codex CLI's* client and headers, not an approved app. It works, but it is not the program OpenAI now offers. The clean way is Core Hub's **own** client ID (Apache-2.0, so the open-source path) with the person's per-app cap. |
| **xAI** (SuperGrok / Premium+) | A public device-code client with a `grok-cli:access` scope. Hermes publishes an official guide for it [V] ([Hermes guide](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth)). I found no xAI terms on third-party use [U]. | xAI refuses some tiers with 403 on the OAuth API [U] | Grok Build's own login (§106) | **Unclear, lower visible risk.** Offer it with a notice. |
| **Kimi** (Kimi Code plan) | CPA's README thanks Kimi "for supporting CLIProxyAPI" and links Kimi Code plans [V]. The plan is sold for coding agents [U]. | none found | Kimi Code's own login (§106) | **Low.** Offer it. |
| **Meta, Devin** | not researched in depth [U] | n/a | n/a | Leave out until checked |
| **Nous Portal** | Nous makes Hermes | n/a | n/a | Keep in Hermes |

**"One subscription sign-in serving Hermes and every agent":**

- It concentrates the whole hub's traffic, from several agents in parallel, plus cron and channels at night, on one personal plan.
- For OpenAI inside the official program that is what the per-app cap is for.
- Outside it (the Codex-client route), and for any vendor with an "ordinary, individual use" clause, heavy parallel use is the pattern most likely to draw attention.
- The honest summary for the owner:
  - Claude and Google: no.
  - ChatGPT: acceptable for the Codex agent itself. For Hermes and other agents, do it properly with Core Hub's own client ID. Until then it is the owner's own risk, clearly labelled.
  - xAI and Kimi: acceptable with a notice.

---

## 6. Hermes through the hub gateway (the owner's direction, 2026-09-30)

The owner already runs this by hand: an external CPA with every model, and Hermes pointed at it with an internal key. Here is how the hub would do it.

### 6.1 What the hub writes today

`models/propagation.ts` writes into each Hermes home [V]:

- `config.yaml`:
  - one `providers:` block per OpenAI-compatible provider row: `{name: <prefix>…, base_url, key_env, api_mode?}`, with `api_mode` today only `chat_completions` or `responses`;
  - `model.default` and `model.provider`;
  - `cron.model_provider` and `cron.model`, because of the provider snapshot issue (§119, Asim's report #217);
  - `fallback_providers`, and the image and speech keys.
- `.env`, and the environment of the running Hermes gateway: the keys under Hermes's variable names.
- Then the hub restarts Hermes's gateway (`service.ts` §propagate).
- A built-in vendor (`anthropic`, `gemini`, …) is written as Hermes's own provider plus its key. A signed-in provider is Hermes's own `openai-codex`, `xai-oauth` and so on.

### 6.2 What it would write instead ("Hermes on the hub's models")

- **Three gateway blocks per profile**, one per wire. Hermes allows one `api_mode` per block; it accepts `chat_completions`, `codex_responses` and `anthropic_messages` [V] (`hermes:hermes_cli/runtime_provider.py` §_VALID_API_MODES, `config_providers.py` §_API_MODE_ALIASES):
  - `<prefix>gw-messages`: `api_mode: anthropic_messages`, `base_url: ${COREHUB_GATEWAY_URL}/anthropic`;
  - `<prefix>gw-responses`: `api_mode: codex_responses`, `base_url: ${COREHUB_GATEWAY_URL}/openai/v1`;
  - `<prefix>gw-chat`: `api_mode: chat_completions`, the same base URL;
  - all with `key_env: COREHUB_GATEWAY_TOKEN`.
  - Hermes expands `${VAR}` and `${env:VAR}` in `config.yaml` values [V] (`hermes:hermes_cli/config.py` §_expand_env_vars). The gateway's random port can therefore come from the environment the hub starts Hermes with, and the file does not change when the port does. [I: not yet run against the `providers:` path.]
- **The block is chosen by the model's native wire**:
  - Claude-family models go on Messages, so Hermes keeps **prompt caching**. Hermes turns it on automatically for Claude "on native Anthropic, OpenRouter and anthropic_messages gateways" [V] (`hermes:agent/agent_init.py` §_init_prompt_cache_config).
  - OpenAI, ChatGPT and xAI models go on Responses (reasoning and tools native).
  - Everything else goes on Chat.
- **Real model ids, not per-turn aliases.** `model.default` is the gateway id of row + model (`h12/gpt-6-sol`), and so are `cron.model` and `fallback_providers`.
  - Hermes is long-lived: channels, cron at night, `/model` in a terminal. The per-turn `corehub-main` binding #229 uses for coding agents does not fit it.
  - The hub's pickers stay as they are, since the hub still owns the catalogue.
  - Hermes's own `/model` lists what the gateway's `/v1/models` offers that token.
- **One long-lived token per Hermes profile.** This differs from #229's per-session, 24-hour, memory-only tokens.
  - It is written to that profile's `.env` (`0600`) and the process environment.
  - It is bound to the profile, so the gateway serves only that profile's rows. Profile isolation stays as it is.
  - It is replaced when the hub restarts Hermes.
- **Gateway lifecycle**: it must be up whenever Hermes is, not "started on first need", because cron and channels run unattended.
- **Ledger**: Hermes's calls are counted by the gateway, per profile, and also per Hermes session when Hermes sends a session header [I]. This is new: today the hub does not see Hermes's own usage per call.
- **Escape hatch**: `fallback_providers` may end with a native Hermes provider, such as a direct key. If CPA is down, Hermes still answers [I].

### 6.3 What survives, per Hermes feature

| Feature | Through the gateway | Note |
|---|---|---|
| Chat, streaming, tools | Yes [I] | Native wire per block; CPA passes it through or translates it (proved for Claude Code and Codex in #229) |
| Reasoning effort | Yes on Responses and Messages [I]; on Chat through CPA's thinking layer [I] | Test per family |
| Prompt caching (Claude) | Yes on the Messages block [V for Hermes's side] | Lost if a Claude model were put on Chat |
| Vision (images in messages) | Yes [I] | Auxiliary vision defaults to the main provider (`auxiliary.*.provider: auto`) [V] |
| Auxiliary models (compression, titles) | Yes [I] | `auto` means the main provider, so the gateway |
| Cron | Yes, with the same `cron.model_provider` + `cron.model` fix (§119) | Still a `providers:` block |
| Fallback chain (§54) | Yes | Entries become gateway ids |
| **ChatGPT images** (§84) | **Needs rework** [I] | Today `image_api.py`'s `codex` protocol borrows Hermes's token. CPA serves `POST /v1/images/generations` and `/edits` for Codex accounts (`gpt-image-2`) [V: routes in `cpa:internal/api/server_routes.go`]. The hub would switch that protocol to plain OpenAI Images against the gateway. Needs a real test. |
| **Speech (STT/TTS)** | **Not through CPA** [V] | CPA has no `/audio/*` routes (only Codex realtime). Speech keeps going straight to the key providers, as today (§94) |
| **Embeddings** | **Not through CPA** [V] | No `/embeddings` route. Memory providers keep their own keys |
| Codex app-server runtime | **Lost** [V] | Needs Hermes's own `openai-codex` provider; the hub does not use it |
| Nous Portal, MiniMax sign-ins | **Stay native** [V] | CPA cannot sign in to them |
| **Account's live model list** (§83) | **Regression unless handled** [V] | CPA lists subscription models from its own catalogue. Keep §83 by asking the vendor through `POST /requests/api-call` (`$TOKEN$`), e.g. the Codex `…/codex/models?client_version=…` endpoint `live-models.ts` already uses |

---

## 7. Recommendation for Core Hub (proposed — owner to confirm)

### 7.1 Options

| | A. Keep as is (#229) | B. CPA does every sign-in, for everyone | **C. One door, with a terms policy per provider (recommended)** |
|---|---|---|---|
| Hermes | Signs in and talks to vendors itself | Through the gateway, every provider | Through the gateway for key providers and the allowed subscriptions; native for Nous and MiniMax |
| Subscriptions | Hermes only; the direct agent borrows | CPA, lent to everyone, Claude and Google included | CPA for ChatGPT, xAI and Kimi; **no** Claude or Google subscription; Claude Code keeps its own sign-in |
| Device code | Yes (4 providers) | No for Claude, Antigravity and Devin (paste-back) | Yes for every offered provider (ChatGPT through the CPA binary) |
| Dialog: usage, quota, errors | No | Yes | Yes |
| Terms | Safe (the owner's earlier rule) | **High risk** (Anthropic and Google forbid it; bans documented) | Stated per provider and shown on the card |
| Code | 0 | −1.5k / +1.5k | −1.0–1.5k / +1.0–1.5k |

C **reverses one earlier owner decision**: "don't lend subscriptions to other agents" (§140, "Rejected: lending Hermes-held subscriptions"). It does so only for providers whose terms are clear or sanctioned. That reversal is the owner's call, not ours.

### 7.2 Provider policy (a new catalogue fact: `subscription_use`)

- `vendor_agent_only`:
  - Claude: Claude Code's own sign-in, which the hub runs as in §106. Claude Code's login is a link plus a code pasted back, not a device code [U: not re-checked for this study].
  - Google: Gemini CLI's own login where still allowed [U].
- `hub_allowed_with_notice`: xAI, Kimi.
- `hub_allowed`: ChatGPT, **once Core Hub has its own Sign in with ChatGPT client ID**. Until then, `hub_allowed_with_notice`, with the card saying it uses the Codex client.
- `hermes_native`: Nous, MiniMax.
- Never offered: Antigravity, Claude subscription through CPA, Devin and Meta until checked.

### 7.3 The provider-card dialog (from §3)

Per account under the provider:

- **who**: email and plan;
- **health**: status, the last error message, "retrying at …";
- **the 3 h 20 min request histogram**;
- **usage windows with reset times**:
  - Claude: 5-hour and 7-day utilisation;
  - ChatGPT: short and weekly used percent with their resets;
  - shown with "observed at …", because they are passive (§3.2);
- a **"check now" button** that asks the vendor through `api-call` (best effort, undocumented endpoints; ChatGPT `wham/usage`, Kimi `usages`, xAI `billing`);
- **recent errors**: the last N from CPA's error queue, which the hub drains and keeps, joined with the hub gateway's own failed calls (status, provider message with any token redacted);
- **actions**: refresh token, reset cooldown, disable or enable, sign out.

Contract (additive):

- a new read operation (e.g. `models.getProviderHealth`);
- optional fields;
- absent on hubs without the gateway, so older apps are unaffected.

### 7.4 Compatibility (ADR 0027, no breaking changes)

- **Existing hubs keep Hermes exactly as it is.**
  - Hermes gets a `model_source` like the coding agents: `native` (today's behaviour) or `hub`. "Automatic" stays `native` on existing installs and becomes `hub` only on new ones.
  - The switch is per profile, and switching back restores the native blocks. The hub only ever removes the blocks it owns.
- **Existing Hermes sign-ins keep working.**
  - Moving ChatGPT to CPA is an explicit action: sign in again in CPA (device code), then the profile switches to the gateway.
  - Hermes's own sign-in is left in place until the person signs out of it, so rollback is one switch.
  - Refresh tokens are **not** copied between Hermes and CPA (rotation, §2).
- **Old apps:**
  - device-code providers use the existing `ProviderSignIn` shape unchanged;
  - paste-back providers are offered only to clients that say they support `accepts_code`, and are not in C anyway.
- **Rollback of the whole thing**: `COREHUB_MODEL_GATEWAY=off` (from #229) sends Hermes back to native blocks at the next propagation [I].

### 7.5 What code goes, and how much

Once phase 4 is done:

- `models/signed-in-chat.ts` (420 lines): the direct agent uses the gateway for signed-in rows too;
- the Hermes-Python path of `models/live-models.ts` (about half of 322 lines): replaced by `api-call`;
- the `codex` protocol of the two `image_api.py` scripts: replaced by OpenAI Images against the gateway;
- most of `models/sign-in.ts` (269 lines): it stays only for Nous and MiniMax;
- and their tests.

That is roughly **1.0–1.5k lines**. About the same is added: CPA management client, sign-in adapter, health operation and dialog. **Download size: about zero change.** Hermes stays in the image, and CPA is already paid for by #229 (+22.6 MB). The gain is one place for model access and the dialog, not size.

### 7.6 Phased plan (one engineer, rough)

| Phase | What | Effort |
|---|---|---|
| 0 (owner) | Decide the policy in §7.2. Fill OpenAI's Sign in with ChatGPT interest form for Core Hub (open-source path). | 0.5 d |
| 1 | **Hermes on the hub's models, key providers only**: long-lived per-profile tokens, always-on gateway, the three blocks with `${VAR}` URLs, `anthropic_messages` added to `HermesProviderRoute.apiMode`, ledger per profile, Hermes `model_source` (default `native` on existing hubs). Real-Hermes test through real CPA: chat, tools, a Claude model with caching, a Responses model with reasoning, cron, fallback. | 4–6 d |
| 2 | **CPA management on** (loopback, random secret, `0600`); sign-in adapter: xAI and Kimi by the management API's device code, ChatGPT by running `cli-proxy-api -codex-device-login -no-browser` as a child and uploading the result (`POST /credentials`). The allowed subscriptions become gateway upstreams for Hermes and the vendor's agent; others need `hub_allowed` and the owner's switch. Pin plus contract tests for every management call. | 4–6 d |
| 3 | **Provider-card dialog** (web first; iOS/Android follow the web in their polish passes). Error-queue drain, passive quota, "check now". | 3–4 d |
| 4 | Retire the borrowed-credential paths (§7.5); images through the gateway (real test); §83 live list through `api-call`. | 2–3 d |
| 5 (when granted) | Core Hub's own Sign in with ChatGPT client: loopback PKCE, which on a server needs paste-back of the `127.0.0.1` redirect [I]; `api.openai.com/v1/responses`; the person's per-app cap. | 3–4 d |

### 7.7 Risks

- **CPA churn**: v8 management is three days old and releases are daily. Mitigation: pin, contract tests on the real binary, bump by PR only.
- **A single point of failure for Hermes**: if CPA is down, all of Hermes's gateway models are down. Mitigation: supervision with backoff (#229), and a native fallback in `fallback_providers`.
- **Undocumented quota endpoints** break silently. Mitigation: passive headers first; "check now" labelled best effort.
- **Terms**: §5. The card states the policy; Claude and Google subscriptions are not offered.
- **CPA's model catalogue ≠ the account's list** (§83). Mitigation: `api-call`.
- **Refresh-token rotation** if a sign-in were ever copied. Mitigation: never copy; sign in again.
- **CPA reaches out**: it fetches model catalogues from `router-for-me` (off with `-local-model`, as #229 runs it) and still asks GitHub for the Antigravity client version (known from #229).

---

## 8. What the owner is asked to decide

1. Hermes through the hub gateway (§6): yes, starting with key providers, opt-in on existing hubs?
2. Subscriptions: the per-provider policy in §7.2. This reverses §140's "no lending" for ChatGPT, xAI and Kimi only.
3. Claude and Google subscriptions stay out of the hub (Claude Code keeps its own sign-in): confirm?
4. Apply for Core Hub's own Sign in with ChatGPT client ID?
5. The dialog's content (§7.3) and whether "check now" may call undocumented vendor endpoints.
