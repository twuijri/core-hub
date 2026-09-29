# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**370 of 370 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id. Measured on this
branch, 2026-09-27, by asking a booted hub which operations are still the
built-in stub — and `packages/server/tests/unit/status.test.ts` keeps this
number from claiming more than the hub answers.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 39 | 39 | Since 2026-09-27 **an archive can replace the default profile** (DECISIONS §116, proposed — owner to confirm): `auth.importProfile` with `replace_default: true` checks the whole archive, then — with Hermes's root gateway and TUI gateway held down — moves the default's Hermes home into a new profile `default-backup` (`-2`, `-3`, … whatever is free) and puts the archive in its place; what Hermes shares across profiles (task board, shared OAuth store, named profiles, logs) stays at the root, and the default workspace keeps its id, shared providers and keys and every hub row. Any failure puts every file and row back and the job says the import did not happen; web, iOS and Android offer it in the import dialog with a second warning (tested on the server with a real home on disk; not yet run against a real Hermes). Since 2026-09-27 **the client address is believed only from known proxies** (DECISIONS §96, proposed — owner to confirm): `X-Forwarded-For` counts only from a proxy the hub trusts — by default loopback and the private ranges, or the list `COREHUB_TRUST_PROXY` names (`false` for none, or a hop count) — and the client is the right-most address that is not such a proxy, so a client on the internet can no longer write its way past the sign-in, app-token and pairing lockouts; Socket.IO handshakes and the terminal's audit line use the same address (before, the raw peer: everyone behind a proxy shared one). The desktop app's Tailscale route forwards HTTP (WebSockets included) instead of raw TCP, drops a peer's own forwarding headers and names the tailnet peer in `X-Forwarded-For`. Since 2026-09-26 **messaging accounts** (DECISIONS §79, approved by the owner; the mechanism proposed — owner to confirm): a person proves a Telegram or WhatsApp account is theirs with a one-time code (`auth.createChannelLinkCode`, ten minutes, once) sent to their agent's bot as `/start <code>`, lists and unlinks their links (`auth.listMyChannelIdentities`, `auth.deleteMyChannelIdentity`), and an owner or admin lists and removes anyone's (`auth.listChannelIdentities`, `auth.deleteChannelIdentity`); one link per account for the hub (table `channel_identities`, migration `0025`). Before that: first-run setup, sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles — and since 2026-09-23 **a workspace is a Hermes profile** (ADR 0014): created in Hermes from scratch or as a copy, and Hermes's own profiles listed as workspaces. Since 2026-09-24 **a member enters only the profiles explicitly granted** — an empty list means none, a new profile is nobody's until granted (contract decision §29, migration `0010`). Since 2026-09-24 **a profile moves as Hermes's own archive** (stage 2): `exportProfile` is a job in which Hermes's own server (`hermes serve`, ADR 0015) writes the `.tar.gz`, the hub copies it leaving every `.env` and `auth.json` out and overwriting every provider key it stores wherever its bytes appear, and keeps it as a download for its requester alone for 24 hours; `importProfile` checks an uploaded archive (one top-level folder, no links, no paths outside it), has Hermes make the profile under the slug asked for, and adds the profile — a taken slug is refused before any job, Hermes's refusal comes back in its words (contract decision §34). Only where the hub supervises Hermes; elsewhere both answer `409 hermes_not_supervised`. Since 2026-09-24 **a conversation runs in its profile's own Hermes profile** (stage 3): every Hermes run — a chat turn, a resume, a fork, a task run, a workflow step, a title, and the questions and approvals inside them — opens its session in that profile's Hermes profile (its config, `.env`, SOUL, memory, skills, sessions) on the one TUI gateway, in the session's own folder under `/data/workspaces/<profile>/`; a workspace older than its Hermes profile gets one on its first run, as a copy of `default`; the hub's provider endpoints are declared in every profile and its keys reach every profile through the gateway's environment. With the agent pages acting on the selected profile's home (the `agents` row), stage 3 is done; a Hermes reached only over the network (no `hermes` beside the hub, so no TUI gateway) still runs everything in its own default profile. Since 2026-09-25 **a profile's automatic context compression is Hermes's own** (contract decision §57): `ProfileSettings.compression` (enabled, threshold, kept share, first/last messages kept, and the new `context_length`) is read from and written to that profile's `config.yaml` (`compression.*`, `model.context_length`) where the hub supervises Hermes — a write Hermes's file cannot take is refused (`409 runtime_config_unwritable`) and stored nowhere; Hermes applies it from the next turn; proven against the real Hermes (the window override is the window it reports). Before, these values were stored by the hub and never reached Hermes. Since 2026-09-25 **every profile, the default one included, can be renamed to any name** (contract decision §44): `updateProfile` writes the name to Hermes first as the profile's display name — `hermes profile rename default <name>` for the default one, `display_name` in `profile.yaml` for a named one — so `hermes profile list` / `show` say the same name; the id never moves where the hub mirrors Hermes (a new slug is refused `409 profile_id_fixed`, the folder is not renamed), a new or imported profile's name is written the same way, names are 1–64 characters (Hermes's limit), and an export's file is named after the name; proven against the real Hermes Since 2026-09-27 **profile names are read from Hermes** (DECISIONS §103, proposed — owner to confirm): a Hermes profile the hub adopts takes Hermes's display name, a display name changed on Hermes's side is taken on the next listing, and the name given at first-run setup is written as `default`'s. |
| sessions | 54 | 54 | sessions, messages, streamed runs, approvals, resume, fork, and the ten attachment operations (implemented by `knowledge`, which owns the bytes). Since 2026-09-27 (DECISIONS §102, proposed — owner to confirm) **`getContextBreakdown`** answers the window by category from Hermes's `session.context_breakdown` on a conversation the hub already has open (never opening one; `available: false` otherwise) — the shape checked against the pinned image's Hermes v0.21.3, the categories of a built agent read from its source, not yet seen from a real turn; and **`getRunChanges` on a run still going** answers what it has changed so far (`live: true`), the folder compared with the run's start at most every two seconds, recorded only at its end. Since 2026-09-27 **media plays from byte ranges** (DECISIONS §98, proposed — owner to confirm): `sessions.readFile` answers one `Range` (`206`, `416` past the end); a conversation's videos and sounds are listed as `video` / `audio` (preview cap 64 GiB); `sessions.createFileStream` gives a one-file, one-hour ticket (served by `knowledge.streamFile`) a player seeks through without the bearer; a reader that drops a streamed range no longer throws out of the hub (it did, for §90's attachment stream too). Proven by server tests and a browser journey that seeks a two-minute recording through `206`s. Since 2026-09-27 **hiding and deleting channel conversations** (DECISIONS §90, proposed — owner to confirm): `hideChannelConversation` / `unhideChannelConversation` keep a per-person, per-profile mark in the hub (the list leaves hidden ones out unless `hidden=include`), and `deleteChannelConversation` (owners and admins) deletes one from Hermes through Hermes's own `DELETE /api/sessions/{id}`, after reading the exact row and refusing anything that is not a channel conversation; audited. Proven against the scripted Hermes only (`channel-conversations.test.ts`), not yet against the real one. Since 2026-09-25 **session categories** (contract decision §60, proposed — owner to confirm): the four category operations — create, rename, reorder (`position`, kept `0…n-1`), delete (its conversations stay, each announced without a category) — and moving a conversation in or out with `sessions.update` / `bulkUpdate` (`category_id`; another profile's or an unknown category is `404`, never dropped). A category is the profile's, shared by everyone who may enter it; names unique per profile, at most 100; `listCategories?profiles=all` across profiles (ADR 0016). The web list shows them as collapsible groups above the loose chats (collapsed state kept per browser), a chat moves by dragging it onto a group's header or from its menu «نقل إلى تصنيف», and conversations of `source: channel` group by platform («تيليجرام»، «واتساب»). Since 2026-09-25 **Telegram and WhatsApp conversations fill those groups, read-only** (contract decision §61, proposed — owner to confirm): `listChannelConversations` reads them from Hermes's own session store through its internal server (ADR 0015) — per profile or across every permitted one (`profiles=all`), the other party's name or id, the latest message, its time and the message count — and `listChannelMessages` opens one as a transcript with the banner «محادثة من تيليجرام — للقراءة فقط؛ الرد يكون من تيليجرام»; the reply is made on the channel. Only where the hub supervises Hermes: elsewhere the list is empty and says why (`unavailable`). The hub asks Hermes again only when that profile's `state.db` changed, at most every 5 s; the web polls every 45 s while the list is open (Hermes announces nothing). Search filters them by name and title. Since 2026-09-25 **each run says which files it changed** (`listChanges`, `getRunChanges`, `getRunChangeDiff`, contract decision §49, proposed — owner to confirm): the working folder is recorded as the run starts it and compared when it ends — with git when the folder is in a repository or worktree (the folder written to a tree through a copy of the index, untracked files included, the person's index untouched), otherwise from a bounded snapshot with small text files kept to diff against — and the files, their added/removed lines and their diffs are stored with the run (migration `0016`), capped at 200 files and 2 MB of diff a run; the web draws «غيّر N ملفات (+a −b)» under the run's last reply and opens each file's diff beside the chat (unified, or side by side on a wide screen). Runs from before it recorded nothing and show no card; not yet tried against a real Hermes run. Since 2026-09-25 **a conversation's files open beside it** (`listFiles`, `readFile`, contract decision §48): the files its tool calls named (Hermes's and the ACP agents' paths), its working folder (bounded, hidden folders skipped) and its attachments, one list; a file is read only inside the session's own working folder, never through a symbolic link, with a preview limit per kind and the type from the name, sandboxed; a task's session is read the same way, in the folder its run works in (its git worktree when it has one). Since 2026-09-25 **compression and steering** (contract decision §57, proposed — owner to confirm): `compress` is Hermes's `session.compress` between turns (`409 already_running` while a run is alive or queued; on the session's run chain), bracketed by `context.compression` (`started` / `finished` / `failed`, `trigger: manual`) and followed by `context.updated`; Hermes compressing on its own inside a run is reported as `trigger: auto`. `steerRun` is Hermes's `session.steer` into the run in flight (nothing added to the transcript; `rejected` = send it as a message). `Session.context` is no longer always `null`: the window Hermes reports with every turn (`context_used` of `context_max`, and whether it counted roughly) is kept on the session. A message starting `/goal`, `/plan`, `/learn` or `/skill <name>` is carried out by Hermes's own `command.dispatch` (the plan prompt, the skill loaded into the turn, or Hermes's own output as the reply); the transcript keeps what the person typed. Proven against the real Hermes (plan, goal, compress, the window override); only over the TUI gateway — a Hermes reached only over the network answers `409 state_invalid` (`command_unsupported`). Since 2026-09-25 **the global agent** (`openGlobalAgent`, contract decision §46, proposed — owner to confirm): one standing conversation per person per profile (`source: global_agent`), made on first open with the agent given, never archived (`409 state_invalid`), a fork of it an ordinary chat. Since 2026-09-25 **a conversation reads as its trajectory** (`getTrajectory`, contract decision §43): every input, model turn, reasoning and tool call with its times, and only the metrics the hub has — the model's turns are recorded on each run from then on (migration `0015`), so older runs list their steps without times; `download=true` is the session log. Hermes's TUI usage is now recorded per turn (Hermes reports its live session's running total), and the OpenAI-compatible and Google adapters no longer count cached prompt tokens as input too. Since 2026-09-24 the list and search cross every profile the caller may enter (`profiles=all`, and `profiles: 'all'` on the socket — ADR 0016). Since 2026-09-24 **archiving a conversation stops its work**: `archived: true` (one or many) cancels every live run the way the chat's Stop does, so a task on that run goes back to `ready`; and a `before` cursor that is not a message of the conversation answers `404` instead of the newest page again (contract decision §31). Since 2026-09-25 **"Continue in Core Hub"** (`continueChannelConversation`, contract decision §62, proposed — owner to confirm): a channel conversation becomes an ordinary chat in the same profile, its transcript kept as a Markdown attachment and the chat's first message (a factual summary, the person's note and the transcript) answered for the client to send once it watches the chat. Since 2026-09-25 **subagents** (contract decision §56, proposed): `listSubagents`, `interruptSubagent`, `steerSubagent`, `tailSubagent` and the profile-wide `subagent.started` / `.updated` / `.completed`. Hermes reports every delegation on its TUI gateway and the hub stops, steers and reads one with Hermes's own `subagent.*` calls (`full`); Claude Code's `Task` and OpenCode's `task` tool calls are shown as subagents that start and end, nothing more (`observe`); Gemini CLI and Codex say nothing that marks a delegation (`none`), and `Agent.subagents` says which. A conversation keeps its last 50 in its metadata; one a restart cut short reads `interrupted`. The trajectory draws them in a `subagents` lane. Proven against a scripted TUI gateway and scripted ACP streams; not yet against a real delegation Since 2026-09-26 **naming a conversation offers the model no tools and leaves no Hermes session** (contract decision §92 note): over the TUI gateway the title is Hermes's own tool-free `llm.oneshot` on the conversation's model (the open conversation lends it, or a throwaway session in the same profile that never gets a prompt); an agent without such a call is not handed a turn — the model is asked directly through the hub's provider, or the first message names it; proven against the real Hermes (no tools in the request, nothing added to `session.list`). Since 2026-09-27 **channel conversations page and show pictures** (DECISIONS §103, proposed — owner to confirm): `listChannelConversations` takes `limit` (up to 1000 per profile, read from Hermes a page of 100 at a time) and says `has_more`; `listChannelMessages` pages back with `offset` / `next_offset`; a picture the person sent is `ChannelMessage.attachments` (its file name in Hermes's image cache, `available` while Hermes keeps it — a day) and `sessions.getChannelPicture` serves it from that cache only; Hermes's own notes about the picture are left out of the words. |
| models | 26 | 26 | providers, keys, catalogue, defaults, verification on save, speech (ADR 0010). Since 2026-09-26 **a new OpenAI speech-to-text row starts on `gpt-transcribe`** (DECISIONS §112): OpenAI retires `whisper-1` on 2027-02-26; a row that already exists keeps the model it holds. Since 2026-09-27 **`Model.image_only`** (DECISIONS §87, proposed — owner to confirm): the Images-API families (`gpt-image-*` — the subscription's too — DALL·E, Imagen, FLUX …) are marked, and the web leaves them out of every chat-model picker; they stay on the Images tab. Since 2026-09-24 **two provider scopes** (contract decision §37): a provider is every profile's (shared, stored under the default profile) or one profile's own, whose key goes into that profile's Hermes `.env` and wins there over a shared one of the same slug; a new profile has every shared provider at once, a copy of a profile takes its source's own providers with their keys, and an export «مع المزوّدين» carries the providers a profile uses (keys in the clear) which an import makes the new profile's own. Model choices stay per profile and fall back on the default profile's (`ModelDefaults.inherited`). Hermes's root home is the default profile's whoever saved, and each named Hermes profile's `.env` holds exactly the keys that differ from the root's — proven against the real Hermes. Every provider older than migration `0012` is its profile's own. Since 2026-09-25 **the fallback chain runs** (contract decision §54, proposed — owner to confirm): a turn whose model fails with an error another model could get past (a 5xx or `auth_unavailable`, 429, 408, no answer, unreachable — never another 4xx, never once it has started answering) moves down the profile's chain, set on the Defaults tab — for the `direct` agent in the hub, for Hermes as `fallback_providers` in the profile's `config.yaml`, which Hermes walks itself (proven against the real Hermes: `503 auth_unavailable`, the second model answers); the run names the model that answered and what failed before it (`Run.fallback`), and the chat and the Trajectory say so. And **provider sign-in by device code** (decision §55, proposed): Nous Portal, a ChatGPT/Codex subscription, xAI Grok and MiniMax are presets used by signing in; Hermes's own server performs the sign-in in the provider's scope and keeps the credential, the card shows the code and the link and polls until approved, and the models are Hermes's list for it — only where the hub supervises Hermes (`409 hermes_not_supervised` elsewhere). `completeProviderSignIn` answers `409 code_not_accepted` (none of them takes a pasted code); `transcribe` is still `501`. Since 2026-09-25 **speech works end to end** (contract decision §63, proposed — owner to confirm): `models.transcribe` is built — a recording (≤ 25 MB, `multipart/form-data`) goes to the profile's chosen speech-to-text provider through OpenAI's `audio/transcriptions` surface and its words come back, nothing kept; no provider is `422 no_stt_provider`, a silent take `400 no_speech`, a provider's refusal comes back in its words. A custom OpenAI-compatible speech server added as `stt`/`tts` needs no key for either direction. Proven against a scripted OpenAI and a real HTTP speech server on a loopback port. Since 2026-09-26 **the image model is a role** (contract decision §72, proposed — owner to confirm): `ModelDefaults.image`, a model that draws (`ModelCapability: image_output`, from the provider's word or the model's id) on one of the profile's own chat providers — no image providers of their own — chosen per profile and inherited from the default profile like the chat model (migration `0021` widens the role check, rows untouched). The hub writes it where the two things that draw read it: `COREHUB_IMAGE_PROVIDER/_BASE_URL/_MODEL/_API_KEY` in the profile's Hermes `.env` (root and named profiles, the root's also into the process; removed when none is chosen) for the `image-generate`/`image-edit` skills, and for Hermes's own `image_generate` tool its own backend `plugins/image_gen/corehub-images/` (listed in `plugins.enabled`, named in `image_gen.provider`; the hub takes back only what it wrote). Hermes ships no backend that takes an arbitrary OpenAI-compatible address, key and model, so the backend runs the same `image_api.py` the skills do: OpenAI Images API (`compatible`), a chat model that draws through `/chat/completions` (`chat`, e.g. `gemini-3.1-flash-image` behind cli-proxy-api) or Google's own API (`gemini`). The skills no longer take a hand-typed `COREHUB_IMAGE_API_KEY`; with no model chosen they answer `image_model_not_chosen` («اختر نموذج صور في النماذج ← الصور»). `image-edit remove-bg` cuts a subject out through the chosen model's edit endpoint (transparent from gpt-image, else on a flat colour that the bundled `image-convert transparent-bg` clears). Proven against scripted endpoints and a Python run of the backend with Hermes's interface stubbed, and since 2026-09-26 **in a real Hermes turn** in the image (`hermes-images.real.test.ts`, `tests/container/prove-images.sh`: a scripted upstream added as a chat provider, `gpt-image-1` on the Images API and `gemini-3.1-flash-image` answering on chat completions as cli-proxy-api does, Hermes's `image_generate` drawing through the backend, and the picture attached to the reply — Hermes saves it in its own cache, and the hub now copies it into the run's output folder; `image-generate` and `remove-bg` run in the container with both). Since 2026-09-26 also the owner's turn — `image_generate`, then `execute_code` copying the picture into the output folder as `flying_cat.png` (`tests/container/prove-reply-files.sh`): the picture is on the reply once (the hub drops its own copy when the agent kept the same bytes under its own name), and the agent is asked to name its files, not their path. Not yet tried against a real cli-proxy-api Since 2026-09-26 **a model list is the provider's own** (DECISIONS §83, approved by the owner): a provider signed in through Hermes is asked directly, from Hermes's Python with Hermes's token for that account (the ChatGPT subscription's `…/codex/models`, per plan; the others' `/models`); Hermes's remembered list is used only when the provider cannot be asked, and `catalogue.source = fallback` says so on the card. And **images through the ChatGPT subscription** (§84, proposed): `gpt-image-2` on the signed-in `openai-codex` provider is offered in Models → Images, and the image skills and Hermes's image tool draw, edit and cut out with it through the Codex backend's `image_generation` tool (`image_api.py` protocol `codex`, token asked of Hermes, never written). Tested against a scripted Codex backend and with the real Hermes from the image; not yet with a real ChatGPT account. Since 2026-09-26 the subscription's list is asked as the latest Codex CLI release (`client_version=0.157.0`): `0.0.0` answered a frozen list without `gpt-6-sol`/`gpt-6-luna`. Since 2026-09-27 **more speech providers** (DECISIONS §94, proposed — owner to confirm): Groq (groq.com — Whisper, and Orpheus TTS in English and Saudi Arabic with named voices, WAV only, 200 characters a request) comes with its chat key; ElevenLabs gains Scribe speech-to-text; Deepgram (Nova, Aura) and Azure Speech (every neural voice of every locale, fast transcription; resource key and region endpoint) are new. `models.listVoices` answers the provider's own list (ElevenLabs `/v2/voices`, Deepgram `/v1/models`, Azure's region list) or, for a provider with no list endpoint (Groq, OpenAI), its documented list from one editable file, with `source` saying which, narrowed by `model`; a synthesis longer than the provider takes is sent in parts cut at sentences and words and joined into one file; `SpeechRequest.model` lets the page preview before saving; a speech row keeps only its own kind of models; a family with a key on file lends it to a row added later (`ProviderPreset.key_on_file`). Hermes's own voice (`stt.provider` / `tts.provider`) follows the choice for Groq/OpenAI/ElevenLabs STT and OpenAI/ElevenLabs TTS; Groq TTS, Deepgram and Azure speak through the hub only. Proven against fake servers of each provider on a loopback port; not yet with real keys. Skipped: Google Cloud speech (no API-key authentication in its docs) and Edge read-aloud (undocumented, no terms for third-party use). Since 2026-09-26 (DECISIONS §110, proposed — owner to confirm) **a shared models catalogue** (`catalog/models.json`) is read by every hub from GitHub every twelve hours: per provider, its list when the provider cannot be asked (instead of the one built into the image), the ChatGPT subscription's image models (all five GPT Image models now), and a floor for the Codex CLI version, which also follows the newest openai/codex release — proven by server tests with stand-ins, not yet by a real account drawing with the 2.5 family. Since 2026-09-26 the catalogue **holds every provider with a fixed public list** (DECISIONS §110 addendum, proposed — owner to confirm): Anthropic, OpenAI, Google, DeepSeek, xAI and the Grok sign-in, MiniMax sign-in, Groq, Mistral, and the OpenAI/Groq/ElevenLabs speech presets, ids from each provider's own models and deprecations pages (OpenRouter, Nous, Deepgram skipped: lists public or per-account); a speech preset's list keeps its kind and replaces the image's documented Scribe list; a test fails CI on an unknown key or an id a hub would drop; and a weekly workflow (`models-catalog-watch.yml`) compares the file with CLI Proxy API's public catalogues and keeps one issue of differences — it never edits the file. |
| agents | 75 | 75 | Since 2026-09-30 **a coding agent gets an allow-list of the hub's environment, the ACP bridges are the renamed packages, and Claude Code's Skills page works** (DECISIONS §139, proposed — owner to confirm): an ACP agent, its sign-in and its `--version` check get only a base (`PATH`, `HOME`, locale, `TZ`, `TMPDIR`, `XDG_*`, proxy and CA variables, the desktop session, Windows essentials) plus the variables its catalog entry maps its keys to and documents it reading (`hostEnv`); `COREHUB_*`, `MAJLIS_*`, `HUB_*`, `DATABASE_*`, `TELEGRAM_*`, `DATA_DIR`, `PORT` never, and no program the hub starts (Hermes, npm) is given the hub's configuration keys any more — tested by starting every catalog agent as a fake program that writes out its environment. Claude Code is pinned to `@agentclientprotocol/claude-agent-acp` 0.84.0 and Codex to `@agentclientprotocol/codex-acp` 2.0.0; an install of the deprecated `@zed-industries` package keeps running under its old program name with its own version until the person takes the update, which installs the new one beside it and swaps only once it starts (a failed update leaves the old one) — checked with the real packages: installed, updated by the hub's installer, then `initialize`, `session/new` and a turn against a local fake Anthropic / OpenAI Responses endpoint named only in the environment (not yet on the owner's hub). Claude Code's Skills page lists, edits, switches (by renaming `SKILL.md`), pins, imports and deletes the skills in `~/.claude/skills` (`$CLAUDE_CONFIG_DIR/skills`), without Core Hub's library; other coding agents still answer `skills_are_hermes_only`. Since 2026-09-29 (evening) **a coding agent's MCP page works** (DECISIONS §138, proposed — owner to confirm): it answered 409 `state_invalid` for every non-Hermes agent; now the list/add/edit/switch/delete operations edit Claude Code's `~/.claude.json` `mcpServers` (under Claude Code's own `.lock`), Gemini CLI's and Qwen Code's `settings.json` `mcpServers` (read, not rewritten, when it has comments), a server switched off is kept by the hub in `<data>/agent-mcp/<agent>.json`; Codex, Goose, OpenCode, Kimi, Grok and Pi answer `mcp_not_managed` and the page points to their Config files; the "Core Hub tools" card reads and writes the profile's settings from any coding agent's page; Test and OAuth stay Hermes's. **An installed agent whose program has no `--version` is installed, not an error**: the version is its npm package's `package.json`; Claude Code and Codex are not run to check them; only a program that cannot start fails. **A coding agent's failed run says why and where to fix it** (the ACP error's data, or the bridge's stderr tail, secrets masked; Goose → its Config files, Claude/Codex/Gemini → Models, Kimi/Grok → sign-in), **its card says "Needs a provider or sign-in"** (`Agent.credentials`), and **the model picker names its default** (`Default · <model>`, or "Agent's own default"; `Agent.agent_default_model` from the agent's own settings) — web only; the phones still say "Default model" and show no badge. Since 2026-09-29 **an MCP server's tools show without pressing Test, and the agent can be limited to some of them** (DECISIONS §134, proposed — owner to confirm): the hub keeps each server's last test per profile (`McpServer.last_test`: tools, count, when, `stale` once the connection settings change) in `<data>/mcp-last-tests.json`, refreshed by Test and by an OAuth sign-in that lands; `McpServer.tool_filter` / `McpServerPatch.tool_filter` read and write Hermes's own `tools.include` / `tools.exclude` of the server's block (proven against real Hermes v2026.9.14 and v2026.9.24: only the allowed tools are registered). Web: the folded row counts the tools ("12 of 61 tools"), opening lists them with a box each and All / None / Read-only (read-only by the server's `readOnlyHint` when Hermes recorded one, otherwise the verbs in the name), a never-tested server is tested once by itself on first open. iOS and Android show the count and the list; **choosing tools on a phone is not built yet**. Since 2026-09-28 **the MCP page's rows fold** (owner request; web and Android): a press on a server's header opens what is under it (full address or command, OAuth Reconnect / Disconnect, the last test) and no longer opens the editor, which has its own Edit button beside Test; the web keeps which rows are open on the device and folds the "Core Hub tools" card the same way; a row that needs the person (error, expired or missing sign-in) starts open. iOS rows never opened the editor on a tap and are unchanged. Since 2026-09-27 **an MCP server signs in by OAuth from the hub** (DECISIONS §122, proposed — owner to confirm): `agents.startMcpOAuth` has Hermes start its own browser sign-in for a remote server in the selected profile after writing the hub's callback (`agents.mcpOAuthCallback`, public, at the address the client reaches the hub on) as the server's `oauth.redirect_uri`; `getMcpOAuthFlow` / `cancelMcpOAuthFlow` follow and stop it, `disconnectMcpOAuth` deletes that profile's sign-in files, and `McpServer.oauth` says connected / expired / not connected from the token file's metadata only — no token passes through the hub, is returned or is logged. Web: status chip, Connect / Reconnect / Disconnect on the MCP page, Connect offered under a test that failed for want of a sign-in. Tested against a scripted Hermes (server, web unit, Playwright); **never run against a real provider such as ClickUp**. A `headers` or `oauth` secret one level into a block now reads `[stored]` too. Since 2026-09-27 **agents from a pinned release download, and an agent's own account sign-in** (DECISIONS §106, proposed — owner to confirm): a catalog entry may install from the vendor's release file for the hub's platform, refused unless its SHA-256 is the pinned one, only the named executable unpacked, and the previous install replaced only after that; the catalog gains **Goose 1.52.0** and **Grok Build 1.0.41** this way (Linux x64/arm64 and macOS; installed and answering ACP `initialize` in the built image), and Goose's `config.yaml` on the Config files page. Kimi Code and Grok Build sign in to their own vendor account by device code from the agent's Settings page (`agents.startSignIn`, `agents.getSignIn`, `install.sign_in`): the hub runs the agent's own `login` command and relays its link and code; the agent keeps the credential. Since 2026-09-27 **presets** (DECISIONS §100, proposed — owner to confirm): an agent's settings in a profile saved under a name — the chat model and fallbacks, the agent's own model, skills and MCP servers on/off, the settings sections — never a secret; listed, read, deleted and **activated** through the same saves as the pages, as the caller, with what is gone since reported (`agents.listPresets`, `getPreset`, `createPreset`, `deletePreset`, `activatePreset`; table `agent_presets`, migration `0031`); the web shows them as a card on the agent's Settings page. Since 2026-09-27 **incoming webhooks** (DECISIONS §97, proposed — owner to confirm): `listWebhooks`, `createWebhook`, `deleteWebhook`, `testWebhook` manage Hermes's own webhook routes in the selected profile (`webhook_subscriptions.json`, the listener switched on in `config.yaml` bound to `127.0.0.1` on a port of the profile's own), and `receiveWebhook` (`POST /api/v1/hermes-webhooks/<profile>/<route>`, no bearer) is the public door the hub passes to Hermes byte for byte — the hub's address must be reachable from the internet, and the Channels page says so. Proven against the real Hermes gateway in the image: a route made through the hub takes a signed POST at the hub's door, Hermes answers `202` and the agent runs with the route's prompt filled in; a wrong signature is refused. Since 2026-09-26 **the header over WhatsApp's self-chat replies** (`setChannelReplyHeader`, DECISIONS §86, proposed — owner to confirm): the agent's name as the hub shows it (the default) or a typed title, written as `WHATSAPP_REPLY_PREFIX` in the profile's `.env` in the shape of Hermes's own «☤ *Hermes Agent*» header, the gateway following like any channel change; `ChannelLink.reply_title` reads it back (null = Hermes's own). A self-chat link, or a switch to self-chat, writes the agent's name where nothing is written; nothing is rewritten at boot. No "no header": Hermes's bridge sends its own header for an empty value. Proven against the real Hermes in the image (its adapter and its bridge's own formatting code). Since 2026-09-26 **WhatsApp's mode, and a link that answers at once** (DECISIONS §85, proposed — owner to confirm; the owner's report of 2026-09-26: linked with his personal number, «مربوط» but «غير متصل», no answer): `loginChannel` takes `mode` — `bot` (a number for the agent, other people message it and pair) or `self-chat` (the person's own number: only their «مراسلة نفسي» / "Message yourself" chat reaches the agent, nobody else is answered or sent a pairing code; the owner's number is added to `WHATSAPP_ALLOWED_USERS` as Hermes's own onboarding does) — and `setChannelMode` switches a linked number, with the gateway held down and started again; `ChannelLink.mode` says which (existing links keep `bot`). A link, or a mode change, now restarts the gateway that serves the profile **in the default profile too** (before, the default gateway kept running without the channel, so the card read `offline` until someone pressed Restart); since the same day **every channel change** — Telegram and the other platforms linked, their settings saved, switched on or off, cleared, unlinked — does the same, one restart per burst of changes a second apart, and `ChannelGateway.applies` is always `now` (§85 amended; the owner: a Telegram linked in the default profile stayed silent); `Channel.restart_needed` says when a running gateway does not serve a switched-on channel, and a Hermes platform still `connecting` reads `unknown`, not `offline`. Proven against the real Hermes in the image, with no network: Hermes's own `PUT /api/messaging/platforms/whatsapp` stores what the hub sends, and Hermes's gateway config and WhatsApp adapter then run the bridge in `self-chat` with the owner allowed and a stranger not; not yet tried with a real phone. Since 2026-09-26 **coding agents' config files** (DECISIONS §78, approved by the owner): `agents.listConfigFiles`, `getConfigFile`, `putConfigFile` — owners and admins only — read and write each coding agent's instructions and settings file (Claude Code `CLAUDE.md`/`settings.json`, Codex `AGENTS.md`/`config.toml`, Gemini CLI `GEMINI.md`/`settings.json`, Qwen Code `QWEN.md`/`settings.json`, Kimi Code `AGENTS.md`/`config.toml`, Pi `AGENTS.md`/`settings.json`; not OpenCode), one set for every profile in the home of the user the hub runs as, from a fixed list (no paths), with a stale revision refused, JSON checked, the previous version backed up, every write audited and 1 MiB at most; the image's home is now `/data/home`, inside the volume (proposed — owner to confirm). And **a message on a channel acts for the person who linked its sender** (DECISIONS §79): the hub writes a hook beside its MCP block into the profile's Hermes home (`hooks/corehub/`), Hermes's messaging gateway reports each turn's sender and a `/start` link code to `agents.hubChannelEvent`, and a call to the hub's tools from that gateway acts as the person who linked the sender — or is refused for a stranger, a group chat, or a person outside the profile; a gateway's call never borrows a live chat in the hub (`X-Corehub-Origin`). Proven against the real Hermes gateway in the image with a fake Telegram Bot API: `/start <code>` links the account and Hermes replies with the hub's words, the linked account's turn creates a task as the person, and a stranger's is refused while the person has a chat of their own running. Since 2026-09-26 **agent pictures** (DECISIONS §76, proposed — owner to confirm): `agents.update` stores an uploaded PNG or JPEG (512 KB) as `<DATA_DIR>/avatars/agents/<id>` — one per agent for the whole hub — and `agents.getAvatar` serves it; no web control to set it yet. And **the Journey** (`agents.getJourney`, DECISIONS §73, proposed — owner to confirm): Hermes's own learning graph for the selected profile — the skills the agent wrote or used and each memory entry, with Hermes's links and categories — read from Hermes's server (`/api/learning/graph`), only where the hub supervises Hermes; proven against the real Hermes in the image. No web page yet (no navigation entry). Since 2026-09-25 **the hub offers itself to its agents as MCP tools** (contract decision §67, proposed — owner to confirm): `agents.getHubTools` / `agents.updateHubTools` switch, per profile and off by default, six groups — tasks (list, create, move, assign, comment), schedules (list, create, pause, run now), conversations (list, search, summary), notifications (notify the person), workflows (list, run), files (list, read, write in the profile's folder) — each reading once on and writing only when its own switch allows; on, the hub writes one `corehub` block into the profile's Hermes `config.yaml` (bearer from `${COREHUB_MCP_TOKEN}` in the profile's `.env`), puts it back at boot, and the generic MCP routes refuse to touch it; `agents.hubMcp` (`POST /api/v1/hub-mcp`) is the Streamable HTTP endpoint. A call acts only while a run of the hub's is live in that profile, as that run's owner, through the REST routes with a run token that enters that profile only and is never an admin; several people running at once are told apart by the agent's own announcement of the call, or the call is refused. A coding agent over ACP gets the same server in `session/new` when it can reach HTTP MCP servers. Proven against the real Hermes (v2026.9.14 in the image): Hermes connects, lists the tools (behind its `tool_search` bridge) and a chat turn with a scripted model calls `tasks.create` through `tool_call` — the task is on the board as the person's; Hermes's own MCP test lists them. Since 2026-09-27 the **`devices` group** (§89, ADR 0025; off until an admin switches it on): `devices.list`, `list_folder`, `read_file`, `fetch_file` (the file goes on the reply), `run_status`, `locate` (the phone's place, §105, since the phones' parity work), and the writes `write_file`, `open`, `run` (a program's tool on the person's own computer; a long call answers `running` and is followed with `run_status`). Not built: `browser` and `usage` groups. Messages arriving on a channel use the tools as the person who linked the sender (§79, above). Before that: registry, curated catalog (Hermes, the hub's own `direct` agent, seven coding CLIs — since 2026-09-25 also Qwen Code, Kimi Code and Pi, each pinned and checked to answer ACP `initialize`), install/remove/upgrade, discovery, restart, per-agent settings. Since 2026-09-25 **updates** (DECISIONS §68, proposed): every six hours and on `checkUpdate` the hub asks npm/PyPI for each installed agent's newest stable version without installing it, an update installs that exact version, the pin stays the tested baseline (`pinned_version`, `newer_than_tested` — «أحدث من النسخة المختبرة»), and the per-agent `auto_update` (off by default) updates only an idle agent while new runs of it wait. Not yet checked: a real turn of the three new agents in the image. And since 2026-09-23 the three Hermes tool pages that are **files in the agent's own home**: skills (`skills/<slug>/SKILL.md`, written verbatim so a pack's front matter survives), MCP servers (one block of `config.yaml`, edited in place with the comments kept) memory (`SOUL.md` at the profile home; since 2026-09-24 `memories/MEMORY.md` and `memories/USER.md`, where Hermes itself reads and writes them — earlier the page wrote them at the profile root, where Hermes never looks; those files are moved into `memories/` once at boot and on the next memory read, nothing dropped. The two lists are written the way Hermes round-trips them (entries separated by a `§` line) and a write that would grow one past the profile's character budget is refused with `memory_too_long`; proven against the real Hermes both ways) and channels (`platforms:`, whose fields are read from the file rather than from a form the hub wrote). Since 2026-09-24 **plugins** are Hermes's own, per profile: `listPlugins`, `updatePlugin`, `installPlugin` (a `plugin_install` job; Hermes fetches, scans and installs it switched off) and `deletePlugin` run Hermes's `hermes plugins` command against the selected profile's home, with Hermes's own status words (`enabled`, `disabled`, `not enabled`) — Hermes's dashboard plugin routes take no profile, so they could only ever reach the default one; what Hermes ships is switched, never removed; only where the hub supervises Hermes. The agent's **Jobs** page is the agent's schedules in the selected profile (for Hermes, the jobs in Hermes's own scheduler), read from `schedules.list` and acted on with the schedules operations — no operation of its own. **Skills in category folders** (`skills/<category>/<name>/SKILL.md`, where Hermes keeps its built-in skills) are listed under their category with its `DESCRIPTION.md`; the ones Hermes seeded from its bundle (`.bundled_manifest`) are `builtin` and read-only (`409 skill_bundled`); proven against the real Hermes. Presets were parked (DECISIONS §80) and are built since 2026-09-27 (§100, above). Since 2026-09-24 the four pages act on **the selected profile's** Hermes home (`profiles/<slug>`, the root for the default one; a profile Hermes does not have says so), and the three live tools work: `testMcpServer` has **Hermes** connect to the server and list its tools (Hermes's own `/api/mcp/servers/{name}/test`, ADR 0015), `loginChannel` pairs **WhatsApp by QR** through Hermes's onboarding as a `channel_login` job whose progress carries the code, and `importSkills` installs an uploaded `SKILL.md` or zip into the profile's `skills/`, byte for byte, checked by Hermes's reading rules, all or nothing. The first two need a Hermes the hub supervises; Telegram's bot-creation flow is not a QR pairing and is not built | Since 2026-09-24 **every Hermes profile with a messaging channel has its own gateway**: the hub supervised one `hermes gateway run`, which serves the default profile only, so a WhatsApp paired in another profile was never answered (the owner's report «سويت رستارت وراسلته ولا رد»). Now each named profile with a channel switched on and able to sign in, or with an active scheduled job of Hermes's own (Hermes fires a profile's jobs only in a gateway of that profile; checked every half minute, and after every Hermes schedule the hub writes), gets `hermes -p <profile> gateway run` (only the default gateway dispatches Hermes's one kanban board) (restarted with backoff, logged with the profile's name, without the API server, its WhatsApp bridge on a port of its own), started, restarted or stopped when a channel there is linked, switched, edited, cleared or unlinked, and on boot; a profile with neither gets none (about 200 MB each). Hermes's Restart restarts all of them and its card lists each one's state. Before any gateway starts — the default one too — the profile's `config.yaml` is given the hub's endpoints and the model its chat default resolves to, so a gateway no longer answers «Provider authentication failed» (`Unknown provider 'corehub-…'`). A WhatsApp Hermes paired reads as **linked** with its account (from the session folder, not config fields) and can be **unlinked** (`unlinkChannel`: the gateway held down, the session deleted, the channel switched off). **Pairing approvals**: `listPairing`, `approvePairing`, `denyPairing`, `revokePairing` — Hermes's own pairing API in the selected profile, except Deny, which removes the one request from Hermes's pending file because Hermes has no verb for it (contract decision §38). In the default profile a channel change still waits for Hermes's Restart, except linking WhatsApp and changing its mode (§85). Since 2026-09-24 **Telegram links from the web** in the selected profile (`linkChannel`): the person makes a bot with @BotFather (Hermes's outside bot-creation service is not used), the hub checks the token with Telegram's `getMe`, stores it in that profile's own Hermes `.env` (never returned) and switches the channel on with pairing for strangers; a named profile's gateway starts at once, the default one's at Hermes's Restart; `unlinkChannel` covers Telegram. **Telegram settings** (`getChannelSettings`, `updateChannelSettings`): every user-facing option Hermes has for it — who may message, show the model's thinking, tool progress, streaming, quoting, reactions, groups and mentions, voice notes (marked as shared with every channel of the profile), home chat, command menu, proxy — read and written where Hermes reads each one (the profile's `config.yaml`, or its `.env`) Since 2026-09-25 **Hermes's Settings page is Hermes's own keys in the selected profile** (contract decision §58, proposed — owner to confirm): turn limit, run time limit, tool-use enforcement and default reasoning effort; the two memory budgets; approvals of dangerous commands and of the agent's memory and skill writes; the proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` in the profile's `.env` — Hermes's only, the hub does not use it) and hiding ids and phone numbers from the model on messaging channels (`privacy.redact_pii`) — read from and written to the profile's `config.yaml` (comments kept) and `.env`, each with Hermes's default, never stored by the hub; the four hub-stored sections it showed before are gone. Saving retires the TUI gateway (conversations take the values from their next message) and restarts a named profile's messaging gateway; the default profile's proxy runs Hermes's Restart. **Memory and skill writes waiting for review** (`listPendingWrites`, `approvePendingWrite`, `rejectPendingWrite`): Hermes's own `pending/` queue per profile, approved by Hermes's own code; approving needs a Hermes installed beside the hub. Proven against the real Hermes: its own loaders read every value back, and a staged memory entry and skill are applied. Hermes has no automatic session reset by time, so there is none.. Since 2026-09-25 **more platforms link like Telegram** (`listChannelPlatforms`, contract decision §64, proposed — owner to confirm): a catalog of every platform the hub links, each declared once (credential variables, whether the hub can check them, pairing or allowlist, settings, where its library comes from). **Discord, Slack, Matrix, Mattermost and Email** link by their credentials through `linkChannel`, each checked with the platform first (Discord `/users/@me`, Slack `auth.test` and `apps.connections.open`, Matrix `whoami`, Mattermost `/users/me`, Email an IMAP and an SMTP sign-in) and named once linked; each has its settings (mentions, threads, allowed channels or rooms and people, home channel, reasoning and tool progress) written where Hermes reads them, and `unlinkChannel` forgets them. Pairing is switched on for Slack, Matrix and Mattermost; Discord and Email answer only an allowlist, because Hermes's adapters drop strangers there. Twenty-one other Hermes platforms (Signal, SMS, Feishu, DingTalk, WeCom, WeCom Callback, Weixin, QQ, Yuanbao, LINE, Google Chat, Teams, Home Assistant, ntfy, IRC, iMessage via BlueBubbles, iMessage via Photon, WhatsApp Cloud API, SimpleX, Raft, Buzz — the last five since 2026-09-26, DECISIONS §77) link through a form of the variables Hermes reads, stored unchecked, with no settings panel; `ChannelPlatform.program` names the outside program Raft and Buzz need, which the image does not carry. Proven against the real Hermes: its own loader reads what the hub wrote, and a profile's gateway starts Discord and Slack with nothing installed. Since 2026-09-25 **Core Hub ships its own skill library** (decision §71): twelve skills in `packages/server/skill-library/` (four for images: generate, edit/vary, describe/OCR, resize/crop/convert; and summarise, report/memo with RTL-correct Markdown, CSV/Excel to table and chart, sourced web research, Arabic↔English translation, HTML slides, schedules in plain language, proofreading), installed into every profile's `skills/core-hub/` at boot and when a profile is made — where the hub runs Hermes itself — and on request elsewhere. A manifest of hashes in the profile means only files the hub wrote are ever updated; an edited skill is `library: edited`, kept, and put back only by `agents.restoreSkill`; `agents.updateSkillLibrary` switches the library off or on per profile Since 2026-09-27 **skills as Hermes lists them** (DECISIONS §103, proposed — owner to confirm): switched on and off in the profile's own `skills.disabled` list (built-in skills too; `hermes-agent` never off), and a skill whose `platforms` leave out the hub's system is not listed. |
| updates | 7 | 7 | release channels, publishing from an upload or a source URL the hub fetches itself, check, download with `Range`, settings whose token never comes back |
| jobs | 5 | 5 | list, get, cancel, with `/rt/jobs` events. Since 2026-09-25 **the Background panel** (contract decision §56, proposed): `background.list` gathers a person's own chat, task and schedule runs, workflow runs, jobs and their conversations' subagents across every profile they may enter (`profiles=all`) — running, and what finished in the last 24 hours — and `background.stop` stops one the way its own screen would (a run's Stop, a workflow run's Cancel, `jobs.cancel` for the jobs that honour it: export, import, discovery, a channel login; a subagent where its agent can). A subagent that finished before the hub last started is not in its Finished list |
| meta | 2 | 2 | health, and `meta.get` — the hub's name, its build, the contract version it loaded, the realtime namespaces it actually opened, and whether it still needs an owner. Unauthenticated, because a client compares the contract version before it signs in |
| knowledge | 14 | 14 | `knowledge.listItems` — journal, notes and files in one page. Since 2026-09-27 (DECISIONS §98) `downloadWorkspaceFile` answers one `Range` and serves video and audio in place, `createWorkspaceFileStream` gives a player's ticket for a working file, and `streamFile` serves every file ticket with ranges. Since 2026-09-25 **the profile's working files** (contract decision §65, proposed — owner to confirm): eleven `knowledge.*WorkspaceFile*` operations, owner and admin only, over `${DATA_DIR}/workspaces/<profile>` and nothing else — list a folder, download a file (only pictures, PDF and plain text may be shown in place; everything else is bytes to save), a folder as a zip (links left out; ≤ 200 MiB / 20 000 entries, `413` before a byte), read and save UTF-8 text (≤ 1 MiB) with an etag save-conflict check (`409 changed` with the current etag), upload (≤ 25 MB, `409 exists` unless `overwrite`), new folder, move/rename, copy (capped like a zip, never half a copy), delete (the root never), and attach a file as an ordinary attachment for a chat. Every path is resolved and checked inside the root; `..`, absolute paths and symlinks that lead out (`/data/keys`, Hermes's home, another profile) are `400`; files are opened `O_NOFOLLOW` and the descriptor re-checked; every write is in the audit log (`workspace_file.*`). A file manager only — no shell, nothing runs a command. The web's «الملفات» / Files page (Settings → tools) is built on it; the attachment operations it also implements are counted under `sessions`, whose tag declares them. Since 2026-09-24 the same file can be uploaded again after a delete or under another name (it answered `500`): each upload is its own attachment over bytes stored once, removed with the last one (contract decision §39) |
| audit | 5 | 5 | the Usage and Skills usage reports (`getReport` answers `usage` and `skills` only since 2026-09-26: its `logs` and `performance` kinds, their `q`/`level` parameters, the minute-by-minute sampler and `performance_snapshots` are gone — contract decision §75, proposed — owner to confirm; no client asked for them any more). Since 2026-09-25 **a proper Usage page and Skills usage** (contract decision §50, migration `0017`): `audit.getUsage` aggregates the usage ledger and the runs in SQL by calendar day (the caller's, `utc_offset_minutes`) for 1–365 days, for the header's profile or every enterable one (`profiles=all`) and optionally one agent — totals with input/output/cache separated, cache hit rate and the price-based cost estimate only where something reported them (`null`, never zeros), conversations and their daily average, and per day, per model and per agent with shares; an agent that ran but reported nothing (coding agents over ACP) says so (`reports_usage: false`). `audit.getSkillUsage` reads what is now recorded — one row per skill a run loaded through Hermes's `skill_view` — with the top six skills per day, the ranking with share and last use, and the enabled skills never used (unknown for an external Hermes); `counting_since` is this install's own start, as past use cannot be rebuilt, and coding agents' skill use is not counted (ACP names no skill). `getReport` `skills` answers the same body instead of `501`. Since 2026-09-25 **Logs and Performance are live** (contract decision §51, proposed — owner to confirm; owners and admins only): `audit.listLogLines` reads bounded rings in the hub's memory — the hub's own lines and each Hermes gateway's, per profile, and the TUI gateway's — 5000 lines each, filtered on the hub by source, profile, least level and text, tailed by `seq`; a restart empties them. `audit.getLivePerformance` measures when asked: the host, the hub process (CPU, RSS, event-loop lag, uptime), every Hermes process the hub runs by pid, and each profile's active runs, conversations and sockets, with a few minutes of history; from `/proc` on Linux, and without process numbers elsewhere |
| plugins | 1 | 1 | what is installed on this hub — an empty list until an installer exists |
| tasks | 27 | 27 | Since 2026-09-29 **a new task on the web is written whole in a New task dialog** (owner request: a task with only a name is useless): the board header has one "New task" button (the bare title field is gone); the dialog sends everything `TaskCreate` takes — title, description, agent, priority, due, tags, project, subtasks, definition of done and constraints (left out, with a note, for a card given to Hermes), where it waits and `auto_start` — with an `Idempotency-Key` as the phones do, and "Start now" starts it right after through `assignTask(start: true)` with the chosen model (`TaskAssign.model`; `TaskCreate` has no model). The new card is ringed and brought into view; intake opens when it lands there. Not built: attachments at creation (the hub stores `attachment_ids` but no run or client reads them yet), and the hub does not replay `Idempotency-Key` yet. projects, the nine-column board with fractional ordering, subtasks, dependencies, comments, activity, worktree rows — and since 2026-09-23 **Hermes's own kanban on the same board**: read through `hermes kanban list` when the board opens, Hermes wins on every read, a move on a Hermes card is asked of Hermes first and a refusal comes back in Hermes's words, and a task given to Hermes goes on Hermes's board. And since 2026-09-24 **assigning starts the work**: `assignTask` with `start: true` opens a session of source `task` for the assignee (in the workspace's ordinary per-session folder), queues one run whose prompt is the task — title, brief, checklist as it stands, the instructions given — moves the task to `running` and answers `202` with the real job, run and session ids; when the run ends the task moves on its own (`review` with the agent's last words as the progress summary, `blocked` with the reason it failed, `ready` when stopped from the chat). Stop, unassign, reassign and a person's move out of `running` cancel the run for real; `dispatch` starts what it assigns; a restart settles the tasks it finds left `running`. Without `start` a task is only assigned and `TaskAssigned` answers `null` ids. A task given to Hermes is handed to Hermes's own board and never run by the hub. And since 2026-09-24 **Hermes's cards are fully editable from the board** when the hub manages Hermes: their title, description and priority, deleting them, comments (said on Hermes's card in the person's name; Hermes's own comments shown on the card), stopping their run and handing them to another workspace's Hermes profile all go through Hermes's own API (`hermes serve`, ADR 0015) — Hermes first, the reflection refreshed from Hermes's answer, a refusal in Hermes's words; opening the board starts that server in the background. Where the hub does not run Hermes (an external one), those writes are still refused as before. And since 2026-09-25 (DECISIONS §47) **a task works in its own git worktree**: a project's `working_dir` is a git repository inside the profile's folder, checked on write (`400` saying why, with git's words); starting one of its tasks makes a real `git worktree` on the branch `task/<short id>-<slug>` under `/data/workspaces/<profile>/worktrees/`, the row going `creating` → `ready`/`dirty` or `error` with git's own message (and then the task does not start, `409 worktree_failed`), and the task's session works there, so Hermes and the ACP coding agents get it as their working directory; deleting or archiving the task (the weekly archive too), deleting its project, or `deleteWorktree` removes it and keeps the branch, and it comes back on the same branch. A task without a repository keeps the session's own folder. And **`auto_start` works**: a task that becomes `ready` and assigned (created so, assigned, moved to Ready, or switched on) starts on its own, at most `COREHUB_TASK_AUTO_START_MAX` (2) such runs at once per profile, the rest waiting their turn; stopping it switches it off, and one that cannot start goes to `blocked` saying why. Since 2026-09-27 (DECISIONS §93, proposed — owner to confirm) **auto-start waits for dependencies**: a task set to start on its own does not while anything in its `depends_on` is not done, and starts itself when the last one reaches `done`; a person's "assign and start" is not held back (the web warns first), and a card and its details say what it waits for (`Task.waiting_on`). A **stuck-task watchdog** on the scheduler's tick marks a running task whose run has shown no activity for `COREHUB_TASK_STUCK_MINUTES` (30, proposed; 0 off) with `stuck_since` and sends its owner one notice; nothing is stopped. `task.moved` from the move route now carries `from`, `to` and `actor` (webhooks got the task alone before), and the board counts the archive without sending it — the web reads it when "Show archived" is pressed. And since 2026-09-24 (ADR 0016 stage 2, DECISIONS §32) `listTasks` takes `profiles=all` (one keyset over every profile the caller may enter), the board answers `profiles=all` too, a card's `assignee.name` is the registry's (it used to be the id), `dispatch` and the two worktree operations answer the contract's `JobAccepted` (`{job_id}`), and Hermes's board is read whenever anyone opens the board, not only someone who may enter the default profile. Since 2026-09-25 a started task **reports into its project's room** (`report_room_id`): a line from the hub when its run starts and when it ends. Since 2026-09-27 (proposed — owner to confirm): **a definition of done and constraints** on a task (DECISIONS §104) — two lists written with the task, sent in the run's prompt, ticked by the reviewer at review, cleared by a new run, refused on a Hermes card (and folded into the brief of a hub task handed to Hermes); and on Hermes's cards (DECISIONS §103) **Hermes's own history** in `TaskDetail.hermes` (its events and runs, newest first) and **bulk priority and a bulk comment** (`TaskBulkUpdate.patch.comment`), Hermes first. |
| schedules | 35 | 35 | Since 2026-09-29 **a Send message step chooses how Telegram reads its words** (DECISIONS §137, proposed — owner to confirm): `WorkflowSendTarget.formatting` `plain` (the default and every older step: no `parse_mode` at all), `html` (`parse_mode: HTML`) or `markdown_v2` (`parse_mode: MarkdownV2`), any other value refused (`send_formatting_unknown`); a refusal of the markup fails the target in words naming the mode, never resent plain; a long formatted message is split on what Telegram counts with the open spans closed and reopened so each part is valid, each part remembered as before; the output adds `formatting`, `parse_mode`, `chat_id`, `parts_count` and per-target `targets`; an older phone saving without the field keeps it. Web: a selector, the preview's "Telegram formatting: HTML" label and a formatted preview (Telegram's tags only), and the test sends with it; iOS/Android show and change it. Since 2026-09-29 **an agent step can talk in the same conversation every run** (DECISIONS §136, proposed — owner to confirm): `WorkflowNode.conversation` (`mode` `new` — the default — or `reuse`, `session_id` a conversation id or a template, `create_if_missing` off by default, `title`); the hub checks the conversation is in the run's profile, open to the acting person and has the step's agent (another profile's is `not_found`), fails the step with the reason when it is missing unless asked to make it (then made once, the step repointed, the inbox told), serializes turns into one conversation (prompt, reply, prompt, reply; a bounded 10-minute wait, then the step fails as busy), fills `WorkflowStep.session_id` and the new `message_id` for every agent step and lets later steps read `{{steps.<id>.conversation_id|message_id|run_id|status}}`; `schedules.checkWorkflowConversation` is "Test conversation". Web: picker first, paste an id second, test, create-if-missing; phones show the mode and id read-only and keep them. Since 2026-09-29 **"Send test message" is never silent** (DECISIONS §135, proposed — owner to confirm): the web shows sending / sent with where and the message id(s) / Telegram's or the hub's error / no answer in 90 s, says in words why the button is off, and fences each editor panel so an error never blanks the page; the hub logs one line per test and per real send (workflow, step, profile, target, status, message id or error — never the token) and cuts invisible direction marks out of chat ids; `WorkflowSendTest` gains optional `workflow_id`/`node_id` for that line. Since 2026-09-29 **"Send test message" fills the step's variables first** (DECISIONS §133, proposed — owner to confirm): `testWorkflowSend` takes optional `values` / `workflow_run_id`, renders with the run's own `expr.ts` code and refuses `template_unresolved` (naming each variable) instead of sending `{{…}}`; web asks a value per variable, fills them from the last run, previews the text and keeps Send off until each is filled; iOS/Android ask for typed values, preview and block (last-run values on phones: follow-up). Runs unchanged. — schedules with a real `next_run_at` (cron, interval, once, in the schedule's own timezone), run history, workflow definitions with validation, workflow-run history and cancel, and workflow import preview/confirm — and since 2026-09-23 **Hermes's own cron on the same page**: a schedule for the Hermes agent is created, edited, paused, deleted and fired *in Hermes's scheduler* through its `/api/jobs`, so it really runs; jobs Hermes made itself appear too, Hermes wins on every read, and the runs Hermes reports land in the history. And since 2026-09-23 **workflows run**: `runWorkflow` and `rerunWorkflowFromNode` walk the drawing step by step — `condition`, `delay` and `notify` done by the engine, `agent` as a real turn in a session of its own (source `workflow`), each step's output readable by the next as `{{steps.<id>.output}}`; cancel stops a run at once, a restart fails the runs it cut short, and conditions and templates are checked when the workflow is saved. And since 2026-09-24 **the hub fires its own schedules** — every schedule whose agent is not Hermes (the `direct` agent, a coding agent) and every workflow schedule: a scheduler claims each due tick with a compare-and-set on `next_run_at` plus a history line unique per tick, so a moment fires once across restarts and concurrent looks; the run is a session of source `schedule` in the schedule's profile, as its owner, with its prompt (or the workflow, with the schedule in `{{trigger}}`); the history line carries the session (or the workflow run) so the page opens it, and settles with the run — last status, last error, the repeat count and limit. The next time is computed from the moment of firing, in the schedule's own timezone; a paused schedule is never due. Since 2026-09-24 **each schedule has two run options** (the owner's decision; DECISIONS §40): *run if missed* (`run_if_missed`, off by default) — a tick up to two minutes late is on time and runs; later, it runs once if the option is on and the hub is back within 24 hours, and is otherwise recorded as skipped with the reason — and *if the previous run is still going* (`overlap`): `skip` (recorded), `wait` (the default: runs as soon as the previous run ends, at most one waiting, a further one recorded as skipped), `parallel` (a run of its own alongside) or `replace` (the previous run is cancelled for real, then the new one starts). "Run now" always starts at once and stops nothing. A time still waiting when a restart ends the run it waited for follows *run if missed*. Existing schedules got the defaults (off, `wait`) by migration `0014`. Hermes's own schedules have neither — Hermes decides both per profile, not per job — and a write that sets one is refused (`409 hermes_run_options`). `runNow` starts that same run at once and answers the real ids (`session_id`, `run_id` or `workflow_run_id`; DECISIONS §35); a target that cannot start is a failed line and `409 target_unavailable`. **Workflow `approval` steps are built**: the run pauses (`waiting`), an ordinary approval of kind `workflow_step` is raised — listed by `/approvals`, announced profile-wide, in the owner's inbox — approve continues from that step, deny fails it with the reason given, a cancel closes it, and a run waiting at one survives a restart (its place is written down). Any step with `approval_required` waits the same way before it works. Since 2026-09-24 `schedules.list` pages for real (the `cursor`/`limit` it always declared, one keyset over every profile) and takes `profiles=all`; Hermes's cron is read whenever anyone opens the page Since 2026-09-25 **a drawing is checked before it is saved** (`validateWorkflow`, DECISIONS §52, proposed — owner to confirm): the same rule saving applies, answered as findings each naming its node or edge with a stable code; `listWorkflows` takes `profiles=all`; each step of a run says what it produced (`output`) and which edges it followed (`route`); and an agent step's own model reaches its turn. Since 2026-09-25 (contract decision §53, proposed — owner to confirm) **a workflow run has limits**: a time budget, a cost budget (USD, the hub's per-turn estimate summed over the agent steps) and a per-step timeout, set on the workflow (`limits`) or on one run (`runWorkflow` `limits`, or the older `timeout_ms`); the engine enforces them — the time and cost budgets stop the run at once, cancelling the step working then (an agent's run stopped as the chat's Stop does), a step past its timeout fails and its `failure` edge may take it — and the run says which limit stopped it (`stopped_by`), what it cost (`cost`) and the limits it ran under; waiting at an approval counts toward none. And **`previewTrigger`** answers the next times a trigger would fire, from the same calculation as `next_run_at`, without saving. Since 2026-09-28 (DECISIONS §121) **`validateWorkflow` checks a drawing that has no name yet** (its body is `WorkflowCheck`, `WorkflowWrite` with the name free); saving still needs a name, and the web, iPhone and Android editors no longer show a check error on a new, unnamed workflow. Since 2026-09-28 (DECISIONS §123, proposed — owner to confirm) **a workflow can be started from outside**: inbound triggers with a stable public address (`clickup`, `github`, `generic_hmac`, `token` signature presets over the raw body), repeats and unwanted events dropped, a delivery log, a test event, runs that carry `event_id`/`task_id`, and a condition step with several rules (`all`/`any`) whose "no" ends the run as filtered. Since 2026-09-28 (DECISIONS §124, proposed — owner to confirm) **a "Send message" step** sends to Telegram through the profile's own bot and/or posts in a Core Hub conversation (made again under the same title if it was deleted), split for Telegram's limit, never sent twice when tried again, with `schedules.testWorkflowSend`. Since 2026-09-28 (DECISIONS §127, proposed — owner to confirm) a run says its **phase** (received, analyzing, needs input, approved, executing, completed, failed), a workflow can **alert on failure** (inbox and/or Telegram or a conversation), and **one step can be tried with a sample** (`schedules.testWorkflowStep`); the end-to-end guide is `docs/guides/clickup-agent-flow.md` |
| rooms | 28 | 28 | several agents and people in one room (DECISIONS §69, proposed — owner to confirm). Since 2026-09-25: rooms are made (with their first seats), listed (the caller's own; archived apart with `archived=true`), read, renamed, archived, cloned and deleted; a room is its **members'** — its maker manages it, others join by an **invite code** (eight letters and digits, link `<hub>/join/<code>`, rotated by the manager) that opens a room only to someone who may already enter its profile, and anyone else gets `404`; members leave or are removed, the maker stays. **Seats** are agents with their own name (`@name`, unique in the room, `all` reserved), role, instructions and model, each with a conversation of its own in `sessions` (source `room`, left out of the chats list), refused before it exists when the agent cannot take turns; the first seat is the room's **lead**, which will answer a message that mentions nobody. **Messages** are stored with structured mentions (`@all` only when the room allows it), paged backwards, and announced on `/rt/rooms` to the room's members, who join its channel (presence = `Member.online`) and send typing. Seat presets are saved and listed with whether their agent can run. And **agents answer in the room**: the seats a message mentions (or the lead when it mentions nobody, or every seat for `@all`) each take a turn in their own conversation, told only what they have not seen yet (the newest 30 messages at most); the reply streams into the room with the seat's status (queued, thinking, replying, waiting for an approval) and its tools; a reply that mentions another seat **hands it the next turn**, in a chain the guard stops at a repeated pass (a loop) or the room's depth cap (default 3), which a person may let go one more round (`continueHandoff`); `stopSeat` stops a seat's turns, `listRuns` is the room's queue and history, `listHandoffs` its chains, and `clearContext` makes the agents forget (fresh conversations, tokens reset) while the messages stay. The **room's summary** is carried by every seat turn and rewritten every N messages (`summary_policy.every_turns`), on request (`refreshMemory`, a job) or by hand (`putMemory`) — written by the lead agent when it can answer a one-shot question, by the hub itself (the previous summary and a line per new message) when it cannot. And a **task's progress reports into its project's room** (ROADMAP Phase 1): a project with `report_room_id` gets a line from the hub when one of its tasks' runs starts and when it ends. Proven against scripted agents, and on 2026-09-25 **against a real Hermes in the image** (`tests/container/prove-rooms.sh`: two Hermes seats, a mention, Hermes's reply passing the turn, the second seat answering, the summary asked of Hermes) with a scripted upstream model — not yet with a real model provider. Since 2026-09-27 (DECISIONS §99, proposed — owner to confirm) **a message carries pictures and files** (`image` / `file` blocks of the room's profile, handed to each seat's next turn), and **what a seat asks names its room**: `Approval.room_id` is set for a seat's own conversation and `RoomDetail.pending_approvals` lists them (both were always empty); the web's composer does not attach files yet |
| devices | 33 | 33 | Since 2026-09-27 **push follow-ups** (DECISIONS §107, proposed — owner to confirm): a browser's Web Push ends with the sign-in that registered it and the web hands the subscription back silently after the same person signs in (permission still granted, subscription still held); `device.updated` when the hub drops a registration on its own (sign-in ended, dead token); the iOS and Android apps send the relay's device proof (`relay_proof`) from a per-install P-256 key (Keychain / Keystore), which the hub forwards; iOS drops its APNs registration when the hub ends its sign-in. Since 2026-09-27 **linked hubs** (ADR 0026, DECISIONS §101, proposed — owner to confirm): one Core Hub linked to another by a single-use 10-minute invite, the other owner's request and this owner's approval; Ed25519 keys on both sides, every hub-to-hub call signed over method, path, time, nonce, body and recipient, with replays refused; each side lists the agents the other shares (off until switched on) and a person asks one a single question, answered by its model without tools, files or memory; per-peer on/off and questions per hour, revoke at once, an audit log on both sides (`listPeers`, `requestPeer`, `updatePeer`, `deletePeer`, `createPeerInvite`, `listPeerEvents`, `listPeerShares`, `setPeerShare`, `listPeerAgents`, `askPeerAgent`, and the hub-to-hub `peerJoin`, `peerNotice`, `peerAgents`, `peerAsk`; migration `0031`); the web page is Settings → Linked hubs. Since 2026-09-27 **the way in from outside** for a hub the desktop app runs (`getRelay` / `setRelay`, DECISIONS §95, proposed — owner to confirm): the person's own Cloudflare Tunnel (token sealed by the OS keychain, `cloudflared` fetched at a pinned version and SHA-256 and run by the app) or their Tailscale network (the app listens on the tailnet address only); the hub asks the app over IPC and keeps no secret; any other hub answers `available: false` / `409 relay_unavailable`; a pairing made while it is open gives the phone its address (`connection: relay`). Tested with a fake app, a fake `cloudflared` and a fake release server; **never run against a real Cloudflare tunnel or tailnet**. Since 2026-09-27 **an agent reaches the person's own computer** (ADR 0025, DECISIONS §89, proposed — owner to confirm): a computer reports what its helper offers (`Device.helper`: shared folders, the default `~/Core Hub`, programs switched on with their profiles and tools) and its person narrows the profiles that may ask it (`Device.profiles`, null = all; migration `0029`); an agent's run token may make `files` and `apps` requests to its own person's computer, and since §105 `location` requests to their phone (the phone asks its person first), and nothing else; a computer that is not connected is answered "offline" at once; waits are per capability (`files` 60 s, `apps` 120 s). **Stream tickets** (§90): `createAttachmentStream` / `streamAttachment` play one attachment with `Range` from a one-hour ticket, without the bearer. Proven end to end in the server suite with the desktop's own code and a stand-in for Resolve's integration (`tests/unit/device-programs.e2e.test.ts`); never run against a real Resolve. Since 2026-09-26 **the Core Hub push relay** (ADR 0024, DECISIONS §82, proposed — owner to confirm): FCM or APNs with no credentials on this hub goes through a relay the owner runs on Cloudflare Workers (`packages/push-relay`), which holds his APNs and FCM keys as Worker secrets. The hub registers itself on first need (the secret sealed), binds each phone's token to itself there, signs every call (HMAC, timestamp, nonce), forgets a token the relay calls gone, and re-states the tokens it still wants when they change (sign-outs included); local credentials always win. Status on each FCM/APNs row of `listPushSenders` (`source: relay`, `relay.state`: ready, not registered, unreachable, blocked, rate-limited, off, no address), `setPushRelay` (admin: off switch, **private push** — a generic title and the notice id only), `COREHUB_PUSH_RELAY_URL`, `COREHUB_PUSH_RELAY=off`; migration `0027`. Tested against a fake relay and the relay against fakes of APNs and FCM; deployed on 2026-09-27, and since 2026-09-28 `DEFAULT_RELAY_URL` is the relay's free workers.dev address (owner's choice, so a domain change never cuts phones off); the apps do not send the device proof yet. Since 2026-09-26 **device cards** (DECISIONS §81, proposed — owner to confirm): a device reports its OS version, its model by marketing name and what stops its push (`push_blocker`) when pairing or registering and again at each launch (Android and iOS; unit-tested, iOS on the CI simulator; never run on a real phone); a name a person gives a device survives re-pairing (`renamed_at`, migration `0026`); `last_seen_at` also counts the calls of the sign-in that registered a device (a password sign-in, a browser), at most once a minute. The web's Device connections is **one page**: pairing at the top, then every device as a card grouped by kind (icon, name, model, OS and app versions, last active as a relative time with the exact one in a tooltip, paired date, push state, This device, rename / test / remove), always loaded from the hub, so a phone paired there is still listed after leaving the page; for an admin the push senders are folded at the bottom and set up **from their files** (APNs `AuthKey_<Key ID>.p8`, Key ID from its name, the bundle id offered by the hub; FCM the service-account JSON, `google-services.json` named and refused), the APNs key checked by signing an ES256 token before it is stored. Since 2026-09-26 **capability requests** (`/device-requests`, DECISIONS §74, proposed — owner to confirm): a person asks one of their own paired devices for a capability (their web session, or their token with the `device` scope; nobody else's device, an admin's neither); only that device hears `request.created`, answers once (`fulfilled` in its capability's shape, `denied`, `failed`), and the `device_request` job follows — succeeded, failed, or expired after `timeout_ms`; a capability the device never offered is declined by the hub. The job carries only the request id; a location stays in the request. Table `device_requests` (migration `0022`) replaces the unused `device_commands`. Not yet: an agent asking (the MCP `devices` group), and a push to wake a device that is not connected. since 2026-09-25 **the device registry and push** (contract decision §66, proposed — owner to confirm): `list` (own devices; an admin everyone's), `get`, `update` (rename, capabilities, app version — the device, its owner or an admin), `unlink` (the device is revoked with its push registration, and a paired app's token is revoked with it), and `register` for a client that is not a paired app (a browser, the desktop app signed in with a web session: the same `device_key` is the same row). `last_seen_at` is written when a paired device calls the hub (at most once a minute) and when its `/rt/devices` socket connects; `online` is a live socket, and `device.online` / `device.offline` are emitted. **Push**: `registerPush` / `unregisterPush` (the token sealed with the hub's data key, never returned), and every notice written to the inbox goes to the person's devices unless its kind's `push` switch is off or it falls in their quiet hours; each device's answer is a `notification_deliveries` row, and a token the service says is dead is forgotten (FCM `UNREGISTERED`, or `INVALID_ARGUMENT` about the token itself since 2026-09-26; APNs `410`/`Unregistered`; Web Push `404`/`410`). Since 2026-09-26 **a phone's registration lives as long as the sign-in that made it** (proposed — owner to confirm): `devices.push_session_id` (migration `0023`) names that sign-in, and every hub-side end of it — sign-out, a revoked token, a password change or an admin's reset, the person disabled or deleted, the owner reset, a re-pair — forgets the token; a sign-in that expired is caught before the next send. A browser's Web Push subscription stays the browser's until turned off or unlinked. Three senders: **Web Push** with VAPID keys the hub makes itself (`/data/keys/vapid.json`; RFC 8291 encryption checked against the RFC's own example) — works with no account anywhere; **FCM** (HTTP v1, a Firebase service account) and **APNs** (HTTP/2, a `.p8` key) — both built and tested against fakes, **switched off until the owner gives credentials** in Settings or `COREHUB_FCM_*` / `COREHUB_APNS_*`; `listPushSenders` says what each one is missing. `getPushConfig` (the VAPID key and the senders that can deliver), `setPushSender` / `deletePushSender` (admin), `testPush` (one device). Hub peers were parked (DECISIONS §80) and are built since 2026-09-27 as linked hubs (above). **Not built:** ntfy as a fallback sender |
| notify | 14 | 14 | the inbox — and since 2026-09-22 something actually writes to it: a run that finishes and an approval that is raised, in the recipient's own language, announced on `/rt/devices`. Per-kind preferences decide whether a notice is written at all and whether it is pushed, quiet hours silence push (since 2026-09-25, when push was built in `devices`; `sendTestNotice` writes a test notice through the same path), and webhooks check their URL against private addresses before anything is sent, with an HMAC signature and a delivery record; since 2026-09-24 a webhook's recent deliveries are readable (`listWebhookDeliveries`). Since 2026-09-25 **webhooks receive the hub's events** (contract decision §59, proposed — owner to confirm): the fourteen events of the contract's `WebhookEventName` catalogue (a run finished, failed or stopped; an approval raised or answered; a task added, moved or assigned; a scheduled run finished or failed; a workflow run finished or failed, or a step waiting for a person; a notice created) are caught as the hub emits them, queued in `webhook_deliveries` and sent in the background as a signed `WebhookPayload` (`X-CoreHub-Signature`, `-Event`, `-Delivery`), from the profiles the webhook lists (empty: every one its creator may enter, checked at each event), with message text left out unless `include_content`. A failed attempt is retried `max_retries` times (default 5) after 30 s, 1 min, 2 min … (at most an hour apart), then the delivery is `dead`; each attempt has 10 s, redirects are not followed, and the address is resolved and checked again at every attempt and the connection pinned to the checked address (DNS rebinding). `redeliverWebhookDelivery` sends a failed one again; a restart picks up what was due. The timeout is the hub's (10 s), not a per-webhook setting yet |
| terminal | 1 | 1 | since 2026-09-25 **the owner's web terminal** (DECISIONS §70): off unless the hub runs with `COREHUB_WEB_TERMINAL=1`; then Settings → Terminal gives the owner — not admins, not members, not an app token — shells on the hub's host as the hub's own user, in `/data/workspaces/<profile>`, on a real PTY (`node-pty`, built into the image; a plain shell without one where it does not load), over `/rt/terminal`. Tabs, copy and paste, resizing, and a reload attaches to the live sessions again; at most three at once, closed after 15 idle minutes; every start and end in the audit log. Proven: `image:sealed-check` opens a PTY shell in the image and it cannot write `/app` or `/opt/hermes` |

**Phase 4 of the roadmap is complete**: `knowledge`, `plugins`, the `updates`
channel and the `audit` dashboards all answer. Of Phase 1, `tasks` is complete
as a board, `schedules` entirely (since 2026-09-24 the hub fires its own), and `notify` entirely;
`rooms` is complete (a task's progress now reports into its project's room), and the Hermes-gateway half of `agents` is still 501. Phase 3 (phones and desktop) is last, by the
owner's decision on 2026-09-22.

**What answers is not always what works end to end.** Two places say so
themselves rather than in a footnote: a task whose git worktree git refused
does not start, and its worktree shows git's own message (a task of a project
without a repository works in its session's own folder under
`/data/workspaces/<profile>/`); and a
schedule whose target cannot start (an agent that is not installed, a workflow that
is gone) is recorded as a failed run that says why, never as a run that happened.
**Nothing in this hub starts a run except a person typing in the chat or a room (and an agent
in a room passing the turn to another, within the room's limit), a workflow
someone ran, a task someone assigned and started (or dispatched) or set to start
automatically (`auto_start`, a few at a time per profile), a schedule whose
time came or that someone ran now (since 2026-09-25 an agent in someone's live run may do
the last three through the hub's own tools, as that person, where an admin allowed it) — the hub's own scheduler for every schedule but
Hermes's — and Hermes's own scheduler and kanban for the schedules and cards that
live in them.** A workflow step that waits for a person waits until someone answers
its approval.

## Clients
- **Every client** — since 2026-09-27 (DECISIONS §113, decided by the owner 2026-09-26): **digits
  are Latin (123) in the Arabic UI too** — web `intlLocale` (`ar-u-nu-latn`), iOS
  `Locale.latinDigits`, Android `Digits` (`-u-nu-latn` on the activity and the process default,
  also when following an Arabic phone); no catalogue holds Arabic-Indic digits (`pnpm i18n:check`).
  On the phones the **profile selector is a small chip in the drawer's footer** beside the account
  name and the connection dot; it left the top of the drawer.
- **Web** (`packages/web`): first-run setup, login, chat with streaming,
  approvals and resume — since 2026-09-26 (DECISIONS §112, proposed — owner to confirm) **the
  sidebar folds into a rail of icons** on a wide screen (its toggle, or `Ctrl+Shift+S` / `⌘⇧S`;
  remembered per browser; the rows name themselves in tooltips; the lists become two icons that
  open the sidebar on their list; the footer becomes the person's menu; on the right in Arabic;
  the phone drawer is unchanged) — since 2026-09-28 (DECISIONS §126, the owner's design) **Search is
  an icon beside the fold toggle** (the row below New chat when folded) and **«الأدوات» / Tools** is
  one expandable entry holding Agents (owners and admins), Tasks, **Workflows — now its own page
  `/workflows`** (the old `/schedules?section=workflows…` address redirects) — and Schedules; closed
  or open is remembered per device, and closed on one of its pages it is marked as the place (web and
  desktop; since 2026-09-28 the iPhone and Android drawers too, with Search as an icon in the drawer's header and Workflows a page of its own — DECISIONS §128) — since 2026-09-29 (owner's request) **a running workflow is seen on the Workflows page**: its card gets the task board's turning green edge and a badge «يعمل · <step>» / "Running · <step>" ("Waiting for approval" with a still amber edge while it waits), live over `/rt/schedules` — the page listens again since it left Schedules, so a run a trigger's delivery or a schedule started shows without a reload — with a poll behind it; the sidebar's Workflows entry (or the closed Tools heading) shows a small breathing green dot while any workflow of the selected profile runs; reduced motion keeps the edge green and still (phones: follow-up) — since 2026-09-28 (DECISIONS §125)
  **Settings → Secrets** for the owner alone (web and desktop): the account password asked again on
  every visit (`auth.stepUp`, a five-minute grant held in memory, sign-in lockout on wrong tries),
  the names of the provider keys, channel variables, MCP credentials and webhook secrets grouped by
  kind and profile, one value shown at a time for 30 seconds or copied, each reveal an audit row
  without the value — and **the Models page's Runtime card** is one line when every
  check passes («وقت التشغيل جاهز · الفحوص 4/4») that opens the list, and opens by itself with
  the failing checks first when one fails; a long conversation pages back through older messages
  as the reader scrolls up (built 2026-09-24, e2e `zzz-chat-history` journey 24) — since 2026-09-27 (DECISIONS §102, proposed — owner to confirm) an
  agent's **Memory** page draws each entry of its two lists on its own (edit, remove, add) with
  the list against Hermes's character budget; the **pending-actions sheet** counts and answers
  the memory and skill writes Hermes's agent staged for review (admins) and opens a room's
  question in its room; a **category** takes a colour; the **context meter** splits the window by
  category (Hermes's `session.context_breakdown`, only while a conversation is open on the hub);
  a run still going shows its **"files changed" card so far** under the live reply; a
  **workflow's limits** sit in the editor's side panel and Run has a "run with limits" for one
  run; a member whose remembered profile was taken opens their first granted one — and since
  2026-09-27 **Settings → Linked hubs** (owners and admins; ADR
  0026): make an invite, use one, approve, rename, switch off, limit questions, unlink after a
  confirmation, read each hub's log, share agents, and ask a linked hub's shared agent one
  question; and a **Presets** card on an agent's Settings page (§100): save the current
  settings under a name, activate one after a confirmation (what could not be applied is
  named), delete one; since 2026-09-27 a conversation's agent, folder (an icon; its
  popover says the name, the whole path and why it is fixed once the chat has run), Files and
  the Chat | Trajectory switch sit in the pinned top bar after the title, one bar, with a
  "More" panel when the bar is narrow (a phone); Telegram/WhatsApp conversations can be hidden
  from one's own list («إظهار المحادثات المخفية» brings them back) and, by an admin, deleted
  from Hermes after a confirmation; Settings → Notifications is a table of events with «في
  الهب» and «على الأجهزة» columns; the fallback chain reorders by drag and drop (keyboard too);
  a model picker lists a recent model once — and since 2026-09-24 scrolling back through a long
  conversation page by page, keeping the reader's place; since 2026-09-25 a
  «المسار» / "Trajectory" tab beside «المحادثة» / "Chat": a timeline of the
  inputs, model turns and tools on one axis (time flows in the reading
  direction, idle stretches folded), a step list with Duration / Turns / Calls
  filters and search, each tool step opening to its arguments and result, the
  metrics the hub has, and the session log download; it follows a run live;
  since 2026-09-25 a conversation's **files open beside it** (decision §48): a
  «الملفات» / "Files" list in the header, and links from a tool card, a file
  named in a reply and an attachment, open a tabbed panel docked at the inline
  end (resizable; the whole screen on a phone) that renders HTML in a sandboxed
  frame (with its source), PDF, pictures, Markdown, highlighted code, text, CSV
  and XLSX as tables, DOCX as text and PPTX as an outline, with Download and
  Open in new tab, and follows the agent's edits during a run; since 2026-09-27 **videos and
  sounds play** there and in a reply (DECISIONS §98, proposed — owner to confirm): a player
  from a one-hour stream address that reads byte ranges, so a long file starts at once and
  seeks, and a format the browser cannot decode falls back to its name or a note with Download;
  and the agent's **Channels page has «ويب هوك» / "Webhooks"** (DECISIONS §97): create a route
  with its prompt and events, its full address and secret with copy buttons, test it from the
  hub, delete it, and a plain note that outside services need the hub's address to be public;
  the add-provider dialog's default-model picker leaves image-only models out (§87);
  since 2026-09-26 **a reply's own files are drawn on it** (it drew none before —
  the owner's «سوي صورة قط يطير» came back as words and a path): a picture the agent
  left in the run's output folder is drawn in the reply (fetched with the bearer
  header) and any other file is its name, both opening that panel; the run folder's
  path in a reply's words is drawn as the file's name (proposed — owner to confirm);
  since 2026-09-25 **`/` commands in the composer** (decision §57): typing `/` opens a menu
  of the session agent's commands with a line each, in Arabic and English, filtered as one
  types and walked with the arrow keys — `/compress`, `/steer`, `/skill` (then the agent's
  skills), `/plan`, `/goal`, `/learn` where the agent has them, and `/new`, `/fork`,
  `/archive`, `/model`, `/clear-screen` for every agent; any other `/text` is sent as a
  message. The **context meter** beside the mic says how full the window is — Hermes's own
  count, or an estimate from the last turn labelled as one — and opens to the details and a
  Compress button; «يُضغط سياق المحادثة…» shows above the composer while the agent
  compresses, whoever started it. Hermes's Settings page has a **Context compression** card
  for the selected profile;
  since 2026-09-25 **voice** (contract decision §63): the composer's mic records and the hub
  transcribes the take into the composer for review (dictation language auto / Arabic /
  English, kept in `Preferences.voice`; since 2026-09-26 the mic waits, saying so, until the
  speech settings and that language are read); with no STT provider the browser's own recognizer
  is used and marked, with neither the composer says so and links to Models; a speaker
  under each reply reads it through the hub's TTS in chunks, a code block announced as
  «كتلة كود»; «اقرأ الردود تلقائيًا»; and a full-screen **voice mode** — tap or hold to
  talk, the reply spoken sentence by sentence as it streams, listening again, interrupt —
  turn by turn, because no provider streams, and it says so. The Models page's speech tabs
  now choose the profile's STT and TTS provider and set its model, language and voice
  (they could not before), and a custom endpoint can be added as a speech provider; since
  2026-09-26 the Providers tab lists chat providers only, each speech tab lists, adds, edits and
  removes its own kind, and an **Images** tab («الصور») chooses the profile's image model from
  the chat providers' image models, marked when inherited from the default profile; since
  2026-09-27 the speech tabs pick the model, the language (detect automatically, the popular
  languages, every language, or a typed code) and the voice (the provider's voices for that
  model with language and gender, filtered by language and searchable, the documented list
  labelled as such, or a typed id) and preview it in Arabic or English before saving, and the
  composer's dictation language offers the popular languages, not only Arabic and English —
  sessions list, agents (since 2026-09-25 a «أدوات كور هب» / "Core Hub tools" card on an agent's MCP
  page: the groups with what each does, a switch for the whole, one per group and one for each group's
  changes, the last calls in the hub's words, and Test through Hermes; since 2026-09-26 a
  «ملفات الإعداد» / "Config files" page in a coding agent's own list, before Settings — one tab
  per file, the Files page's editor, Save and Revert, a stale file refused with a Reload, and a
  note that the files are shared by every profile — and «حسابات المراسلة» / "Messaging accounts"
  in Settings → Account (link a Telegram or WhatsApp account with a `/start` code, watch it
  appear, unlink it) with everyone's links for admins in Settings → People), models, the Tasks board,
  schedules (since 2026-09-24 "Run now" for every schedule, each schedule's history
  opening the conversation or the workflow run it started, and a workflow run's view
  where a step waiting for approval is approved or denied with a reason — the inbox
  opens it there; and each hub schedule's two run options, "run if missed" and "if the
  previous run is still going", set on the new-schedule form and changed from the card's
  "Run options", not shown for Hermes's schedules; a time waiting for the previous run
  says so in the history; since 2026-09-25 a **Workflows** section beside the schedules —
  every profile's workflows, each made, drawn, copied, deleted and run in its own profile — and
  a **canvas** for drawing one: steps added from a palette (Agent, Condition, Delay, Notify,
  Approval), dragged into place, connected by dragging from a step's success or failure dot
  (or from the side panel), panned and zoomed, deleted, all of it by keyboard too; each kind's
  form (an agent step's agent, its own model and a prompt with the earlier steps' outputs to
  insert; a condition's one comparison; a delay; a notice's words; an approval's question);
  the hub's check shown live on the steps it names; Run and Run from this step; and a run read
  on the same canvas — each step's state, its output, the connections taken, the answers on a
  step that waits, and Run again from this step. The canvas runs the way the page reads:
  right-to-left in Arabic. Not offered because the engine has none: a notice's recipients (it
  reaches whoever runs it), an approval's timeout, attachments on a step; and since 2026-09-25 a «جداول شائعة» / "Common schedules" menu fills in
  the cron or the interval and the form shows the next three times the hub would run it, in
  the schedule's timezone, or why the hub cannot read it; and a workflow run's view shows the
  limits it ran under, what it cost and which limit stopped it, and edits the workflow's limits there), notifications, people, workspaces (with export to a download and import
  from a file, since 2026-09-24; since 2026-09-25 Rename on every profile says the id stays, and
  the new name is what the top profile chip, the list badges, Hermes's gateways on the Agents page
  and a Telegram bot "already linked in" message show), knowledge, plugins, updates, about, settings (since 2026-09-25 **Logs** with source, profile,
  level and text filters, 200 · 1000 · 5000 lines, a live tail and Download, and **Performance** live
  every five seconds with sparklines, both paused while the tab is hidden), pairing. Screens whose module is still 501 say so explicitly
  instead of showing an empty page.
  The destinations still showing that placeholder all wait on a **module**: the parts of
  `agents` its row above lists as not built. Since 2026-09-25 **Rooms** is no longer a
  placeholder: the Rooms segment lists the person's rooms (active and archived) with
  `New room` and `Join by code` (a pasted link works; `/join/<code>` opens the same dialog after
  sign-in), and a room shows its transcript (the person's own messages on the right, everyone
  else — people and agents — named on the left), a composer where `@` offers the room's seats
  (and `@all`) and says who answers a message that mentions nobody, who is typing, and a members
  panel (a sheet on a narrow screen): the seats with role, model and the lead, added, edited,
  made lead and removed by the manager, and the people with who is in the room now. The manager
  renames, archives, deletes and shows the invite code (and a new one); a member leaves. Agents'
  replies stream in under their names, the strip above the composer says which agent is next,
  thinking or replying and with which tool, a busy seat has Stop, a reply that passes the turn
  says to whom, a chain the guard stopped says why and offers «جولة أخرى» / "One more round", and
  the manager has Room settings (`@all`, handoffs and their limit, and which project reports its
  tasks' progress into the room) and Clear the context. The members panel shows the room's
  summary, which the manager has rewritten now («لخّص الآن» / "Summarise now") or edits.
  Since 2026-09-25 **Global agent** is no longer a placeholder: its page (no menu entry) opens
  the person's global-agent conversation in the profile — search hits and the pending-actions
  bar lead there, the chats list leaves it out — and a **pending-actions bar** sits in the top
  bar of every screen: the count of approvals, agents' questions and workflow steps waiting in
  every profile the person may enter (and, for an admin, senders waiting to pair with a channel
  in the profile they are in), opening a sheet where each is answered or opened where it lives. Since
  2026-09-24 none waits only on a screen: **Webhooks** lists, adds, edits, enables, deletes and test-sends
  (the test really arrives, signed, and its delivery is listed with the
  endpoint's status) — and since 2026-09-25 the form sets which profiles, whether message text is
  included and how many retries, the events read as sentences, and the deliveries table shows each
  event's attempts, status, answer and next try, with **Redeliver** for a failed one, and **Privacy** lists the app tokens and paired devices
  that can act as you and revokes them. Since 2026-09-25 Privacy's switch «إخفاء المعرّفات وأرقام
  الهواتف عن النموذج» is Hermes's own `privacy.redact_pii` in the profile; the hub's stored
  `redact_pii`, which nothing read, is deprecated. Hermes's **Settings** page draws each field with
  its help and Hermes's default, says when a save applies, and lists «بانتظار المراجعة» / "Waiting
  for review" — the agent's memory and skill writes, approved or rejected there.
  Since 2026-09-24 the agent's **Channels** page shows a linked WhatsApp with its account and
  Unlink (behind a confirm), says how to use it (message the number from another account,
  approve the first request) with a warning about linking a personal number. Since 2026-09-26
  (DECISIONS §85, proposed) linking WhatsApp asks first «بوت (رقم مخصص للوكيل)» / "Bot (a number
  for the agent)" or «أنا (مراسلة نفسي)» / "Me (Message yourself)", picking neither for the
  person; the linked card shows the mode with «تغيير الوضع» / "Change mode", and in «أنا» mode
  says to write to the agent in "Message yourself" (no pairing warning). A card whose channel the
  running gateway does not serve says «يحتاج هرمز إلى إعادة تشغيل…» with «أعد التشغيل الآن»; the
  page reads again every 3 s while a channel is still signing in. The senders waiting for
  approval and the approved ones moved from lists under the cards to one «الموافقات» /
  "Approvals" button in the header with the count waiting, opening a panel grouped by platform —
  Approve / Deny, and Remove for an approved sender — and a card with somebody waiting links to
  it; the «بانتظارك» inbox approves or denies a waiting sender right there. Read again every ten
  seconds. Since 2026-09-26 each card's «كيف تبدأ» / "How to start" is closed until pressed (it
  used to open by itself while a platform waited for its first approved person), its steps point
  to «الموافقات» at the top and no longer say to restart Hermes, and the page's "restart it"
  note shows only where the hub does not run Hermes (or an older hub). A WhatsApp card in «أنا»
  mode offers «عنوان الردود» / "Reply header": the agent's name or a typed title, previewed as a
  reply will start (DECISIONS §86). Hermes's card lists its
  messaging gateways and their state. Since 2026-09-28 (DECISIONS §129, proposed — owner to
  confirm) a Hermes of v2026.9.21 (`0.21.4`) or later, which allows one gateway per host serving
  every profile, gets no gateway per named profile: the default one serves them all, each named
  profile's row follows it, and a channel change there asks it to rescan; beside a person's own
  Hermes the hub's gateway takes a host lock inside its own home. An older Hermes is unchanged. Since 2026-09-25 Discord, Slack, Matrix, Mattermost and
  Email link with plain setup steps, the check with the platform, the account named on the
  linked row, its own settings panel and Unlink; the other Hermes platforms with a generic form
  and a note that nothing there is checked. Since 2026-09-26 the page lists **only the linked
  platforms**; one «ربط منصة» / "Link a platform" button (also the empty state's) opens a
  searchable picker of every platform — the popular ones first, the rest alphabetically in the
  reader's language, Arabic names in Arabic, with badges for a download on first start, a public
  address or an outside program — and picking one opens its own form. Each platform's «كيف تبدأ»
  / "How to start" lives in its own card (open while it waits for its first approved person) and
  in its link dialog, never over the page.
  Since 2026-09-24 (ADR 0016 stage 2) the **Tasks board and Schedules** show
  every profile the person may enter with no profile filter, each card and
  schedule with its profile's badge; a new task or schedule is made in the top
  selector's profile (the screen names it), anything done to an existing one
  goes to its own profile, and a task's conversation opens there
  (`?profile=`) without moving the selector. Both pages hear every profile in
  realtime. Since 2026-09-25 the board has «إعدادات المشروع» / "Project settings"
  (the repository path and base branch, with the hub's reason when it refuses a
  path), and a task's details show its worktree — folder, branch, state, git's
  own message when it refused — with «إزالة شجرة العمل» / "Remove worktree", and
  a «البدء تلقائيًا» / "Start automatically" switch.
  Since 2026-09-25 **a failed run's error sits under the turn that failed** (its reply, or the
  person's message when the agent wrote nothing) with a dismiss ×, never above the composer, so a
  later successful run no longer looks failed; after a reload the failed turn still shows it (read
  from `sessions.listRuns?status=failed`). The Models screen's Runtime card says a pending restart
  as an amber warning — «غيّرت الإعدادات بعد آخر تشغيل لـ Hermes — أعد تشغيله لتطبيقها» — with
  «إعادة التشغيل الآن» for an admin, and an agent's side list has a Restart icon beside Hermes's
  name (admins only) that spins until the restart job ends and says «تمّت إعادة التشغيل» or the
  error in a toast; both use one hook over `agents.restart`.
  Since 2026-09-25 **«الملفات» / Files** (Settings → tools, owner and admin; DECISIONS §65,
  proposed): the selected profile's working folder — breadcrumbs with the folder in the address,
  upload by drop or picker (asks before replacing), download a file or a folder as a zip, new
  folder, new text file, rename, move, copy, delete behind a confirm, preview of text (coloured,
  never rendered as a page — HTML and SVG included), pictures and PDF, a text editor with syntax
  colour that saves against the etag it read and on a conflict offers "load the new version" or
  "keep my text and overwrite", and "Attach to chat": the file becomes an attachment and a new
  or recent chat of the profile opens with it in the composer. No terminal, no commands.
- **Terminal** (`packages/cli`): the reference client — `setup`, login, pairing,
  agents, models, sessions, an interactive `chat` with resume and approvals.
- **Desktop** (`apps/desktop`, Electron — ADR 0020, proposed): since 2026-09-25 **remote
  mode** works. A first-run screen (Arabic/English, RTL) offers remote or local; remote takes
  the hub's address (checked against `meta.get` before anything is saved) or a pairing link
  (`corehub://pair?…`, the web's pairing card now shows it) and then loads the **bundled** web
  client from the app's own loopback origin, which forwards `/api` and `/rt` (HTTP, SSE and
  WebSocket) to the hub. Each hub has its own storage partition. Window size and place are
  remembered, one instance runs, `corehub://open/…` links open a page, new notices are shown
  by the OS and the unread count is the dock/taskbar badge, a tray keeps the app running
  (where the desktop has one), and the menus are in the app's language. The web client is the
  `desktop` surface there and gets **This device** (hub connection, change connection, app
  version, keep-in-tray). Since 2026-09-25 also **local mode** (ADR 0021, proposed): the app
  runs the same server as a child with Electron's own Node, on 127.0.0.1 and a free port, its
  data in `<app data>/local-hub`; it finds the person's Hermes program (PATH, then where
  Hermes's installers put it on Linux, macOS and Windows) or a running gateway, and without
  one offers **Install Hermes** — Hermes's own installer, shown before it runs, output streamed
  — or to continue without; This device then shows the data folder and the Hermes in use. Since
  2026-09-27 **local mode works with a Hermes installed by Hermes's current installer**
  (`docs/changes/2026-09-27-twuijri-desktop-local-existing-hermes.md`): its package manager keeps
  the Python packages and tools per data root, so the hub's own Hermes home (`local-hub/hermes`)
  now links `installs/` to the person's `~/.hermes/installs` and runs Hermes with
  `HERMES_RUNTIME_DIR=~/.hermes/tools` — the gateway answers in seconds, offline too, instead of
  Hermes downloading a second ~2 GB runtime into Core Hub's folder (and repointing the person's
  own `hermes` launcher at it); nothing of the person's configuration, keys or conversations is
  touched (`COREHUB_HERMES_SHARED_INSTALL=off` turns it off). The Hermes card reads the version
  from `hermes --version`'s first line instead of waiting out its update check (it showed
  "Command failed"), says why the gateway stopped or is still starting in Hermes's own last line,
  a chat turn that cannot reach it says the same, and long errors wrap on the card. Since
  2026-09-27 also **the oldest Hermes the hub works with** (DECISIONS §119, proposed — owner to
  confirm): `0.21.3` (v2026.9.14, the image's pin until 2026-09-28); a person's own Hermes that is older is said on
  its card without blocking anything, and an owner or admin can update it from there with
  Hermes's own `hermes update --yes` after a confirmation, then the hub restarts the Hermes it runs. Since
  2026-09-28 (DECISIONS §132, proposed — owner to confirm) **the image carries Hermes v2026.9.24
  (`0.21.5`)** and CI runs every real-Hermes suite against it and against the floor; a named
  profile's `.env` holds every key it uses (Hermes 0.21.4+ reads nothing else for it); on one
  gateway per host a named profile's webhook routes are answered by the root's listener; and a
  person's own Hermes hears of Hermes's newer GitHub releases (update available, and whether Core
  Hub was tested with it; `AgentInstall.tested_version`) and says when it is newer than the tested
  release. Known: on 0.21.4+ a named profile with an allowlist ignores strangers instead of pairing
  them (Hermes's own behaviour). A daily Hermes watch proposes the next pin. Since
  2026-09-25 also the **local helper** (ADR 0022, proposed): an MCP server in the app on
  127.0.0.1, off by default, token-protected, refusing browser requests; its permission screen in
  This device lists the live tools (list/read in shared folders; write only in folders shared as
  writable; open files and http(s) links only when allowed), the folders and their access, the
  address and key, and the last calls, and in local mode adds it to Hermes's MCP servers in one
  click. Since 2026-09-27 (ADR 0025, proposed) **a hub on a server reaches it**: linked from This
  device with a pairing of the person's own, the main process keeps its own outbound connection to
  the hub's `/rt/devices` (back-off to a minute, from the tray too; the token sealed by the OS
  keychain) and answers `files` and `apps` requests; turning the helper on with nothing shared makes
  and shares `~/Core Hub` (writable); **Programs on this computer** — MCP servers registered with
  Claude Desktop (and its extensions), Claude Code, Codex, Cursor and Windsurf, found on macOS,
  Windows (the Store build of Claude too) and Linux — each off until the person picks its profiles,
  "needs setup" with its missing setting given in Core Hub, started as the app's child (Windows
  `.cmd` programs through `cmd.exe` with every argument escaped), asked about once per session in a
  native dialog in both modes, every call in the activity list; a DaVinci Resolve readiness check
  (integration, running, external scripting, Studio) with the steps that fix it; a video in a reply
  plays in place. This device groups all of it into folded parts. Tested with a stand-in for
  Resolve's integration; **never run against a real Resolve** (the owner's Mac check is in the
  change record). Since 2026-09-25 also
  **installers and an update check** (ADR 0023, proposed): AppImage + deb (Linux x64: 125.8 MB
  and 99.7 MB), dmg (macOS, Apple silicon only: 118.4 MB) and NSIS (Windows x64: 105.5 MB),
  unsigned, built by
  `.github/workflows/desktop.yml` as artifacts and never published; This device checks GitHub
  releases once a day (switchable) or on demand and links the installer — nothing is downloaded
  or installed by the app. Since 2026-09-26 (from 1.1.3; DECISIONS §109, proposed — owner to
  confirm) **the apps update themselves**: the Windows `.exe`, the macOS app and the AppImage run
  electron-updater against the GitHub releases' `latest*.yml` about ten seconds after start and
  every six hours, download a newer version in the background and float *Restart to update* /
  *Later* over the page (never restarting on their own; installed on quit otherwise); the `.deb`
  says a new version is out and links the download page; the Store build never looks. *Check for
  updates…* is in the menus and the tray; the switch stays in This device. The release now carries
  `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, the blockmaps and a signed
  `Core-Hub-X.Y.Z-arm64-mac.zip`, and refuses to publish a feed naming a file it does not carry.
  Unit-tested (the mode per platform and packaging, the schedule, the feeds' names); the packaged
  Linux app was run here as an AppImage runs (`APPIMAGE` set) and reached GitHub (the 1.1.2 release has no feed, so it fell back to
  the releases API); **no real update has been installed yet** — the first is 1.1.3 → the next
  release; 1.1.2 and older must install 1.1.3 by hand once. Since 2026-09-26 the `appId` is `com.twuijri.corehub` and
  `.github/workflows/desktop-signed.yml` (by hand or a release tag, never on a pull request)
  signs the macOS dmg with Developer ID and notarises it (docs/RELEASING.md); Windows is still
  unsigned. Since 2026-09-26 Windows also builds the **Microsoft Store MSIX** (identity
  `AbdulazizAltuwijri.CoreHub`, version `X.Y.Z.0`, Arabic and English, brand tiles; 154.6 MB
  beside the 106.0 MB `.exe`): that build never checks GitHub for updates and This device says the
  Store updates it; a pull request installs a test-signed copy and starts it in local mode (the hub
  answers, its data lands in the package's own folder). A `v*` tag now also makes the **GitHub
  release** (`publish-release.yml`): the `.exe`, `.msix`, notarised dmg, AppImage, `.deb` and the
  signed Android APK, marked latest — not yet run on a real tag. The Store upload is by hand
  (docs/RELEASING.md). Since 2026-09-26 the macOS app is **`Core Hub.app`** in a DMG window
  "Core Hub X.Y.Z" (1.1.1 was `corehub.app`), Windows installs **`Core Hub.exe`** in a `Core Hub`
  folder (an upgrade from 1.1.1's `corehub\corehub.exe` moves there and re-points `corehub://`,
  and the app re-points a person's own shortcuts to the old .exe), and Linux runs
  `/opt/Core Hub/core-hub` (the `.deb` package, `corehub.desktop` and the window class stay
  `corehub`); the data folder stays `<app data>/Core Hub`, pinned by name. Since 2026-09-27
  **voice** (B11): the app's page may have the microphone (sound only, its own origin only; macOS
  asks with `NSMicrophoneUsageDescription`, in Arabic too, and a signed build carries the
  microphone entitlement), so dictation and read-aloud go through the hub as in a browser, never
  through Electron's empty recognizer; This device folds a Voice part (what the OS answered, its
  question or its settings, a test that records four seconds for the hub to write out, a read-aloud
  test). On macOS the old `corehub.app` beside `Core Hub.app` is offered to the Trash once, never
  deleted silently. And **Reach from outside** (DECISIONS §95, proposed): a folded part of This
  device in local mode for an admin — Cloudflare Tunnel with a pasted token, or Tailscale — with
  the warning that the hub becomes reachable from the internet. Never run on a real Mac's
  microphone prompt, a real tunnel or a real tailnet (the owner's steps are in the change record).
  Tests:
  unit tests of the main process logic, the loopback proxy, Hermes detection per platform, the
  installer runner, the hub supervisor, the helper (folder rule with links, tools, the MCP
  door) and the update check; a smoke test (Electron under Xvfb) that connects,
  signs in, streams a chat reply and pairs a second computer against the real hub, and starts
  local mode on a computer without Hermes through to the first-run setup and turns the helper on — run in CI against the packaged Linux
  app as well.
- **Android** (`apps/android`, Kotlin + Compose, since 2026-09-25, part 1 of 3): pairing by the
  hub's QR (or a pasted code, or a `corehub://pair` link) or the hub's address and sign-in (and
  first-run setup), tokens sealed with a Keystore key and renewed as the contract says; the drawer
  (the sidebar), the profile switcher at its top, the chats list with its «all profiles» filter,
  archive filter and search; the conversation with realtime streaming (resume with `after_seq`),
  Markdown and code, tool-call cards, approvals and the agent's questions, the thinking indicator;
  Arabic (RTL) and English. The generated Kotlin client reads all 219 response examples of the
  contract. CI builds the debug APK (`.github/workflows/android.yml`); nothing is published.
  Since 2026-09-26 the `applicationId` is `com.twuijri.corehub` (the Kotlin packages stay
  `hub.core.android`), and `.github/workflows/android-signed.yml` (by hand or a release tag)
  builds a signed APK and AAB with Firebase's `google-services.json` from a secret — proven by a
  run on the branch (docs/RELEASING.md). Since 2026-09-27 **the Google Play kit**
  (`docs/store/google/README.md`, DECISIONS §120, proposed — owner to confirm): the Play listing in
  English and Arabic (fastlane supply layout, `apps/android/fastlane/metadata/android`), its icon and
  feature graphic from `pnpm icons:build`, six phone screenshots per language rendered by the
  `PlayStoreShots` Robolectric test against the demo hub, a limits check
  (`apps/android/scripts/play-listing.mjs`), and `.github/workflows/play-upload.yml` (by hand) that
  builds the AAB with self-update off and the release key and uploads it and/or the listing with
  fastlane supply, as a draft by default; the Play Console answers (Data safety, content rating,
  App access, Play App Signing, closed test) are written down. **Never run against Play** (the
  account is still being verified, no `PLAY_SERVICE_ACCOUNT_JSON`), and since 2026-09-27 the app
  compiles against and targets API 36 (Android 16), as Play wants for new apps since 2026-08-31. Since 2026-09-26 **push**: a build with Firebase takes an FCM
  token after sign-in and registers it with the hub (`devices.registerPush`; a password sign-in
  first registers this install as a device, a paired phone uses the device its pairing made),
  again when Firebase rotates it, and removes it before sign-out; a tapped push opens the page its
  notice is about; while push is registered the 15-minute background check stops. A build without
  Firebase (every pull request) says so on This device and keeps the check. Unit-tested against a
  scripted hub; **no real push has been sent to a phone** — the hub's FCM sender stays off until
  the owner enters its credentials.
  Since 2026-09-26 **Logs and Performance on the phone** (owners and admins): Logs reads
  `audit.listLogLines` with source (all, hub, Hermes, errors only) and least-level filters, the
  newest 200 lines, and Refresh asks only for lines newer than the last; Performance reads
  `audit.getLivePerformance` every `interval_seconds` while shown — host, hub process, each Hermes
  process and each profile's activity, a dash where the hub measured nothing. Unit-tested against
  a scripted hub.
  Part 2 (2026-09-25): search across every profile (a global-agent hit opens the global agent),
  the Agents cards and each agent's pages (read-only), the Tasks board one column at a time (move,
  assign, start, open the conversation), Schedules (run now, pause, resume, history), and Settings
  as a list: Account, Display, the notifications inbox, Privacy, This device (the hub connection),
  About, Theme, Profiles and Users on the phone; the other pages open the same page on the web.
  `corehub://open/<path>` opens the page the web path names (`surfaceRoutes.android`), and a
  parity test checks the app against `navigation.json`.
  Part 3 (2026-09-25): notices become Android notifications — announced on `/rt/devices` while the
  app runs, and a background check every 15 minutes while it is closed (replaced by push since
  2026-09-26 when the build and the hub have it, above); «Share to Core Hub» turns shared text into a new chat's draft (files
  and pictures are a follow-up); the composer's microphone uses the phone's own speech recognizer;
  spoken replies; and This device in full: the hub connection, voice input and dictation language,
  spoken replies, notifications, and self-update (since 2026-09-26 from GitHub, below).
  Since 2026-09-26 **the APK finds its own updates** (DECISIONS §108, proposed — owner to confirm;
  `docs/changes/2026-09-26-twuijri-android-updates.md`): coming to the front, at most every six
  hours, and by *Check for updates* on This device, the app reads the repository's latest GitHub
  release (no token); a newer version shows as a card on New chat (*Update* / *Later*, Later hides
  that version), a row in Settings and on This device; *Update* downloads the APK with a progress
  bar, checks its size (and GitHub's SHA-256 when listed) and hands it to Android's installer,
  sending the person to *Install unknown apps* first when needed. A Play build turns it off
  (`-Pcorehub.selfUpdate=false`: no check, no install permission). The phone no longer asks the
  hub's `updates` shelf. Unit-tested (versions, the APK's name, six hours, Later, the switch, GitHub
  answers and the download against a scripted server) and Robolectric-rendered; **not yet tried on a
  real phone or a real release** — copies of 1.1.2 or older have no updater and are updated by hand
  once.
- **iOS** (`apps/ios`, SwiftUI, iOS 17+; parts 1–3 since 2026-09-25): pairing by the web's
  QR code, its pasted text or a `corehub://pair` link, or the hub's address with a username and
  password, and first-run setup when the hub has no owner; tokens in the Keychain, refreshed once
  on `token_expired` and before expiry, a paired phone's app token renewed daily. The drawer
  carries the rail, Chat | Rooms, the chats list (its own «All profiles» filter, a badge per
  profile, active / archived / all, search) and the footer (language, theme, connection, version,
  sign-out); the profile selector sits in the drawer's header. A conversation streams over
  `/rt/sessions` (our own Socket.IO v5 framing, resumed with `after_seq`), with Markdown, tool
  cards, reasoning, the thinking line with its seconds, approvals and the agent's questions, in
  Arabic (RTL) and English. **Every destination has its page** (part 2): search across every
  profile, the global agent, the Agents cards with each agent's Skills (on/off), MCP (test),
  Memory (edit), Jobs (run now), Channels (state; linking stays on the web), Plugins (on/off) and
  Settings (toggles; the rest read-only), Tasks and Schedules across every profile with badges
  (move a task, run a schedule now), Rooms (open, stream, New room and Join by code since 2026-09-27, below), and every
  Settings tab, management page and tool — account (name, password), users, webhooks (test),
  display, notifications and the inbox, privacy (revoke tokens), this device, about, models
  (read), device connections (a pairing QR for another phone), knowledge, logs / usage /
  performance (since 2026-09-26 Logs and Performance read the live `audit.listLogLines` and
  `audit.getLivePerformance`, as Android's do: source and level filters, pull to refresh for newer
  lines, and a measurement every `interval_seconds` while shown), theme, profiles (create),
  updates, plugins. `corehub://open/<path>` links open the
  page they name. The navigation parity test (`NavigationParityTests`) holds the app to
  `navigation.json`, whose `surfaceRoutes.ios` it reads. **Phone specifics** (part 3): the hub's
  notices (a reply finished, an agent waits) become local notifications while the app runs, quiet
  for the conversation on screen and opening it when tapped; since 2026-09-26 **push**: after
  sign-in, with notifications allowed, the app registers for remote notifications and sends its
  APNs token to the hub (`devices.registerPush`, again at each launch), shows a pushed notice once
  (the socket and the push share one list of what was shown), opens what it is about when tapped,
  and removes the registration before sign-out; the `aps-environment` entitlement is `production`
  in Release (checked by the signed workflow). Without push the background look goes on; with push
  it is not scheduled. Unit-tested on the simulator; **no real push has been sent** — the hub's
  APNs sender stays off until the owner enters its key; a share extension hands shared text and links to a new chat (through an App Group
  that works once the app is signed); dictation into the composer with the phone's speech
  recognition; replies read aloud; This device holds the voice input, dictation language, spoken
  replies and notification permission, kept on the phone. Built and unit-tested on a macOS
  runner's simulator; **never run on a device or against the owner's hub**. Since 2026-09-26 the
  bundle ids are `com.twuijri.corehub` and `com.twuijri.corehub.share` with the App Group
  `group.com.twuijri.corehub`, and `.github/workflows/ios-signed.yml` (by hand or a release tag)
  archives and exports a signed App Store `.ipa`, with an optional TestFlight upload (off by
  default; not tried) — proven by a run on the branch (docs/RELEASING.md). Since 2026-09-26 an
  uploaded build is also added to the TestFlight groups in `testflight_groups` (default `Owner`)
  by `apps/ios/scripts/testflight-distribute.mjs` once App Store Connect has processed it —
  tested against a fake App Store Connect only, not yet on a real run. Since 2026-09-27 (§117) an
  uploaded build also goes to the external group `Public` (input `external_group`): the workflow
  keeps the group's **public TestFlight link** on (limit `public_link_limit`, default 1000), prints
  it in the run's summary, sets "What to Test", and submits the build for Beta App Review
  (`apps/ios/scripts/testflight-public.mjs`); while the owner's Test Information (feedback email,
  review contact, demo account) is missing, that step fails and names the fields — tested against a
  fake App Store Connect only, not yet on a real run.
- **App icons** (since 2026-09-26): every app shows the Core Hub mark, white on the accent
  (`#0b6b5d`) like the favicon, made by `pnpm icons:build` (`scripts/icons/build-icons.mjs`, resvg)
  from `CoreHubMark.tsx` and `tokens.json`: iOS `AppIcon` (one opaque 1024 px icon, with iOS 18
  dark and tinted looks), Android's adaptive icon (vector foreground, accent background,
  monochrome layer for themed icons) and the notification small icon, a 512 px Play listing icon
  (`apps/android/store`), the desktop `.icns`, `.ico`, Linux PNGs and tray icons, and the web's
  `apple-touch-icon.png`.
- **Phone polish from the owner's use** (since 2026-09-26, iOS and Android,
  `docs/changes/2026-09-26-twuijri-mobile-polish.md`): a tap on the conversation or a drag of it
  puts the keyboard away, the drawer puts it away before it moves (and its footer rides above the
  keyboard of its own search), the latest message stays above the keyboard as it opens; the drawer,
  sign-in and new chat draw the real Core Hub mark. The composer's «+» attaches a photo from the
  library, a camera photo or a file, uploaded at once (`sessions.uploadAttachment` up to 25 MB, the
  resumable `sessions.startUpload` flow above it, up to the contract's 50 MB; a clear error above
  that or on the hub's `413`), shown as chips with a preview and ×, and sent as image / file blocks;
  a message's files show as names under it (pictures drawn in place since 2026-09-27). Since 2026-09-26 (second pass) photos go «Compressed»
  (≤ 2048 px, JPEG 0.8, as an image) or at «Original quality» (the untouched file, as a file), the
  choice in the «+» menu and remembered. Voice follows «Voice: Core Hub / This phone» (This device;
  This phone by default since the second pass): the profile's hub STT
  (`models.transcribe`, a recorded m4a take) and TTS (`models.synthesize`, in parts of ≤ 2 000
  characters) when `models.getSpeech` says they are ready, the phone's recognizer and voice
  otherwise. Notifications: the app asks while the system has not asked yet (once a launch, in
  front, never after a no), shows the push state in plain words (push on, waiting for your
  permission, off in the phone's settings with a row that opens them, no sender on the hub,
  registration failed), and registers again when it comes to the front. New icons come from Lucide
  (`scripts/icons/lucide-mobile.mjs`, pinned `lucide-static`). Unit and Compose UI tests (Robolectric)
  on Android, XCTest on the iOS simulator; **not yet tried on the owner's phones or hub**.
  Since 2026-09-27 (`docs/changes/2026-09-27-twuijri-mobile-voice-language.md`, proposed — owner
  to confirm): **dictation picks its language itself** — the active keyboard's (iOS
  `textInputMode`, Android's current input subtype), else the conversation's script (Arabic, Latin,
  Cyrillic, Devanagari, CJK, Hebrew, Greek, Thai → the phone's language in it), else the phone's
  languages, else the app's; before, it followed the app's language, so an English app heard Arabic
  as English. Android 13+ also lets the recognizer detect (14+: switch) among the person's
  languages; the hub's STT gets no language with Auto. A long press on the mic chooses one — the
  keyboards', popular ones, or any the phone's recognizer knows (searchable), with a small mark on
  the mic. Dictation now **keeps listening through pauses** until stopped, the words appear in the
  composer as they are spoken, and a strip over it shows the level with cancel, stop and send
  (Android no longer opens the system's dialog). **A reply's pictures draw in the message** (fetched
  with the bearer header), a tap opens them full screen; other files open in the phone's viewer or
  share sheet. The phones ask the hub for MP3 speech (`SpeechRequest.format`, DECISIONS §91).
  Since 2026-09-26 (`docs/changes/2026-09-26-twuijri-mobile-open-files.md`, iOS and Android)
  **every file of a chat opens**: a picture — in the person's message or the agent's reply, sent as
  an image or as a file — draws in the message and opens full screen (Android: pinch or double-tap
  zoom, save to Pictures, open in another app, share; iOS: Quick Look with zoom and share/save);
  PDF, text and office documents open in the system's viewer (Android `ACTION_VIEW` through the
  app's FileProvider, iOS Quick Look); audio and video play in the system player from the
  contract's one-hour stream ticket (`createAttachmentStream` / `createFileStream`); anything else
  goes to the share sheet. Each file is a row with its kind, size, a progress bar and cancel while
  it downloads, and one line with a retry when it fails (it used to stay a dead name). A link in a
  reply that names one of its files, or a file of the conversation's folder (web decision §48),
  opens the same way. Android is proven by JVM tests against a stand-in hub and Robolectric
  screenshots; iOS by unit tests on the CI simulator; **neither yet tried on a real phone**.
  Since 2026-09-27 (`docs/changes/2026-09-27-twuijri-phone-rooms-sessions.md`, iOS and Android):
  **rooms open on the phone** — the Rooms segment lists the selector's profile's rooms (agents and
  people counted) with **New room** (a name and the agents to seat, the first is the lead) and
  **Join by code** (a pasted link works; the room is named and counted before joining); a room
  shows its transcript (your messages on the right, other people and the agents on the left under
  their names), each seat's reply **streaming** into its message over `/rt/rooms` (joined while the
  room is on screen, read again after a reconnect), what each seat is doing now with Stop, who is
  typing, and what the seats ask you (answered in place). The chat's own composer: the mic with the
  continuous dictation, the «+» with the photo quality choice (a room takes pictures and files,
  DECISIONS §99), and `@` offering the room's seats (and «everyone» where the room allows it), sent
  as structured mentions. A **members sheet**: the agents with their status and the lead, the people
  with who is here now, the manager's invite (code, share the link, a new code) and Remove, and
  Leave. `corehub://open/rooms/<id>` opens a room. A **pending list** (proposed — owner to confirm):
  a bell with a count in the top bar gathers the approvals and questions of every profile — a room's
  among them, opened in its room — answered in the sheet or opened where they live. **Batch mode in
  the chats list** (a long press; on iOS a long press's Select): archive, bring back or delete the
  selected chats, per profile, deleting after a question. **Export** a conversation: the hub's
  Markdown transcript (`sessions.export`) handed to the share sheet. Unit-tested on both; **not yet
  tried on the owner's phones or hub**.
- **Android in the family's design** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-android-redesign.md`,
  in progress): a control kit painted by the tokens alone (`ui/kit/`: buttons, fields, segmented
  control, chips, cards, grouped lists, menus, sheets, dialogs, top bar), Lucide icons everywhere,
  text legible in the dark theme (the theme's content colour), the composer laid out as on iOS and
  the web («+», the words, the mic, Send), a drawer like the iOS one (one search field with a filter
  button for the profile and Active/Archived/All; the chats list takes most of the height), rooms and
  the pending sheet restyled. Robolectric screenshots against the iOS demo hub's data, light and
  dark, English and Arabic (`src/testDebug/.../shots`); **not yet tried on the owner's phone**.
- **The phones' missing sections, both apps** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-phone-parity.md`, in progress): **workflows** as the second half
  of Schedules (every profile, run with an input and the run's own limits, a live read-only run view
  whose waiting step is approved or denied there; drawing stays on the web) — since 2026-09-28 their
  own page under «الأدوات» / Tools and edited as on the web: inbound triggers (preset, address to
  copy, secret set or replaced and never shown, events, test event, delivery log), a condition's
  several rules, "Send message" to Telegram or a conversation with a test send, the failure alert,
  "Test this step", and a run's phase, filtered mark, task and event ids with "Find a run"
  (DECISIONS §128, `docs/changes/2026-09-28-twuijri-phones-tools-workflows.md`); **the Tasks board** as
  the web's intake plus four columns side by side, drag to move (asked when a drop means two moves,
  a reason for a block) and to reorder, with the "waits for" and "seems stuck" badges (§93);
  **agent pages** editable on Android as on iOS (skills, MCP on/off and test, memory, jobs run now,
  plugins, settings in place) and on both phones **presets** (§100), **config files** (§78, admins,
  `agent_config_files` now on the phones) and **channels** (linked platforms, unlink, approvals,
  linking by bot token or credentials; QR platforms send the person to the web on another screen);
  **Share to Core Hub** takes pictures, videos and files (a new chat with them attached); **Models**
  native (providers, add by key or sign-in with a device code, drag-ordered fallbacks, speech with a
  voice picker over every language and a preview, the drawing model) and **admin** pages (people and
  adding a person, the notification settings table, device cards, usage); and **the phone's
  location** for an agent that asks (§105: a run may ask, the hub's `devices.locate` tool, a
  one-time consent on the phone). Unit and view-model tests on both; **not yet tried on the owner's
  phones**; the Android drag is hand-made in Compose.
- **Chat controls on both phones** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-apps-chat-controls.md`,
  apps night batch 1): compact chips above the composer — a new chat's **working folder**
  (`sessions.listWorkingDirs`: automatic, an existing folder, or a new name), the **model** (the
  profile's chat models, searchable by provider; a new chat is created with it, a chat is changed with
  `sessions.update`), the agent's **approval mode** (its own `approval_mode` / `approvals_mode`
  setting, each mode explained, admins only) and **Steer** while a reply runs (`sessions.steerRun`,
  falling back to the next message). The conversation's «…»: rename, pin, archive, fork into a new
  chat, **compress** (`sessions.compress`, agents with `compress`), export, delete after a question;
  a long press on a chat in the list offers the same plus Select. Under a reply: copy and «…» (read
  aloud, reply with `reply_to_message_id`, fork from here); a long press on your own message does the
  same. The model picker offers «Default model» on an open chat too (`model: null`), and a titled
  chat's menu offers «Name it automatically» (`title: null`, the hub renames it) — since the explicit
  nulls of §114 (`docs/changes/2026-09-27-twuijri-client-explicit-null.md`). Android: JVM tests against a stand-in hub and
  Robolectric pictures; iOS: unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Background sheet on both phones** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-apps-leftovers.md`,
  §56 as the web's): what works for the person in every profile they may enter (`background.list`
  with `profiles=all`) — chats, tasks, schedules, workflows, jobs, subagents — each with its kind,
  profile (when there are several), state, time so far in Latin digits, **Open** where it lives and
  **Stop** where it can be stopped (`background.stop` in the item's own profile); what finished in
  the last day folded under «Finished (n)». An Activity button with the count sits beside the bell
  in the top bar of the new chat, a chat and a room while something runs (as the web on a phone),
  and the chat's «⋯» opens the sheet always. Read every 10 s while something runs, every minute
  otherwise, only while the app is in front (no realtime subscription yet). Android: JVM tests and
  Robolectric pictures; iOS: unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Android dates in the app's language** (since 2026-09-27, the leftovers task): the process
  default locale is now the in-app language with Latin digits (§113), so month names and date
  order follow the app, not the phone (an Arabic app on an English phone wrote English months); the
  phone's own language is still read from the system for «follow the phone» and dictation.
- **Chat insight on both phones** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-apps-chat-insight.md`,
  apps night batch 6): a small **context ring** in the chat's top bar when the window is known (the
  agent's report, else the catalogue's `context_window` and the last counted turn; never a made-up
  number), which opens the **context sheet**: how full, where the figure came from, what fills it
  (`sessions.getContextBreakdown`, read only while the sheet is open) and **Compress with an optional
  focus** (`sessions.compress` `focus`, agents with `compress`, between replies). A count of
  **running subagents** appears in the top bar only while some run. The chat's «…» gains Context,
  **Runs** (`sessions.listRuns`: status, model, when, how long, tokens in/out and cost — a list the web
  does not have, proposed — owner to confirm), **Subagents** (`listSubagents` live from `subagent.*`:
  the running ones as a tree, the finished folded; Stop, Steer and the end of a subagent's transcript
  where the agent allows it), **Changed files** (`listChanges`, and the running reply's so far from
  `getRunChanges` every 4 s; a file opens its **unified diff** from `getRunChangeDiff` — monospace,
  numbered, scrolled sideways — and «Open» shows the file now through the phone's file viewer) and
  **Files** (`sessions.listFiles`, each opening as a message's file does). Not on the phones: the
  web's Trajectory tab and background-tasks sheet. Android: JVM tests against a stand-in hub and
  Robolectric pictures; iOS: unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Tasks on the phones, part I (both apps)** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-tasks-1.md`): a tap on a board card opens **the task on its
  own** (iOS sheet, Android sheet): title, status, priority, project, who has it (agent or person),
  due date, the description drawn as Markdown, what it depends on (the ones still waited for by
  name, the rest counted), its latest run with its state and start and a way into its conversation;
  and from there **move** (only the moves the hub's transition table allows, a reason for a block, a
  yes for the archive — the same list in the iOS card's long-press menu), **assign** to an agent of
  the task's profile with instructions and "start now", **unassign**, **stop** a running task,
  **edit** (title, description, priority, project) and **delete** (asked first). A **+** in the
  Tasks top bar makes a new task in the selector's profile (title, Markdown description, project or
  the profile's own list, priority, optionally an agent and "start now" — the create then
  `tasks.assignTask(start)`, with an `Idempotency-Key` so a retried Save makes no second task).
  A description cleared on the phone is sent as `null` (§114). Unit tests on both (Android also against a scripted hub, and a Robolectric shot of the
  detail); **iOS verified only on the CI simulator, neither tried on the owner's phones**.
  Comments, checklist, history, projects and bulk actions are part II.
- **Tasks on the phones, part II (both apps)** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-tasks-2.md`, apps night batch 5): the task sheet adds
  **"Start automatically"** (`auto_start`), the **checklist** (subtasks: tick, add, delete, drag
  into another order — iOS by holding the row, Android by holding its grip; each moved line's
  `index` is written), the **definition of done** and **constraints** (§104: add and delete lines,
  ticked only while the task is in review, the whole list saved), **comments** (read, and say
  something — on a Hermes card it goes to Hermes), and for a **Hermes card its own history** (runs
  and events, §103) instead of the lists. The edit form sets or clears the **due date** (a new
  date-and-time field in the shared form kit of both apps; a cleared date is sent as `null`, §114).
  The board gets a **project filter** (the selector's profile's projects), a **projects sheet**
  (create; edit name, state active/paused/archived, repository and branch — the web's project
  settings; archive/restore; delete, asked first and saying its tasks go with it) and **Select**:
  tick cards, then set a priority, say the same comment, archive (done cards only) or delete them,
  one call per profile; refused cards stay ticked with a count. The card shows its checklist
  count. **Not possible yet**: editing or deleting a comment (the contract has only
  `tasks.createComment`); bulk move or assign (not in `TaskBulkUpdate`); the hub's own task
  timeline (`tasks.listActivity`) and the task's worktree section are not shown (the web does not
  show the former; the latter is left for later). Android: JVM tests against a scripted hub and
  Robolectric pictures; iOS: unit tests on the CI simulator; **not tried on the owner's phones**.
- **Schedules on the phones (both apps)** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-schedules.md`, apps night batch 3): the Schedules list reads
  every profile page by page; **+** (iOS top bar, Android "New schedule") makes one in the selector's
  profile with the web's form — name, when it runs (the shared trigger editor: cron with presets,
  every N minutes/hours/days, once, time zone, and the hub's next three runs from
  `schedules.previewTrigger`), the web's six "Common schedules", the agent (Hermes first) and its
  prompt, and the two run options the hub keeps (run if missed, what to do while the previous run is
  going) — not offered for Hermes, which decides them; a Hermes refusal is said in words and its
  cron zone is offered as «Use {zone}». A schedule opens on its own: state, when, next and last run,
  agent, prompt, channel, last error, **run now**, **pause/resume**, **edit** (sends only what
  changed; the agent stays), **delete** (asked first), and its **history** page by page (status or
  "waiting", on time or run now, start, how long it took, output or error, a failed delivery, a tap
  into the run's conversation; re-read every 3 s while a run is going). An agent's **Jobs** page
  runs, pauses/resumes and deletes its jobs (a Hermes job "goes from Hermes's scheduler too"). Fixed
  on the way: the generated clients left the `null` fields of a trigger and a target out, which the
  hub refuses (400), so the phones' next-run preview never worked; the generated clients now write
  them themselves (§114; batch 3's per-app `ScheduleBodies` was removed). Targets are agent prompts only, as on the web. Android: JVM tests against a
  scripted hub and Robolectric pictures; iOS: unit tests on the CI simulator; **not yet tried on the
  owner's phones**.
- **Inbox and your own settings on both phones** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-inbox-settings.md`, apps night batch 4): Notifications is
  Inbox | Settings; the inbox filters All / Unread, shows the unread count, **marks all read**, a tap
  marks a notice read and opens what it is about (its chat, the board, Schedules), and each notice can
  be marked read or unread. **Account** on both: your picture (picked on the phone, made small, sent as
  a JPEG; or back to the generated one — proposed, owner to confirm, since the web only shows it), your
  display name, your password (current, new, again), and **messaging accounts** (list, link with a
  code the bot receives, the list checked until the link shows, unlink after a question). **Display**
  on Android now has the hub's preferences iOS already had (links, sending while the agent works,
  reasoning, tool calls, compact, text size), saved at once. **Privacy** on both: each token's kind,
  scopes, last use and expiry, **revoke after a question** (iOS revoked on a swipe before), and
  Hermes's hide-ids switch for admins as on the web. The contract has no delete for a notice and no
  list of browser sign-ins, so neither is offered. Android: JVM tests against a scripted hub and
  Robolectric pictures; iOS: unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Every section of the Android app works on its own** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-android-self-sufficient.md`): nothing in the app opens the web for
  a hub page any more, and no control is a dead end. Native now: Settings → **Updates** (the hub's
  shelf of app builds, its source, token and channels), **Linked hubs** (invite, use an invite,
  approve, rename, switch off, limit, ask a shared agent, log, unlink, which agents to share) and the
  owner's **Terminal** (a line at a time with the keys a phone lacks; shown only when `GET /terminal`
  answers 200) — both added to `surfaceRoutes.android`; **WhatsApp pairing by QR** drawn on the phone;
  a **hub link or room invite in a reply** opens in the app; the chats list's **categories** (make,
  rename, colour, order, delete, move a chat) and the **Telegram/WhatsApp conversations** Hermes keeps
  (read-only transcript with pictures and older pages, hide/show, delete for admins, **Continue in Core
  Hub**); a chat's **trajectory**; **workflows made, edited, duplicated and deleted** (steps as a list,
  each with its form and connections; checked by the hub as they change) and **run again from a step**;
  the **Runtime** checks on Models and **Fetch** in Add provider; a task's **worktree**; **Send a test
  notification**; **Open** leads to the task, schedule or workflow run itself; the agent page makes
  and edits **jobs**; a knowledge entry reads in full; Device connections sees when a code is taken;
  the global agent's conversation has its menu; and the **Display preferences are applied** (text size,
  reasoning, tool calls, compact, send while busy, where links open). The contract is unchanged.
  JVM tests against a scripted hub and Robolectric renders; **not yet tried on a phone or a real hub**.
  Follow-up the same day (`docs/changes/2026-09-27-twuijri-android-self-sufficient-2.md`, as iOS's #202):
  chats **dragged into order** (kept on the phone per view; Move up/down; dropped on a category to file
  it), the **message queue** above the composer with «wait in line» (Send now, Steer, Remove; sent in
  order as turns end), the composer's **`/` commands** with the **skill picker** after `/skill `,
  **`/rt/jobs` heard for the session** (job pages wake on events, polling as fallback; Agents reads again
  on `agent.updated`), the **trajectory timeline** with the web's rules (idle folded, parallel calls on
  their own rows, reading direction, a bar opens its step) and the Session log as the hub sends it, and a
  **model picker** for workflow agent steps.
- **Explicit `null` from the phone clients** (since 2026-09-27, DECISIONS §114, proposed — owner to
  confirm; `docs/changes/2026-09-27-twuijri-client-explicit-null.md`): the generated Kotlin and Swift
  clients always send a required property that may be null (`null` when unset), and send an optional
  one as `null` only when the caller lists it in the model's `sendNull`; nothing else changes on the
  wire. Made by a post-generation patch (`packages/contracts/scripts/explicit-nulls.mjs`) that fails
  when the generator's output moves. It fixed every required-nullable request field the phones left
  out (a schedule's trigger and target, among others) and gave the phones «Default model», «Name it
  automatically» and a cleared task description. Schedule create/preview/edit bodies from Android were
  checked with the hub's own contract validator; iOS by unit tests on the CI simulator.
- **Rooms management on both phones** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-rooms.md`, apps night batch 7), as the web's Rooms page has
  it: the rooms list has **Active | Archived** and a **long press** on a room renames, archives or
  brings back, or deletes it (its manager; delete after a question) or leaves it (anyone else, after a
  question). The room's **«⋯»** in the top bar: rename, **room settings** (@all, agents passing the
  turn and the most passes in a row), **clear the context** (after a question), archive, delete — or
  leave. The members sheet **adds an agent** (agent, name in the room, role, instructions, model),
  **edits a seat, makes it lead, removes it** (after a question), and shows the room's **summary**
  (summarise now, edit by hand). Over the composer a strip says an agent passed the turn, or that the
  guard stopped a pass, with **One more round**. Room settings also choose the **project that reports
  here** (the old one unlinked with `report_room_id: null`), and an emptied role, instructions or model
  is sent as `null` (contract §114), so a seat goes back to the agent's own model. A `room.updated` no
  longer takes the manager's controls and the invite code away on the phones (the event is the same
  for every member). Seats have no order in the contract, so there is no reorder on any
  client. Android: JVM tests (rules, reducer, requests against a scripted hub) and a Robolectric
  picture; iOS: unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Agents I on both phones** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-apps-agents-1.md`,
  apps night batch 8), as the web's agent pages have it. **Skills**: search, a chip for whose skills
  (all, yours, the Core Hub library, Hermes's), the skills by category with their switch and marks
  (pinned, unreadable, built into Hermes, library, edited); a skill opens to read (Hermes's own) or to
  edit its `SKILL.md` (Markdown with preview); a **new skill** (key + text from the front-matter
  template); pin/unpin, **restore** an edited library skill and **delete** (both after a question);
  **import** a `SKILL.md` or zip from the phone's files (uploaded as `purpose: skill`, installed, the
  uploads deleted either way; a refusal says which rule in our words with the hub's sentence); the
  **Core Hub library card** (how many installed and edited, Install, switch off after a question).
  **Memory**: the three documents with each memory list's **entries** — edit or **remove one** (after
  a question), add one, edit all — and its **budget bar** (warning from 80 %, a save that would grow
  past the limit is refused before it is sent); the persona as one text. The contract's
  `deleteMemoryItem` is for Ekko entries the web does not show, so it is not offered. **Plugins**: the
  source and Hermes's status, the switch, **install** by catalog name / `owner/repo` / Git URL
  (Hermes's job followed to its end, its outcome said) and **remove** (after a question). **Agent
  cards**: the one button the agent needs (Install, Update to x.y, or Restart for a supervised Hermes)
  and «⋯» with check for updates, update automatically on/off and **remove** (after a question); every
  job is followed with a progress bar and its outcome (installed version, «up to date» or the update
  found, the failure in the hub's words). Android: JVM tests against a scripted hub and a Robolectric
  picture; iOS: unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Agents II on both phones** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-apps-agents-2.md`,
  apps night batch 9), as the web's agent pages have it. **MCP servers**: the **Core Hub tools** card
  (switch, groups with their tools and "allow changes", test, recent calls with the refusal's reason),
  then each server with its switch, transport, what it runs or where it points, state and Hermes's
  error; **Test** shows the tools Hermes listed and how long it took, or Hermes's sentence; **new
  server / edit** as a form — a command (arguments one per line, environment variables) or an address
  (headers), each variable or header a name and a hidden value, a stored one kept unless typed again,
  other keys kept — or as the server's JSON (the form is proposed — owner to confirm; the web edits
  JSON only); **delete** after a question. **Settings**: `list` (one item per line) and `json` fields
  are edited on the phone now (JSON checked before it is sent, proposed — owner to confirm), a save
  says when it applies (restarting now, after a restart, from the next message); cards for **signing
  a coding agent in** to its own account (device code, copy, open, wait, outcome), **context
  compression** for the profile, and Hermes's **writes waiting for review** (approve / reject, read
  again every 15 s). **Channels**: each linked platform as a card — switch, marks (one identity,
  linked, state, WhatsApp's mode), account, senders waiting — offering pair (a QR platform says to
  pair it from a computer and opens the web), link (straight to its form), **its settings** (every
  option in its five sections with its default, shared options marked, reset, one save = one gateway
  restart), **WhatsApp's mode** and **reply header**, a platform's **fields**, **unlink** and **forget
  identity** (after a question), and **Restart now** when the gateway does not serve it yet; the
  gateway's line; and the agent's **webhooks** (listener state, address and secret to copy, test,
  delete, new webhook with events and where the answer goes). Not built on the phones: the web's
  per-platform "how to start" guides and the grouped Approvals panel; WhatsApp's QR pairing stays on
  the web on Android (iOS draws the code itself since 2026-09-27, below). Android: JVM tests against a scripted hub and Robolectric pictures; iOS: unit tests on the
  CI simulator; **not yet tried on the owner's phones**.
- **Knowledge, Skills usage, hub Plugins and Webhooks on both phones** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-knowledge.md`, apps night batch 10), as the web's Settings
  pages have them; Android no longer opens these four on the web, and iOS's Skills usage is no longer
  a "coming later" screen. **Knowledge**: the profile's journal, notes and files as one list, newest
  first, with the kind as chips, a search (asked once typing pauses) and the next page as the list
  ends; each row its kind, title, day, three lines of text, tags and attached files. The contract has
  no create, upload, delete or re-index for these rows (the web has none either), so the phones have
  none. **Skills usage**: the period (7/30/90/365 days), every profile or one, one agent or all (a
  chosen agent that left the period stays choosable); since when the hub counts, the four totals, the
  per-day chart as a compact list of bars with the day's skills, the top skills (uses, share, last
  use) and the enabled skills no run loaded. **Plugins**: the hub's list with kind, version and state;
  `plugins.list` is the only operation (no installer, switch or settings exists for hub plugins), and
  the empty state says so. **Webhooks** (notify, §59): the list in the profile you are in (the calls
  carry `X-Hub-Profile`, as the web's do; since the leftovers task the contract declares it on the
  seven webhook operations, DECISIONS §115 — optional since the compatibility hotfix, so a client
  built for v1.1.2 without it still lands in `default` — and the phones pass it by name), on/off,
  **send test** followed to its outcome, the recent deliveries (followed while one waits) with
  **redeliver** where it may, **add/edit** (address with the hub's refusal in words, private
  addresses, events from the catalogue with a filter, every profile or these, message text, retries,
  the signing secret kept, made new or stopped) and **delete** after a question; a new secret is shown
  once with Copy. Hermes's incoming webhooks (§97) stay on the agent's Channels page. Android: JVM
  tests against a scripted hub and Robolectric pictures (light English, dark Arabic); iOS: unit tests
  on the CI simulator; **not yet tried on the owner's phones**.
- **Admin pages on both phones: People, Profiles, push senders, pairing requests** (since
  2026-09-27, `docs/changes/2026-09-27-twuijri-apps-admin.md`, apps night batches 12 and 14), as the
  web's admin pages have them; a member who reaches one sees that only an owner or an admin manages it.
  **People**: each person with role, state and what they may enter (every profile, these, or none);
  a row offers only what the hub accepts — the owner's account is not edited by an admin, the owner
  sets their own password, nobody disables or deletes themselves; add a person, set a password (typed
  once, never shown), make admin, make member (choosing their profiles in the same step, as the hub
  requires), a member's profiles, disable/enable, delete after a question. Below: everyone's **linked
  messaging accounts** (remove after a question) and the **lockouts** (address, reason, attempts,
  until when; unlock one or all). **Profiles**: the list with current/default marks and counts; a new
  profile from scratch or as a copy of one chosen, the slug following the name; **rename** (never the
  id; Hermes's own words when it refuses); **archive** after a question that says what stays;
  **export** asks with or without providers (warning about keys in the clear), follows the job,
  downloads the archive and hands it to the share sheet (Android also saves to Downloads);
  **import** picks an archive from the phone's files, suggests slug and name, says what will be made
  and asks once more, uploads it and follows the job. Export and import name the profile you are in
  (`X-Hub-Profile`), as the web's do. **Push senders** (admin, folded at the bottom of Device
  connections): each sender's state, source and devices, what is stored without a secret; setup is
  file first — the service-account JSON or `AuthKey_….p8` picked from the phone's files and checked
  there (google-services.json and other wrong files said so; the key id taken from the file name),
  with paste instead, Key ID / Team / bundle / environment for APNs, a stored secret kept when left
  empty, the hub's verdict after saving, forget after a question. **Pairing requests**: an admin's
  pending sheet (the bell) now also lists senders waiting to pair with the profile's channel agent,
  approved or denied there. Android: JVM tests against a scripted hub and Robolectric pictures; iOS:
  unit tests on the CI simulator; **not yet tried on the owner's phones**.
- **Files (the profile's working folder) on both phones** (since 2026-09-27,
  `docs/changes/2026-09-27-twuijri-apps-files.md`, apps night batches 11 and 13), as the web's Files
  tool has it (§65); Android no longer opens it on the web and iOS no longer shows "coming later".
  Browse by the folder trail (the profile's name, each folder, «Up», Android's back walks up), search
  and sort the folder (name, newest, largest; folders first), each entry with its kind, size and time
  and a badge for a link (one that leads out cannot be opened). A file opens the way a chat's file
  opens — the chat's opener is reused, with a new kind of hub file for the profile's folder: pictures
  drawn, documents in the phone's viewer, sound and video streamed from a ticket; a text file opens
  in the shared editor, which saves against the file's etag and offers **Reload** when it changed on
  disk. **Share** (iOS: the share sheet, «Save to Files»), **save to the phone** (Android's Downloads),
  **share a folder as a zip**, and **attach to a chat** — a new one or one of the profile's eight
  most recent (since the leftovers task, `docs/changes/2026-09-27-twuijri-apps-leftovers.md`): the
  hub makes the attachment (`knowledge.attachWorkspaceFile`), nothing is downloaded or uploaded
  again, and the chosen chat opens with the file ready in its composer (a hand-off kept one minute,
  for that profile only, as the web's). **Upload** files or photos and videos, one at a time with a progress
  bar, checked against the hub's cap first, asking to replace a name already there. **New folder**,
  **new text file**, **rename**, **move**, **copy** (as a path) and **delete** after a question. The
  hub's refusals are said in one line of the page's own words (not an owner or admin, already there,
  too large, not text, outside the profile's files…). Not built: resumable
  upload of a big file (the contract has one multipart upload for these files, capped by the hub; the
  resumable flow belongs to chat attachments). The shared editor's conflict check now also reads the
  hub's `409` with `details.reason = changed` (it only knew a `changed` code, which the hub never
  sends for these files), so Reload shows on any page of the shared editor whose refusal carries it. Android: JVM tests against a
  scripted hub and Robolectric pictures; iOS: unit tests on the CI simulator; **not yet tried on the
  owner's phones**.
- **Models extras on both phones** (since 2026-09-27, `docs/changes/2026-09-27-twuijri-apps-models.md`,
  apps night batch 15), as the web's Models page has it. **Providers**: a provider opens on a page of
  its own (iOS) or a sheet (Android) with who it is for, its kind, address, key state and when its list
  was fetched; where the list came from (§83) — «from your account» for a signed-in provider, «a
  fallback list kept in code» with the reason, the catalogue's error, a refresh in progress; enable
  switch, **edit** (name, address, a new key as a secret field that can be shown — empty keeps the
  key), sign in / sign in again, **test** with the provider's words and the time, **refresh the model
  list** (read back until it is no longer loading), **remove the key** (asked) and **remove** (asked);
  its models with a **display name** each (`models.putModel`, the id encoded once as the web does so
  `a/b` ids stay one segment), image-only and hidden ones marked; «refresh all model lists».
  **Adding**: who it is for first, a preset already added in that scope is not offered (a second is
  `409`), a key already on file makes the key optional (§94), a **custom OpenAI-compatible endpoint**
  (chat, speech to text or text to speech), a loopback address on a hub in a container called out
  with the host alias. **Sign-in by device code** says declined / ran out / did not finish with the
  runtime's reason and can start again. **Defaults**: «from the default profile» per role, clearing
  the chat model back to the default profile's, the fallbacks need a chat model first and a chain
  saved on an inherited chat model saves that model too (as the web), and the **auxiliary roles**.
  **Speech**: each side's **model** (the provider's own list of its kind, or typed, or the provider's
  default) and **language** (detect, popular languages by name, or a typed code), the voice list says
  when it is documented or absent and takes a typed voice id. **Images**: only models that draw on
  providers that draw, image-only first (§87, §110), the subscription's named «Images via your …
  subscription», «from the default profile», and going back to it. Not on the phones: visible-model
  lists and per-model tuning, the inheriting agents list (models probe — «Fetch» — and the Runtime
  card are on iOS since 2026-09-27, below); **signing out** of a signed-in provider has no contract operation (the web
  has none either). Unit tests on both, Android shots; not yet tried on the owner's phones.
- **Every iPhone section works in the app on its own** (since 2026-09-27, owner's requirement;
  `docs/changes/2026-09-27-twuijri-ios-self-sufficient.md`, iOS only): no screen or button sends the
  person to the hub's web pages any more, and no control saves something the app then ignores.
  **Settings → Linked hubs** (invite, use an invite, approve/refuse, on/off, questions per hour,
  rename, their agents and one question, the log, unlink; which agents may be asked) and
  **Settings → Terminal** (owner, only when `GET /terminal` answers 200: the sessions as tabs, a
  VT100/xterm screen written in the app, Esc/Tab/Ctrl/arrow keys, copy and paste, re-attached after a
  dropped connection) are phone pages (`navigation.json` gives both `ios`). **WhatsApp pairing by QR**
  is drawn on the phone (mode first, the code redrawn as Hermes replaces it, leaving cancels the job).
  A link in a reply to one of the hub's own pages opens that page in the app. **Display** is honoured
  in the chat: reasoning and tool steps shown or not, compact, text size, links in the app or Safari,
  what sending does while the agent works. **Workflows** are drawn, edited (steps as a list, what
  follows each, the hub's check as you type), copied, deleted, their limits changed, a run re-run from a
  step and a waiting approval's question shown. **Chat list**: categories (make, rename, colour,
  reorder, delete, move a chat) and the conversations Hermes keeps on each channel (read-only
  transcript with pictures and older pages, hide/show again, an admin's delete, «Continue in Core
  Hub»). Also: the **Runtime card** and «Fetch» on Models, the **updates shelf** and source (admin),
  a task's **worktree** and **hand-over** to another profile, the pairing code saying when it was
  claimed, the conversation's **trajectory**, the composer's **`/` commands**, three **starters** in an
  empty chat, and the task board and Schedules following `/rt/tasks` and `/rt/schedules`. Since the
  follow-up (`docs/changes/2026-09-27-twuijri-ios-self-sufficient-2.md`): chats **dragged into an
  order** kept on the phone per view (and Move up/down in a chat's menu; a chat dropped on a
  category's heading is filed there), the **message queue** strip (a message sent while a turn runs
  on «wait in line» waits on the phone: send now, steer, remove; sent in order as turns end), **jobs
  heard live** on `/rt/jobs` (a followed job wakes at once, the Agents page reads again on
  `agent.updated`), the trajectory's **timeline** (lanes, idle folded, parallel calls on their own
  rows, a bar finds its step) and **session log** download, a **skill picker** after `/skill `, and
  a workflow agent step's **model** from the profile's catalogue. Unit tests
  on the CI simulator; **not yet tried on the owner's phone or hub**.
- **A turn's tool activity, all three clients** (since 2026-09-26, DECISIONS §111, proposed — owner
  to confirm; `docs/changes/2026-09-26-twuijri-tool-activity-collapse.md`): while the agent works,
  only the latest steps are in view — four on the web, two on the phones — plus any step still
  running or that failed, with the rest behind one "+k earlier steps" line; a new step slides in
  (nothing moves under reduced motion). When the turn ends every step folds into one row — how
  many, how long, how many failed in red, the latest tools' names — that opens to the full list.
  Web: unit tests and a browser journey; Android: JVM tests and Robolectric pictures of the live
  window and the folded row; iOS: unit tests in CI (not built locally). **Not yet tried on the
  owner's phones.**
- **App Store listing for the iPhone and iPad app** (since 2026-09-26, owner's decision of
  2026-09-25; `docs/store/apple/README.md`): the listing in English and Arabic
  (`apps/ios/fastlane/metadata`, name «كور هب» in Arabic), held to App Store Connect's limits by
  `apps/ios/scripts/store-metadata.mjs` in CI; a privacy policy (`docs/privacy.md`,
  `docs/privacy.ar.md`) with the App Privacy answer «Data Not Collected» and a proposed age rating;
  review notes (`docs/store/apple/review-notes.md`) and the owner's submission steps
  (`docs/RELEASING.md`). Screenshots come from an XCUITest run (`ios-screenshots.yml`, by hand)
  against a demo hub inside Debug builds (`-UITestDemo YES`, answers checked against the contract),
  at iPhone 6.9" 1320 × 2868 and iPad 13" 2064 × 2752 in both languages — **28 taken and looked at
  in a run on the branch**. Uploading the listing and screenshots (fastlane deliver, never a build or
  a submission) is behind an `upload` switch. `ios-submit.yml` (by hand, since 2026-09-27) readies
  a version through the App Store Connect API — build, age rating, free price, availability
  (without China mainland, proposed), content rights, manual release — and lists what only the
  owner can enter (App Privacy, App Review contact and demo account); its `submit` switch submits
  only when nothing is missing. Tested against a fake App Store Connect; see
  `docs/changes/2026-09-27-twuijri-app-store-submit.md` for the real run.
- **Download page** (`site/`, since 2026-09-26): one static page for
  https://twuijri.github.io/core-hub/, Arabic first with an English toggle, light and dark with the
  system, no trackers. The browser reads the latest release from the GitHub API and offers its
  `.exe`, Apple silicon `.dmg`, AppImage, `.deb` and `.apk` with version, date and sizes. It
  highlights the visitor's system, falls back to the releases page when the API cannot be read,
  shows the Microsoft Store, Google Play and App Store as *Coming soon* behind switches in
  `site/src/config.js`, and has a "Run your own hub" section. `pages.yml` deploys it; **it is not
  live until the owner sets Settings → Pages → Source to "GitHub Actions"** (`docs/RELEASING.md`).

## Languages
Since 2026-09-28 (ADR 0028, proposed — owner to confirm) the UI languages come from **one
registry, `locales/languages.json`** — only Arabic and English are in it, so nothing a person sees
changed. The web client, the desktop app, the hub's error messages and the CLI read the list, the
direction, the fallback chain (a missing key reads in English, never as a raw key) and the number
locale (Latin digits, §113) from it; `pnpm i18n:new <code>` adds a language to all four, `pnpm
i18n:check` keeps Arabic/English strict and reports every other language's coverage, and `pnpm
i18n:limits` measures each translation against the room its label has (`locales/limits.json`, 56
labels measured in the running web client; HarfBuzz with the Noto fonts in CI). Four test-only
pseudo-locales (`en-XA`, `ar-XB`, `zh-XC`, `th-XD`) walk 18 main screens at desktop and phone width
in the web journeys and fail on spilled, clipped or lone-letter labels, overlapping controls and
sideways scroll. With a third language the language switch becomes a menu and Display a list —
proven by unit tests with a stand-in registry, not yet with a real translation. The hub keeps
storing `ar`/`en` as a person's `locale` (the contract's enum). Since phase 2
(`feat/i18n-languages-apps`) the phones read the registry too: Android's strings are JSON
catalogues in `apps/android/i18n` with the resources generated at build time (the compiled
resources identical to before), a per-app language list for Android 13+ (`locales_config`), and
iOS's `AppLanguage`, fallback chain, `InfoPlist.strings` and `CFBundleLocalizations` from the same
file; Android's Robolectric test walks 10 screens in the four pseudo-locales and fails on text cut
without an ellipsis or a lone letter; iOS's XCTest keeps a chip one line in each. iOS builds and
tests run in CI only.

## Name
Since 2026-09-24 the product is **Core Hub** («كور هب», ADR 0017): packages `@corehub/*`, the
command `corehub`, `COREHUB_*` variables, image `ghcr.io/twuijri/core-hub`. Every name it had
as Majlis is still read where something older may say it — `MAJLIS_*` variables, `majlis.*`
browser keys, `~/.config/majlis`, the `majlis` command, tokens signed as `majlis`, Hermes
provider blocks `majlis-*` (moved to `corehub-*` with every reference to them at boot) and
archives with `majlis-providers.json` — proven by unit and integration tests, not yet on the
owner's test stack.

## Version
Since 2026-09-26 every deliverable carries **one version, 1.1.0**, the root `package.json`'s
(owner: «خل كل النسخ تبدا من 1.1.0»): the hub's `/health` and `/meta` (the root version when the
image stamps none), the web client, the image label, the desktop app, the Android `versionName`
(read by Gradle) and the iOS `MARKETING_VERSION`. `pnpm version:check` fails in CI on any copy
that differs, and on a `v*` tag that does not match. Signed Android/iOS builds are numbered run
number + 100, above the old app's 63; a manual preview image reports `1.1.0-preview.<run>`. Not
yet seen on a signed build or a published image: no signed workflow or release has run since
(docs/RELEASING.md).

## Compatibility
Since 2026-09-27 **nothing people already run may break** (ADR 0027, owner). Two guards in CI
compare every pull request with the latest release tag: `pnpm contracts:compat` (the OpenAPI
document, its webhooks and the realtime event schemas — removed, renamed, newly required,
narrowed input, weakened output) and `pnpm migrations:guard` (released migrations unchanged;
nothing released dropped, renamed or emptied). An unavoidable break passes only when the owner
lists it in `docs/contracts/breaking-approved.json` (empty today). Proven by their tests and by
the real history: against v1.1.2 the contract guard reports the webhook operations that became
profile-scoped in v1.1.3; against v1.1.1 the removed preset, relay and peer fields. Meaning,
environment names, release file names, socket commands and the models catalogue are review
items, not checked by a machine.

## First run
A hub with no owner is **open to the first comer for an hour** after the process
starts (ADR 0019, `COREHUB_SETUP_OPEN_MINUTES`, `0` = token only): `/setup` in the
browser or `corehub setup` in a terminal creates the owner from a name and a
password, and the screen says it is open and shows the time left. After the hour
the claim token the hub writes to `<DATA_DIR>/setup-token.txt` and logs is
required (ADR 0011); restarting the hub opens a fresh hour. `meta.get` carries
`setup_open` / `setup_open_until`. Somebody else got there first:
`COREHUB_RESET_OWNER=1` and a restart disables that owner (stepped down to a
disabled admin, tokens revoked, nothing deleted) and reopens setup — once, thanks
to the marker `owner-reset.json`. `HUB_ADMIN_PASSWORD` still creates the owner
unattended and skips the screen.

Since 2026-09-28 the **desktop app's own hub** (local mode) has «نسيت كلمة المرور؟» /
"Forgot password?" on its sign-in screen (DECISIONS §131; design approved, defaults proposed —
owner to confirm): the operating system confirms the person (Touch ID or a Mac administrator's
password, Windows Hello, polkit), the owner's username is shown in monospace, and a new password
ends the owner's sign-ins on other devices (web sessions, paired phones and computers, their push
and live connections — personal tokens, provider keys, MCP, channels and Hermes are untouched),
signs the app in and is audited. The hub accepts it only over the IPC channel of the app that started it — no HTTP
route. The same channel signs the owner in without a password on that computer when This device
→ «الدخول دون كلمة مرور على هذا الحاسوب» is on (on for a new install, off for an existing one).
Tested with the OS prompt faked (server, desktop unit and the desktop smoke run under Xvfb);
**never run against a real Touch ID, Mac password dialog, Windows Hello or polkit agent**. A hub
in Docker has no such recovery yet (recovery codes or a command in the container, the owner's
choice later).

## Runtime
A fresh install has **two** agents (ADOPTION-BACKLOG §2.15, owner's decision of
2026-09-22):

- **Hermes** runs inside the image, supervised by the hub (ADR 0008). Since
  2026-09-25 the image also carries the dependencies of the two channels the hub
  links itself — Hermes's Telegram client (the exact pin of Hermes's
  `platform.telegram`) and the WhatsApp bridge's `node_modules` — so linking either
  downloads nothing; each profile's bridge copy links to the image's
  (`modules/agents/whatsapp-bridge.ts`). The image grew from 259.2 MB to 284.3 MB
  compressed. Since 2026-09-25 Discord's and Slack's clients (Hermes's own pins) are in the
  image too: 284.4 → 292.0 MB compressed. Matrix's would have made it 299.9 MB, so it is still
  downloaded by Hermes the first time a Matrix channel starts. Since
  2026-09-23 a conversation reaches it over its **TUI gateway** (ADR 0013), the
  surface Hermes's own apps use: the model's reasoning, each tool's arguments and
  result, and the questions Hermes asks (`clarify`) reach the screen, a question
  as a card above the composer. A Hermes reached from outside the container keeps
  the API server's run surface, without those three.
- **Direct** («مباشر») is the hub itself: a turn is one request from the hub to
  the model provider, with no runtime in between. It runs no tools — skills and
  MCP over this path are backlog §2.16 — and it inlines a text attachment or
  sends an image to a model that accepts one, refusing anything else by name
  (`docs/domain/models.md` §الاتصال المباشر). Its conversation lives in the
  server process, so a restart starts a fresh context. Since 2026-09-27 it also
  runs on **providers signed in through Hermes** (DECISIONS §118, proposed —
  owner to confirm): the ChatGPT subscription, Nous Portal, xAI Grok and MiniMax.
  Each turn borrows the sign-in from Hermes's own Python in the profile's Hermes
  home, holds it for that turn only, and sends it on the wire Hermes uses for
  that provider; a hub without Hermes's Python refuses such a turn by name.

Either way a model provider must be configured before anything can answer;
until then a run fails with the provider's own message and a named code, never
silently. Coding agents install on demand from the curated catalog into the
data volume (ADR 0006).

Since 2026-09-29 **a hub starts whatever its volume holds**: mounting the API no longer runs
any agent CLI. The installed agents are checked against the volume once the hub is ready — side
by side, each health check bounded to 10 s, with a closed stdin (an ACP bridge such as
`claude-code-acp` ignores `--version` and serves stdin; held open it hung for 30 s at every boot
and restarted the owner's hub in a loop), its process group stopped at the deadline; a check that
does not end marks that agent `failed` with the reason. The hub waits at most 1 s for them and
goes on serving; every module's mount time over 1 s and every agent check over 0.5 s is logged
by name, and Fastify's `pluginTimeout` is 120 s (`COREHUB_PLUGIN_TIMEOUT_MS`, `0` = no limit).

## Proven against fakes, not yet against the real thing
- A full turn with a real model reply (needs a provider key on the owner's box).
  The direct path is proven end to end against a scripted provider, in the
  container as well as the test suite; a real provider key is still the owner's
  own check.
- The direct agent on a signed-in provider (2026-09-27, §118) is proven against a
  stand-in for Hermes's credential store and scripted backends streaming the real
  wire shapes (Codex and xAI `/responses`, Nous `chat/completions`, MiniMax
  Messages); the credential program was run against the pinned Hermes v2026.9.14
  source with no sign-in (each provider answers `not_signed_in` in Hermes's words).
  Not yet a turn on a real signed-in account.
- The catalog's pinned versions actually installing and starting on a machine. On 2026-09-25
  Qwen Code 0.24.5, Kimi Code 2.1.1 and Pi 0.87.1 with `pi-acp` 0.0.34 were installed with
  the hub's own npm command on a developer machine and each answered ACP `initialize`; not
  yet in the image, and no turn was run (no provider key there). The registry checks and
  auto-update are proven against a scripted registry only.
- Voice (2026-09-25): dictation, read-aloud and voice mode are proven against a scripted
  OpenAI in the browser journey (Chromium's fake microphone) and a real loopback HTTP speech
  server in the server suite; not yet with a real OpenAI key or a real self-hosted Whisper.
- The trajectory's model turns and timings (2026-09-25) are proven against the
  scripted runner (unit, API and browser journey); Hermes's per-turn usage against
  a scripted TUI gateway. Not yet looked at on a real Hermes run; ACP coding agents
  report no usage at all, so their trajectory has times but no token metrics.
- PostgreSQL: the schema is SQLite-shaped so far; the hub refuses rather than
  pretending.
