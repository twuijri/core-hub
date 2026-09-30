# Use any model with any agent

Add a provider once in **Settings → Models**, and every coding agent in Core Hub can run on its
models — Claude Code on a DeepSeek or Qwen model from OpenRouter, Codex on Groq, OpenCode on your
own LM Studio — picked per conversation in the model picker, like Hermes. This is the hub's **model
gateway** (ADR 0029, DECISIONS §140–141).

## How it works, in one paragraph

When the hub starts a coding agent for a conversation, it gives it the address of the gateway on
this computer and a session token — never a provider key. The agent asks for "Core Hub's model"; the
gateway answers with the model you picked for that message, from the provider you added, and
CLIProxyAPI (an open-source translator the hub carries and runs itself, MIT) converts between the
agent's wire and the provider's: Claude Code speaks Anthropic Messages, Codex OpenAI Responses, Gemini
CLI the Gemini API, and most providers OpenAI Chat Completions — tools and streaming included. The provider keys stay in the
hub. What each conversation used shows in its run, with an estimated cost when the model has prices.

## Which agents

| Agent | On the hub's models |
|---|---|
| Claude Code | yes (tested with the real agent, tool calls included) |
| Codex CLI | yes (tested with the real agent) |
| Gemini CLI | yes (tested with the real agent, tool calls included; version 0.60.0 or newer) |
| Goose, OpenCode, Qwen Code, Kimi Code | yes (tested with the real agents, tool calls included) |
| Grok Build, Pi | yes (tested with the real agents, tool calls included; the hub keeps one entry in their own settings file, below) |
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

When the agent is on the hub's models, its model picker — on the web and in the phone apps — lists
every model the gateway can serve, and "Default · …" is the profile's default model. A model whose
provider says it cannot call tools is left out (a coding agent works through tools), and a model
whose context window is smaller than the agent needs says "small context" (64K for Claude Code,
Codex, Gemini CLI and Grok Build; 32K for Goose, OpenCode, Qwen Code and Kimi Code; 16K for Pi). If there is no model to give it at all (no model
picked and no default set), the agent uses its own account.

## What the hub writes in an agent's own settings

Most agents take the gateway from variables alone. Three need one entry in their own files, which
the hub writes and keeps up to date — only that entry; everything else in the file stays as you
wrote it, and no key is ever written (the entry names the variable the session token is in):

- **Grok Build**: a `[model.corehub-gateway]` table between two `# >>> Core Hub model gateway` /
  `# <<< Core Hub model gateway` lines at the end of `~/.grok/config.toml`. Core Hub picks it with a
  variable; your own default model stays yours.
- **Pi**: a `corehub-gateway` provider in `~/.pi/agent/models.json`; the conversation is switched to
  it without changing Pi's saved default.
- **Gemini CLI**, only when you signed in to it with Google or Vertex: it runs in a home of Core
  Hub's own (under the hub's data folder) whose `.gemini` links to every file of yours and holds a
  copy of your `settings.json` saying "gateway". Your own files are not changed. (Not on Windows:
  there a signed-in Gemini CLI keeps its own account.)

The entries stay when the agent later runs on its own account; without Core Hub's token they do
nothing. If the file cannot be read as its format, or already has an entry of that name you wrote,
the hub leaves it alone and the agent uses its own account; the hub's log says why.

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

## Subscriptions (sign in instead of a key)

Settings → Models → **Add provider → Sign in with a subscription** lists every subscription the
hub's gateway can sign in to (DECISIONS §143, ADR 0030): ChatGPT, Claude, xAI Grok, Kimi Code,
Meta AI, Google Antigravity and Devin.

- **By a short code** (ChatGPT, xAI, Kimi, Meta): open the page shown, type the code, done. It works
  from a phone and from a server with no browser.
- **By a link** (Claude, Antigravity, Devin): open the page, sign in; your browser then goes to an
  address such as `http://localhost:54545/callback?code=…` that may not load — copy that whole
  address from the address bar and paste it into the hub.
- Sign in again under the same provider to add **another account**; the gateway uses them in turn,
  and one that hit its limit waits for its reset while the others answer.
- Click the provider's card to open its **accounts dialog**: each account's status and last error,
  its usage windows with what is left and when each resets (Claude and ChatGPT), its requests over
  the last 3 h 20 min, and **Check now** (asks the vendor; best effort — the vendors do not document
  those addresses). Renew, turn off or sign out an account there.
- Every agent can use a subscription's models, the hub's own agent and Hermes included.
- Some vendors limit using a subscription outside their own apps. The hub does not decide for you.

A ChatGPT or xAI subscription signed in to through Hermes (the older way) keeps working; its card
offers **Move to Core Hub's gateway**, which signs in once more (a sign-in cannot be copied) and
then moves your model choices to it.

**Hermes uses Core Hub's models** (the switch at the top of Settings → Models): Hermes then reaches
every model the gateway serves through it, subscriptions included; turn it off to give Hermes its
own providers again. New hubs start with it on; hubs that already had providers keep Hermes as it
was until you switch.

## If a message fails

- "a Core Hub session token is required" — the agent's process outlived its session; send the message
  again (the hub starts the agent afresh).
- "… is not available to agents through Core Hub" — the model's provider has no key or signed-in
  account, or it is a subscription signed in to through Hermes (move it to the gateway on its card);
  pick another model or switch the agent to its own account.
- "no model is chosen for this conversation" — pick a model, or set a default in Settings → Models.
- "<provider> ran out of quota for <model>. Pick another model for this chat." — the provider said the
  model's quota (or credit) is spent. The chat says so within seconds instead of retrying for minutes,
  with a button that opens the model picker. If the profile has a fallback chain (Settings → Models →
  Defaults), the turn moves on to its next model by itself and the chat shows which one answered.
- A provider's other errors (a passing rate limit, a bad key) are shown as the provider said them,
  without the hub's internal names for its providers.
