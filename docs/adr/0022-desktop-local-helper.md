# ADR 0022 — The desktop app's local helper: an MCP server for this computer, off by default

Status: **proposed — owner to confirm** (2026-09-25). Builds on ADR 0009 ("a small local
helper inside the app exposes the machine to the hub as MCP tools … optional, off by default,
and shows what it exposes").

## Context
An agent that can use the person's own computer — read the notes folder, write a draft next
to the project, open the result — is worth a lot and can do a lot of damage. The hub already
knows how to give Hermes an MCP server (`agents.createMcpServer`, stored in Hermes's own
configuration). The contract also has a device-request surface (`devices.createRequest`, the
`request.*` events) for a hub on a server to ask a paired device for something, but the
server side of it is not built yet.

## Decision (proposed)
1. **An MCP server inside the desktop app**, Streamable HTTP with plain JSON answers (no
   server-initiated stream), at `http://127.0.0.1:<port>/mcp`. Checked against the official
   MCP TypeScript SDK client (1.30.1): `initialize`, `tools/list` and `tools/call` work.
2. **Off by default.** Turning it on, sharing a folder, allowing writing in it, allowing
   opening — each is a separate switch on the permission screen (Settings → This device),
   and each starts off.
3. **Tools** — exactly these, listed on the screen as the agent sees them:
   - `list_allowed_folders`, `list_directory`, `read_text_file` (≤ 1 MB, text only);
   - `write_text_file` — only when a folder is shared as writable; never replaces a file
     unless asked to (`overwrite`);
   - `open_path` (a file or folder inside a shared folder, with its default app) and
     `open_url` (http/https only) — only when "open files and links" is allowed.
   No screenshots, no keyboard or mouse control, no running programs or commands, no
   arbitrary app launching: not simple enough to make safe in this step.
4. **The folder rule**: a path is used only if, with every symbolic link resolved, it is
   inside a shared folder; a file to be written is checked through its resolved parent; the
   most specific shared folder decides read-only versus writable.
5. **Who can call it**: it listens on 127.0.0.1 only; every request needs the helper's bearer
   token (32 random bytes, stored in the app's settings file, mode 0600; "New key" replaces
   it); a request with an `Origin` header (any web page) or a `Host` other than the loopback
   address is refused.
6. **Visible use**: the last 50 calls (time, tool, path or link, refused or not) are shown on
   the same screen.
7. **Who it serves**: the hub running on the same computer (local mode), where one button
   adds it to Hermes's MCP servers as `this-computer`. A hub on a server cannot reach a
   loopback address; the screen says so. Serving a remote hub goes through the contract's
   device requests once the devices module implements them — not a tunnel from this app.

## Threat model
| Threat | What stops it |
|---|---|
| A web page in any browser on the computer calls the helper (CSRF, DNS rebinding) | `Origin` present → 403; foreign `Host` → 403; bearer token required |
| Another program or user on the computer calls it | the token (only in the app's 0600 settings file and on the permission screen) |
| A machine on the network calls it | bound to 127.0.0.1 only |
| An agent (or a prompt injected into what it reads) reads outside what was shared | the folder rule, links resolved; reading is text only and capped |
| … writes or overwrites files | writing only where shared as writable, off per folder by default; no overwrite unless asked |
| … launches things | only opening files inside shared folders and http(s) links, only when allowed; no commands |
| A shared folder contains a link planted to point elsewhere | links are resolved before the check, for reads and for writes |
| The person forgets what is exposed | the screen lists the live tools, the folders and their access, and the recent calls |

Known limits: an agent allowed to write in a folder can write anything there (including
files another program later runs); a file swapped for a link between the check and the write
(a race by a local program that can already write there) is not prevented; the token is not
rotated automatically.

## Alternatives rejected
- **The official MCP SDK as a dependency**: the plain-JSON transport is small enough to own,
  and the SDK is used as the interoperability check instead.
- **A stdio MCP server** Hermes would launch: Hermes would run a second copy of the app's
  code outside the app, with no permission screen and no activity list.
- **Exposing it on the LAN for a hub on a server**: a network-reachable file server guarded
  by one token is a larger risk than the feature is worth before device requests exist.
