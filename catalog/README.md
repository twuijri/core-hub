# Shared models catalogue

`models.json` is read by every running Core Hub from
`https://raw.githubusercontent.com/twuijri/core-hub/main/catalog/models.json`, at most every
twelve hours (DECISIONS §110). A change merged into `main` reaches every hub within a day, with
no new image and no restart. A hub that cannot read it uses the lists built into its image.

## Keys

`providers` is keyed by the name a hub looks the provider up by:

- a provider used by **signing in** — its Hermes provider id: `openai-codex`, `xai-oauth`,
  `minimax-oauth`;
- every other preset — its **preset slug** from
  `packages/server/src/modules/models/catalogue.ts`: `anthropic`, `openai`, `google`, `deepseek`,
  `xai`, `groq`, `mistral`, and the speech presets `openai-stt`, `openai-tts`, `groq-stt`,
  `groq-tts`, `elevenlabs`, `elevenlabs-stt`.

Not `gemini` for Google or `openai-api` for OpenAI: those are Hermes's names, and a hub looks a key
provider up by its preset slug. No entry: presets whose address the person types (Ollama,
LM Studio, LiteLLM, an OpenAI-compatible endpoint), aggregators with a per-account or very long
list (OpenRouter; Nous Portal, whose list of 400+ ids is public without a key, so a hub can always
ask it), Deepgram (its list is public without a key too) and Azure Speech (voices, no model ids).

Each entry may hold:

- `models`: the provider's current models, newest and most capable first, written exactly as the
  provider's API takes them (`claude-opus-5-5`, not `claude-opus-5.5`). A list the provider
  answers for the account always wins; this one is offered, marked "fallback", only when the
  provider cannot be asked, or when it has no list endpoint at all (ElevenLabs Scribe), instead of
  the list built into the image. A speech preset's list holds only that preset's kind of models.
- `image_models`: image models a chat provider draws with but never lists (only the ChatGPT
  subscription's; `gpt-image-…` / `chatgpt-image-…` names). A name removed here disappears from
  every hub's list on its next refresh.
- `client_version`: the lowest Codex CLI version the subscription's list is asked as (only
  `openai-codex`). Hubs also follow the newest openai/codex release by themselves; this is a floor.

Nothing else: a hub ignores other fields, and the test below refuses them.

## Adding or changing a provider's list

1. Read the provider's **own** documentation: its models page and its deprecations page. Not a
   third-party list. Leave out ids that are deprecated, retired, invite-only or a preview replaced
   by a released model.
2. Edit `models.json` and set `updated` to the day you checked. The change record of the pull
   request says which page each id came from and when it was checked
   (`docs/changes/2026-09-26-twuijri-models-catalog-providers.md` is the first).
3. Run `pnpm --filter @corehub/server exec vitest run src/modules/models/models-catalog-file.test.ts`:
   every key must be one a hub looks up, every id must pass the id rules, and nothing a hub would
   drop may be in the file.

A hub owner can stop the reads with `COREHUB_MODELS_CATALOG_URL=off`, or point them at an own copy
(`https://` only).

## The weekly watcher

`.github/workflows/models-catalog-watch.yml` runs every Monday (and by hand) and
`scripts/models-catalog-watch.mjs` compares this file with public lists kept by others — today
CLI Proxy API's catalogues (`router-for-me/models`: `models.json` sections `claude`, `gemini`,
`aistudio`, `codex-*`, `xai`, and `codex_client_models.json`) and its Codex image names. It keeps
**one** open issue, labelled `models-catalog`, listing ids seen there but not here and ids here
that no source lists any more, and closes it when there is nothing to report. It never edits this
file or pushes: a person checks each id against the provider's own documentation and opens a pull
request. An id already decided on — a retired model a source still lists, or one of ours a
source never lists — goes into `watch-ignore.json` under its provider key, and is no longer
reported either way.

Run it by hand: `node scripts/models-catalog-watch.mjs`.
