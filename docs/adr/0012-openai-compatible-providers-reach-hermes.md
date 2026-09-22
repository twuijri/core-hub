# ADR 0012 — A provider Hermes has no slug for still reaches it, or the hub refuses out loud

Status: accepted (2026-09-22)
Supersedes: ADR 0010 §3, the `hermesProvider: null` clause ("the hub writes **no** model
selection and logs which provider it could not express")

## Context

ADR 0010 gave the hub the credential store and the job of propagating it. For Hermes it made
one honesty rule: a catalogue entry declares `hermesProvider`, and on `null` the hub writes
nothing and logs the provider it could not express, rather than writing a slug that would bill
the wrong account. The reasoning was right — Hermes's `openai` is an alias of OpenRouter, so a
guessed slug is a real hazard.

The scope was wrong. `null` did not only cover "a provider Hermes cannot talk to". It covered
every provider that is simply an OpenAI-compatible endpoint: cli-proxy-api, LM Studio, LiteLLM,
Ollama, a generic OpenAI-compatible URL, and any endpoint the person types in themselves. On
2026-09-22 the owner's workspace had `custom-cli-proxy-api` as its chat default and the hub
wrote another provider's model into `config.yaml`; the only record of the decision was one log
line inside a container. Worse, a key saved against such a provider never entered the `.env`
plan at all, because the catalogue entry named no environment variable for it.

Reading Hermes Agent's MIT source in the image (`/opt/hermes/src`, recorded in
`docs/inspirations/hermes-agent.md` §ي) shows the refusal was not honesty but a gap:

- `config.yaml` accepts a `providers:` map. A block under it is parsed by
  `hermes_cli/config_providers.py`; `_KNOWN_PROVIDER_KEYS` names `name`, `base_url`, `key_env`
  and `api_mode` among the keys it understands, and warns about anything else.
- `hermes_cli/runtime_provider_custom.py` §`_match_new_style_provider` resolves such a block at
  run time and reads the credential from the environment variable named by `key_env`.
- `_shadowed_by_builtin()` discards a block whose name is a built-in provider's canonical name.
  `lmstudio` is one of those names, so a block named after the provider would vanish silently.

So there is a documented route for exactly the providers we were skipping, and a documented
trap in naming the blocks after them.

Clean room (ADR 0004): the source read here is Hermes Agent, MIT, the runtime this product
supervises — not Hermes Studio / Ekko Studio, and not the owner's fork of it. No code was
copied. ADR 0004 needs no amendment for this; it never restricted reading Hermes Agent, and
ADR 0008 and ADR 0010 were written from the same source.

## Decision

1. **Every catalogue entry declares a `hermesRoute`, not a slug-or-null.** `builtin` (Hermes's
   own provider id), `openai-compatible` (a block the hub writes under `providers:`), or
   `none`. A provider row with no catalogue entry — an endpoint the person described
   themselves — is `openai-compatible`, which is precisely the shape that used to reach Hermes
   as nothing at all.
2. **Every block the hub writes is named `majlis-<slug>`.** The prefix is not cosmetic: without
   it `_shadowed_by_builtin()` throws the block away for any name Hermes also uses. The hub
   writes only `name`, `base_url`, `key_env` and `api_mode` — the keys Hermes documents — so a
   file we wrote never makes Hermes warn about it. A block a person wrote by hand is left
   exactly as it is, and only our own blocks are removed when their provider goes away.
3. **A key with no global variable name gets a minted one.** `MAJLIS_PROVIDER_<SLUG>_API_KEY`,
   owned by that one row, named by its block's `key_env`. Before this, such a key was not
   written anywhere.
4. **The remaining refusals are visible, not logged.** A chat default the hub genuinely cannot
   express to the runtime is rejected at the point the person sets it, naming the provider —
   `provider_not_configured`, not a silent accept. Nothing is skipped with only a log line.
5. **`config.yaml` is opened and written once per propagation** — the blocks and the model
   selection together. Two writes leave a window in which a crash points Hermes at a block that
   does not exist yet. An unparseable file is refused outright rather than rewritten, and no
   file is created when there is nothing to say.

## Alternatives rejected

- **Keep ADR 0010 §3 as written.** Honest about slugs, silent about the user's actual choice
  being discarded. The owner's own workspace is the counter-example.
- **Write Hermes's `openai` slug for an OpenAI-compatible endpoint.** That slug is OpenRouter.
  This is the billing hazard ADR 0010 was right about, and it stays rejected.
- **Name the blocks after the provider (`lmstudio`, `litellm`).** Hermes discards a block whose
  name is a built-in's canonical name; `lmstudio` is one. The prefix is the fix.
- **`hermes config set providers.<name>.base_url …` per field.** The supported CLI path, but a
  Python process per field on every save, and it needs the binary even when the runtime is
  absent. We match the file semantics instead and say so, as ADR 0010 already does for `.env`.

## Consequences

- LM Studio, LiteLLM, cli-proxy-api, Ollama and any typed-in endpoint can be the workspace's
  chat default and actually be what Hermes runs.
- Hermes's home gains `majlis-*` blocks and `MAJLIS_PROVIDER_*` variables. On a rollback they
  are inert text that nothing reads; deleting them by hand is safe.
- The catalogue guard now fails a `llm` entry that is not expressible at all, a Hermes provider
  id with no route, and a `builtin` route with no id — so the next entry cannot reintroduce the
  gap by omission.
- Ollama is the one entry with a base-URL suffix: our own adapter speaks its native API, Hermes
  speaks its OpenAI-compatible one under `/v1`.
