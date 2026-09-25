/**
 * The hook the hub keeps in a profile's Hermes home beside its `corehub` MCP block (contract
 * decision §78): `hooks/corehub/HOOK.yaml` and `handler.py`, Hermes's own shape for a gateway
 * hook.
 *
 * What was observed in Hermes (MIT, v2026.9.14 — `gateway/hooks.py`, `gateway/run_turn.py`,
 * `gateway/run_inbound.py`), in our words:
 * - Hermes's messaging gateway loads every folder under the active profile's `hooks/` that has
 *   a `HOOK.yaml` (a name and the events it wants) and a `handler.py` with
 *   `handle(event_type, context)`, sync or async. It loads them when the gateway starts, so a
 *   gateway already running needs a restart to see a new one. A failing handler is logged and
 *   never stops a message.
 * - `agent:start` is awaited **before** the agent runs a turn, with the sender as the platform
 *   named it (`platform`, `user_id`, `chat_id`, `chat_type`, `session_id`, the message's first
 *   500 characters); `agent:end` after it, with the same fields; `agent:step` once per tool
 *   loop. So the hub knows who a turn is for before any tool of it is called.
 * - A slash command Hermes knows fires `command:<name>` after the sender passed Hermes's own
 *   authorization (pairing, allowlists), and a handler that answers
 *   `{"decision": "handled", "message": …}` makes the gateway reply that and stop there.
 *   `/start` is such a command (Hermes otherwise ignores it as Telegram's start ping), and a
 *   Telegram link `t.me/<bot>?start=<code>` sends it. A command sent while the agent is busy
 *   skips the hooks.
 *
 * So the handler reports each turn's sender to the hub, and hands the hub the argument of a
 * `/start` that looks like one of its link codes. It speaks to `agents.hubChannelEvent` on the
 * loopback with the profile's own hub-tools key, read from the `.env` two folders up — the
 * profile it lives in — so a profile's hook can only ever speak for that profile.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HUB_KEY_ENV } from './block.js';

export const HOOK_NAME = 'corehub';
const MARK =
  'Managed by Core Hub (Agents → Hermes → MCP → Core Hub tools). The hub rewrites this folder;' +
  ' edit it there, not here.';

export function hookDir(home: string): string {
  return path.join(home, 'hooks', HOOK_NAME);
}

/** Where the hook reaches the hub: beside the MCP endpoint. */
export function channelEventsUrl(mcpUrl: string): string {
  return `${mcpUrl.replace(/\/+$/, '')}/channel-events`;
}

function manifest(): string {
  return [
    `# ${MARK}`,
    `name: ${HOOK_NAME}`,
    'description: Tells Core Hub who sent a channel message, so its tools act for the person who linked that account.',
    'events:',
    '  - agent:start',
    '  - agent:step',
    '  - agent:end',
    '  - command:start',
    '',
  ].join('\n');
}

function handler(url: string): string {
  return `# ${MARK}
"""Core Hub's hook in Hermes's messaging gateway (contract decision §78).

Reports who each channel turn is for, so the hub's own MCP tools act for the person who linked
that account and for nobody else, and passes a \`/start corehub_…\` link code to the hub.
"""
import asyncio
import json
import os
import urllib.request
from pathlib import Path

HUB_URL = ${JSON.stringify(url)}
KEY_ENV = ${JSON.stringify(HUB_KEY_ENV)}
TIMEOUT_SECONDS = 4
TURNS = {"agent:start": "turn_started", "agent:step": "turn_step", "agent:end": "turn_ended"}
UNREACHABLE = "Core Hub could not be reached; try again in a moment. / تعذّر الوصول إلى كور هب؛ حاول بعد قليل."


def _key():
    # The profile's own key: this file lives in <home>/hooks/corehub/.
    env_file = Path(__file__).resolve().parents[2] / ".env"
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].strip()
            name, sep, value = line.partition("=")
            if sep and name.strip() == KEY_ENV:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\\"'":
                    value = value[1:-1]
                return value or None
    except OSError:
        pass
    return os.environ.get(KEY_ENV) or None


def _post(payload):
    key = _key()
    if not key:
        return None
    request = urllib.request.Request(
        HUB_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8") or "null")
    except Exception:
        return None


def _text(value):
    if value is None:
        return None
    value = str(value)
    return value or None


async def handle(event_type, context):
    context = context or {}
    if event_type == "command:start":
        code = str(context.get("args") or "").strip()
        if not code.lower().startswith("corehub_"):
            return None
        answer = await asyncio.to_thread(_post, {
            "event": "link",
            "platform": str(context.get("platform") or ""),
            "sender_id": _text(context.get("user_id")),
            "session_id": None,
            "chat_type": None,
            "code": code[:200],
        })
        if answer is None:
            return {"decision": "handled", "message": UNREACHABLE}
        if answer.get("handled"):
            return {"decision": "handled", "message": answer.get("message") or ""}
        return None
    kind = TURNS.get(event_type)
    if kind is None:
        return None
    await asyncio.to_thread(_post, {
        "event": kind,
        "platform": str(context.get("platform") or ""),
        "sender_id": _text(context.get("user_id")),
        "session_id": _text(context.get("session_id")),
        "chat_type": _text(context.get("chat_type")),
        "code": None,
    })
    return None
`;
}

/** The two files as the hub writes them for this hub address. */
export function hookFiles(mcpUrl: string): Record<string, string> {
  return {
    'HOOK.yaml': manifest(),
    'handler.py': handler(channelEventsUrl(mcpUrl)),
  };
}

/** Whether the hook is there exactly as the hub would write it. */
export function hookInSync(home: string, mcpUrl: string): boolean {
  const dir = hookDir(home);
  return Object.entries(hookFiles(mcpUrl)).every(([name, text]) => {
    try {
      return readFileSync(path.join(dir, name), 'utf8') === text;
    } catch {
      return false;
    }
  });
}

/** Write (or rewrite) the hook; `true` when anything changed on disk. */
export function writeHook(home: string, mcpUrl: string): boolean {
  if (hookInSync(home, mcpUrl)) return false;
  const dir = hookDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(hookFiles(mcpUrl))) {
    writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  }
  return true;
}

/** Remove the hook; `true` when there was one. */
export function removeHook(home: string): boolean {
  const dir = hookDir(home);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
