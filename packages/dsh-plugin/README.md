# Core Hub for DeepSeek Harness

`@corehub/dsh-plugin` links [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`, MIT, developer preview) on your computer to your Core Hub server
([ADR 0033](../../docs/adr/0033-deepseek-harness-plugin.md)):

- **The hub's models in the harness.** A "Core Hub" provider in the harness's model picker,
  served by the hub's model gateway (its external entrance). Provider keys never leave the hub.
- **Hermes from inside the harness.** `/hermes <message>`, and a tool the harness's own agent can
  call (`corehub_ask_agent`), both answered by the hub's agent with its memory and MCP tools.
  One hub conversation follows one harness session. Hermes often needs minutes: a slow answer
  arrives as a harness background job (its completion notice, or `job_output`), or, where the
  harness offers no jobs, through `corehub_agent_result`. One question per harness session runs
  at a time; asking again while it runs sends nothing new. Messages the harness's agent writes
  start with `↪ DeepSeek Harness:` in the hub conversation.
- **Your computer, for the hub's agents.** The hub reaches the folders you share, the MCP servers
  of your harness profile you switch on, and (macOS) screen tasks — each as you allow it.

It lives beside the Core Hub desktop app; it does not replace it (ADR 0033 §7).

## Supported harness versions

`engines.dsh` is pinned to the release candidates the plugin was tested with: **0.2.2-rc.5**.
The harness refuses to install the plugin into any other version. A newer harness is tried and
the range widened by a change record (`docs/changes/`), never by hope.

## Install

1. Build the package (from the repository root):

   ```sh
   pnpm install
   pnpm --filter @corehub/dsh-plugin pack:harness
   ```

   This writes `packages/dsh-plugin/corehub-dsh-plugin-<version>.tgz`: self-contained (the
   contract client and Socket.IO are bundled; only the harness's own Schemastery is shared).

2. Add it to a harness profile with the harness CLI:

   ```sh
   dsh plugin --profile web add ./packages/dsh-plugin/corehub-dsh-plugin-1.1.10.tgz
   ```

   Use the profile you run (`web` for `dsh web`). The DeepSeek Harness desktop app keeps its own
   reserved profile (`desktop`) and manages its plugins with its bundled CLI; install there the
   same way with that CLI and `--profile desktop` (not tried yet — see Limits).

3. Restart the harness. `/corehub` now answers in the chat.

To remove it: `dsh plugin --profile <profile> remove @corehub/dsh-plugin`. Run `/corehub unlink`
first if you also want the hub to forget this computer's token.

## Link to your hub

1. On the hub, an admin switches on **the model gateway's entrance for your own apps**
   (Core Hub → Settings → Models). Without it, linking still works, but the harness gets no
   models from the hub.
2. In Core Hub, link a device: it shows a QR code and the pairing as JSON
   (`{"type":"corehub.pairing",…}`).
3. In the harness, paste it after `/corehub link`:

   ```text
   /corehub link {"type":"corehub.pairing","hub_url":"https://hub.example","pairing_id":"01J…","code":"ABCD-1234"}
   ```

   The `corehub://pair?hub=…&id=…&code=…` link, or `https://hub.example <pairing id> <code>`, work
   too.

The plugin claims the pairing, and keeps the hub's address, your app token and the device in
`link.json` beside the profile's patch (`$DSH_HOME/profiles/<profile>/corehub/`, mode `0600`).
The token goes nowhere else: not into the profile's `cordis.patch.yml`, not into the harness's
credential store, not into the environment of the harness's tools, not into a log. It is renewed
like every Core Hub client renews its token (fewer than seven days left); a hub that refuses it
stops the link until you link again.

| Command | What it does |
| --- | --- |
| `/corehub link <pairing>` | Link this harness to a hub (replaces a previous link). |
| `/corehub status` | The link, the device connection, shared folders, programs, screen tasks, recent activity. |
| `/corehub models` | Ask the hub for its models again and update the "Core Hub" provider. |
| `/corehub unlink` | Revoke the token on the hub, delete it here, remove the provider. |
| `/hermes <message>` | Ask the hub's agent; its answer comes back here. |

## Models

After linking (and after `/corehub models`), the profile's `llm-pi-ai` row has a `corehub`
provider: `openai-completions` at `<hub>/api/v1/gateway/openai/v1`, with the models the hub lists
for you (`"<provider slug>/<model>"`). Its `Authorization` header in the patch is a placeholder;
the plugin puts your token on each request to this provider through the harness's
`llm-pi-ai/request-headers` hook, from memory. Your other providers are left as they are.

If the hub answers that the entrance is off (403), `/corehub models` says an admin must switch it
on; a hub too old to have the entrance (404) is told to update.

## Settings

The plugin's settings are its row's config (the harness's Plugins page shows them; they apply
without a restart). In `cordis.patch.yml` of the profile:

```yaml
- id: corehub
  config:
    folders:                  # what the hub's agents may use on this computer
      - path: /Users/me/Documents/Reports
        write: false          # read-only unless true
    allowOpen: false          # open files (in shared folders) and web links here
    programs:                 # MCP servers of this harness profile, off unless listed
      github: [work]          # server name -> hub profiles it serves
    agentProfile: ''          # the hub profile /hermes talks in ('' = your default)
    agent: hermes             # the hub agent /hermes talks to
    screenTasks: true         # offer screen tasks (macOS with Computer Use only)
    screenModel: ''           # hub model for screen tasks when the hub names none
    dshCommand: []            # how to start this harness's CLI ([] = found automatically)
    language: auto            # auto | en | ar
```

## What the hub's agents can do here

- **Files** (`files`): the file tools of the Core Hub desktop helper — list the shared folders,
  list a folder, read a text file (1 MB), write one in a writable folder (never replacing a file
  unless asked), open a file or link when `allowOpen` is on, and send a file into the chat. A path
  is used only if, once every link is resolved, it is inside a shared folder.
- **Programs** (`apps`): a tool of an MCP server configured in this harness profile, run through
  the harness's own MCP manager. You are asked once per session per program (Allow once / Allow
  for this session / Deny). A long call answers `running`, and the hub follows it.
- **Screen tasks** (`screen_task`, macOS only): the hub's agent hands over a task in words. You are
  asked every time (Allow / Deny). The plugin then runs a separate one-shot harness session
  (`dsh --profile corehub-screen --json …`, the headless runner) with Computer Use and the PTC
  executor on a hub model, limited to the app the task names, and answers with a short outcome and
  one screenshot of the screen. The screen is never streamed to the hub and the hub never sends
  clicks.

  It needs the harness's Computer Use (shipped with macOS installs of the harness; Accessibility
  and Screen Recording granted to `DSH Computer Use.app`) and Screen Recording for the harness
  itself (the final screenshot uses macOS's `screencapture`). The plugin writes the
  `corehub-screen` profile under `$DSH_HOME/profiles/` before each task.

Where you are asked: the harness's own question prompt when it has one for a question that
belongs to no chat; otherwise the operating system's dialog (`osascript` on macOS, a PowerShell
message box on Windows, `zenity`/`kdialog` on Linux). Without any of them the answer is Deny.
Everything the hub asked is listed in `/corehub status`.

## Limits (developer preview)

- Tested on Linux against harness 0.2.2-rc.5 with a stand-in hub: install, `/corehub link`,
  `status`, `models`, the provider through the gateway path with the per-request bearer,
  `corehub_ask_agent` and `/hermes` round trips, the device link answering `files` and `apps`, and
  the screen profile's headless session. **Not yet tried:** a real Core Hub with the entrance on,
  the macOS Computer Use run itself, the desktop app's profile, the Windows dialog.
- The harness routes its own question prompt only to a chat's agent; the hub's requests belong to
  none, so the consent prompt is the OS dialog in practice.
- A hub whose contract has no `DeviceProgram.source` value for the harness refuses the programs in
  the report; the plugin then reports the folders (and screen tasks) without them, and
  `/corehub status` says so.
- Screen tasks run one at a time; the session is a separate process, so it does not appear in the
  harness's chat list.

## Development

```sh
pnpm --filter @corehub/dsh-plugin typecheck
pnpm --filter @corehub/dsh-plugin test        # vitest, the pure logic
pnpm --filter @corehub/dsh-plugin build       # dist/index.js, dist/screen-consent.js
```

The plugin imports none of the harness's runtime packages: `src/host.ts` writes down the small
part of the harness's plugin API it uses (from the harness's published documentation and
interface declarations), so a breaking change in a new release candidate shows up in one file.
