# Shared models catalogue

`models.json` is read by every running Core Hub from
`https://raw.githubusercontent.com/twuijri/core-hub/main/catalog/models.json`, at most every
twelve hours (DECISIONS §110). A change merged into `main` reaches every hub within a day, with
no new image and no restart. A hub that cannot read it uses the lists built into its image.

`providers` is keyed by the Hermes provider id of a signed-in provider (`openai-codex`,
`xai-oauth`, `nous`, `minimax-oauth`) or the preset slug of a key provider (`anthropic`,
`openai`, `google`, `groq`, `mistral`, `deepseek`, `xai`, `openrouter` …). Each entry may hold:

- `models`: the provider's models. A list the provider answers for the account always wins; this
  one is offered only when the provider cannot be asked, instead of the list built into the image.
  Write ids exactly as the provider's API takes them.
- `image_models`: image models a chat provider draws with but never lists (today only the ChatGPT
  subscription's; `gpt-image-…` / `chatgpt-image-…` names). A name removed here disappears from
  every hub's list on its next refresh.
- `client_version`: the lowest Codex CLI version the subscription's list is asked as. Hubs also
  follow the newest openai/codex release by themselves; this is a floor.

Change it by pull request like any other file;
`packages/server/src/modules/models/models-catalog.test.ts` checks it parses. A hub owner can stop
the reads with `COREHUB_MODELS_CATALOG_URL=off`, or point them at an own copy (`https://` only).
