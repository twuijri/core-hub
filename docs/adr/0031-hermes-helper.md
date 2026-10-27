# ADR 0031 — The Hermes helper: a small agent of the hub's own that looks into Hermes and, when allowed, fixes it

Status: **Accepted** by the owner, 2026-10-28. He asked for it after a friend's Hermes broke and the friend could not fix it alone. He also set the shape himself:
- a small agent beside Hermes;
- three levels the person picks when they ask, coloured green to red;
- the last level can do anything, and says it is dangerous.

The details below that the owner did not name are the implementer's choices.

## Context

When Hermes breaks, the person is left with a chat that does not answer. Hermes can break in many ways:
- it does not start;
- a channel goes quiet;
- a key expires;
- an update leaves its Python broken.

Hermes has its own `hermes doctor`, but a person has to know it exists, find a terminal, and read its report.

The owner asked for something that helps with anything that goes wrong, "like Ekko's agent", and that stays light on the machine.

The hub already has the pieces:
- **The `builtin` adapter.** It runs an agent inside the hub's own process, the `direct` agent.
- **The model gateway (ADR 0029).** It serves OpenAI Chat Completions, with tools, for any model connected in the hub.
- **The `HermesRuntime` supervisor.** It knows Hermes's status, home, program and environment, and it can restart Hermes.
- **Chat cards on every client.** Each one already draws tool calls, approval cards and question cards.

## Decision

### 1. A second agent of the hub's own: `hermes-helper`

The helper is a catalog entry (`catalog/hermes-helper.ts`) with these properties:
- It uses the `builtin` adapter and is `bundled`.
- It has no binary and no process, and adds nothing to the image.
- The `builtin` adapter tells the two agents of its own apart by the catalog id, so no new adapter kind reaches the contract or the clients.
- It is listed with the other agents. A chat with it is an ordinary hub session, with its own transcript.
- It is the hub's own code (`LicenseRef-CoreHub`).

### 2. It never runs through Hermes

The agent it diagnoses may be the one that is down. So the helper reaches models in one of two ways:
- **Through the model gateway**, wire `openai-chat`, with the turn's model resolved as for every agent on the gateway.
- **Through the providers' own path** (`directChat`) when the hub has no gateway. In that case it has no tools. It answers from a snapshot the hub takes itself and sends with the first message:
  - Hermes's status;
  - `hermes doctor`;
  - the end of `logs/errors.log`.

### 3. Three levels per conversation, asked at the start

The first turn asks a question with choices, in the person's language (the user's `locale`):

| Level | Tools | Approval |
|---|---|---|
| 🟢 `check` (default, marked recommended) | `hermes_status`, `hermes_doctor` (no `--fix`), `list_hermes_files`, `read_hermes_file` (inside Hermes's home only) | none: they change nothing |
| 🟡 `fix` | plus `hermes_doctor_fix`, `restart_hermes` (when the hub supervises Hermes), `run_hermes` (any `hermes …` command, as an argument list), `update_hermes` (a personal install only) | every call |
| 🔴 `full` | plus `run_command` (any program, as an argument list, as the hub's user) and `write_file` (an existing file is copied to `<name>.corehub-backup-<time>` first) | every call |

How the level works:
- **Who may give which level.**
  - Red is offered to the owner only. That is the same line the web terminal draws (DECISIONS §70).
  - Admins get green and yellow.
  - Members are refused before anything runs.
  - Typed words never climb above what the person may give.
- **When nobody answers.** A skipped or expired question means green.
- **Raising the level.** The helper can ask to raise it with `request_more_access`. That asks the same question again, offering only the levels above the current one.
- **Scope.** A level belongs to its conversation alone, and every new conversation starts by asking.
- **Approval cards.** Each one shows the exact command or the file to write, with the helper's one-sentence reason. The choices are "Run" and "No". A declined step is told to the model as declined, and it explains the manual way instead.

### 4. Secrets stay on the machine

Every tool output is redacted before the model reads it or the chat shows it:
- values whose name says key, token, secret, password or auth;
- `Bearer` values;
- well-known key shapes (`sk-…`, `AIza…`, `ghp_…`, Telegram bot tokens).

A `.env` file is shown as its variable names with `[set]` or `[empty]`. The instructions tell the helper never to ask for a key in the chat.

### 5. Limits

These limits are stated, and enforced in `adapters/hermes-helper.ts`:
- **Tool rounds:** at most 24 per turn. After that the helper stops and says "continue".
- **Command time:**
  - `hermes doctor` gets at most 3 minutes;
  - any other command gets at most 5 minutes.
- **Output size:**
  - the model reads at most 24,000 characters of one output;
  - the chat shows at most 8,000 characters of it.
- **Files:**
  - files are read whole up to 256 KiB;
  - past that, and for logs, only the end is read, at most 2,000 lines.

### 6. Entry points

- **Web:**
  - Hermes's card in Agents has "Ask the helper".
  - The helper's own card has "Start a chat" and no Settings.
  - A failed Hermes run in a chat offers "Ask the Hermes helper what went wrong" to an admin.
- **Phones:** the helper is in the agent picker of a new chat. The question and approval cards already exist there.

## Consequences

- No contract change. The internal `AgentTarget` gains `userId`, so the helper knows who asked.
- The helper cannot help when the hub itself is down. It can only see what the hub's user can see.
- **In the server image**, Hermes's code is read-only to the hub's user. There:
  - the helper repairs the home (configuration, profiles, keys' presence, the gateway);
  - Hermes itself is updated by updating the image.
- **On a computer**, the person's own install can be updated through `update_hermes`.
- Red can break things. Two safeguards remain:
  - a person's approval for every single command;
  - the backup before every file it writes.
