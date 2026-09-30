# Use any model with any agent

Add a provider once in **Settings → Models**, and every coding agent in Core Hub can run on its
models — Claude Code on a DeepSeek or Qwen model from OpenRouter, Codex on Groq, OpenCode on your
own LM Studio — picked per conversation in the model picker, like Hermes. This is the hub's **model
gateway** (ADR 0029, DECISIONS §140).

## How it works, in one paragraph

When the hub starts a coding agent for a conversation, it gives it the address of the gateway on
this computer and a session token — never a provider key. The agent asks for "Core Hub's model"; the
gateway answers with the model you picked for that message, from the provider you added, and
CLIProxyAPI (an open-source translator the hub carries and runs itself, MIT) converts between the
agent's wire and the provider's: Claude Code speaks Anthropic Messages, Codex OpenAI Responses, and
most providers OpenAI Chat Completions — tools and streaming included. The provider keys stay in the
hub. What each conversation used shows in its run, with an estimated cost when the model has prices.

## Which agents

| Agent | On the hub's models |
|---|---|
| Claude Code | yes (tested with the real agent, tool calls included) |
| Codex CLI | yes (tested with the real agent) |
| Goose, OpenCode, Qwen Code, Kimi Code | yes (tested with the real agents: a text turn each) |
| Gemini CLI, Grok Build, Pi | not yet — they use their own account (later phases) |
| Hermes, Core Hub (Direct) | they already run on every provider you add |

## Choosing, per agent

Open the agent → **Settings** → **Models** → **Model source**:

- **Automatic** (the default). In the container image: the hub's models. On your computer (the
  desktop app): the hub's models, unless the agent is signed in to its own account there (for
  example `claude login`), in which case it keeps that account.
- **Core Hub's models**: always the gateway.
- **The agent's own account**: as before the gateway — its own sign-in, its own settings, or the
  key of its own vendor from Settings → Models.

The agent's card says which one it uses ("Models: Core Hub's providers" / "Models: the agent's own
account"). A change applies from the next message.

When the agent is on the hub's models, its model picker lists every model the gateway can serve,
and "Default · …" is the profile's default model. If there is no model to give it at all (no model
picked and no default set), the agent uses its own account.

## What is not shared

- A subscription you signed in to **through Hermes** (ChatGPT/Codex, xAI, MiniMax, Nous) is not lent
  to other agents; those models do not appear in a coding agent's picker when it is on the hub's
  models.
- CLIProxyAPI's own subscription sign-ins are switched off; the hub gives it only the API-key
  providers you added.

## Good to know

- **Anthropic does not support Claude Code on non-Claude models.** It works through the gateway, but
  features that call Anthropic directly (the WebSearch tool, fast mode) do not, and quality depends on
  the model's tool use. Pick models that support tools and have a large context (64K+ for Claude Code).
- A repository's own `.claude/settings.json` can set `ANTHROPIC_BASE_URL` itself; that repository's
  choice wins, as it always did.
- The gateway listens on `127.0.0.1` only, on a port of its own; nothing outside the computer (or the
  container) can reach it, and it answers nothing without a live session token.
- **Operators:** `COREHUB_MODEL_GATEWAY=off` switches it off (agents get the profile's keys as
  before); `COREHUB_AGENT_MODEL_SOURCE=hub|auto` sets what Automatic means; the image carries
  CLIProxyAPI at `/opt/corehub/bin/cli-proxy-api`. See `docs/DEPLOY.md`.
- **Developers:** run `pnpm cliproxy:fetch` once; the hub finds the copy in
  `~/.cache/corehub/cliproxy/`. Without it, coding agents use their own accounts and the log says why.

## If a message fails

- "a Core Hub session token is required" — the agent's process outlived its session; send the message
  again (the hub starts the agent afresh).
- "… is not available to coding agents through Core Hub" — the model's provider has no key, or it is a
  subscription signed in to through Hermes; pick another model or switch the agent to its own account.
- "no model is chosen for this conversation" — pick a model, or set a default in Settings → Models.
- A provider's own error (rate limit, bad key) is shown as the provider said it.
