/**
 * The Hermes plugin the hub keeps in each Hermes home it runs — `plugins/corehub-bridge/` —
 * so a person can write into a Telegram or WhatsApp conversation from the hub (contract
 * decision §153).
 *
 * What was observed in Hermes (MIT, v2026.9.14 and v2026.9.24 — `hermes_cli/plugins.py`,
 * `gateway/run_inbound.py`, `gateway/run_turn.py`, `agent/turn_context.py`,
 * `agent/turn_finalizer.py`, `website/docs/user-guide/features/plugins.md`), in our words:
 * - A plugin is a folder under a home's `plugins/` with `plugin.yaml` and an `__init__.py`
 *   whose `register(ctx)` Hermes calls in every process that loads plugins (the messaging
 *   gateway, the TUI the hub's own chats run in, the dashboard). It loads only when
 *   `plugins.enabled` in that home's `config.yaml` names it.
 * - `ctx.inject_message(text, role="user", session_key=…)` puts a message into an existing
 *   gateway conversation as a new turn: Hermes restores the conversation's own route (platform,
 *   chat, thread, profile), checks its allowlists again, queues behind a running turn, runs it
 *   with the conversation's whole history, and sends the agent's answer to the platform. It
 *   needs `plugins.entries.<id>.allow_gateway_injection: true` in the config of the home the
 *   gateway was started for, and a live gateway in the process (the plugin manager of that home
 *   is given an injector when the gateway starts). `True` means accepted for dispatch, not run.
 *   The text is stored as the user's, marked `display_kind: internal_notification`.
 * - Hooks `pre_llm_call` (with `session_id`, `platform`, `sender_id` and the turn's words) and
 *   `on_session_end` (with `session_id`, `platform`, `completed` / `failed` / `interrupted`) run
 *   once at the start and once at the end of every agent turn, injected ones included, in the
 *   home of the profile whose turn it is — so each profile's copy reports its own turns.
 * - On a Hermes with one gateway per host (`0.21.4` and later, DECISIONS §129) the root home's
 *   copy is the one with the injector, and it reaches a named profile's conversations
 *   (`agent:<profile>:…` keys); on an older Hermes each profile's own gateway has its own.
 *
 * So the plugin does two things, and only inside a messaging gateway the hub started (the hub
 * sets `COREHUB_MCP_ORIGIN=gateway` there, decision §79):
 * 1. it reports each channel turn's start and end to the hub (`agents.channelBridgeEvent`);
 * 2. in the copy whose plugin manager holds the gateway's injector, one thread long-polls the
 *    hub's outbox (`agents.channelBridgeOutbox`), injects each item and acknowledges it
 *    (`agents.channelBridgeAck`).
 *
 * It speaks to the hub on the loopback with a bearer the hub wrote beside it (`hub.json`, 0600,
 * one per home): the key names the profile, so a profile's copy only ever speaks for that
 * profile. The hub reads the key back at boot, so a gateway already running keeps working
 * across a restart of the hub. Nothing here is Hermes's code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, isSeq, parseDocument, type Document } from 'yaml';
import { configPath } from '../mcp.js';

export const BRIDGE_PLUGIN_ID = 'corehub-bridge';
export const BRIDGE_KEY_PREFIX = 'hub_bridge_';
const MARK =
  'Managed by Core Hub (two-way channel conversations). The hub rewrites this folder; do not' +
  ' edit it here.';

export function bridgeDir(home: string): string {
  return path.join(home, 'plugins', BRIDGE_PLUGIN_ID);
}

/** Where the plugin reaches the hub: beside the hub's MCP endpoint. */
export function bridgeUrl(mcpUrl: string): string {
  return `${mcpUrl.replace(/\/+$/, '')}/channel-bridge`;
}

export function hashBridgeKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function manifest(): string {
  return [
    `# ${MARK}`,
    `name: ${BRIDGE_PLUGIN_ID}`,
    'version: "1.0"',
    "description: Lets Core Hub write into this Hermes's Telegram and WhatsApp conversations and hear their turns.",
    '',
  ].join('\n');
}

/** The plugin's code. Python, standard library only, never blocks a turn. */
export function pluginSource(): string {
  return `# ${MARK}
"""Core Hub's bridge into Hermes's messaging gateway (contract decision 153).

Reports each channel turn's start and end to Core Hub, and puts the messages a person wrote
from Core Hub into their channel conversation (ctx.inject_message). Only inside a messaging
gateway Core Hub started (COREHUB_MCP_ORIGIN=gateway).
"""
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

PLUGIN_ID = ${JSON.stringify(BRIDGE_PLUGIN_ID)}
_HERE = Path(__file__).resolve().parent
_NOT_CHANNELS = {"", "cli", "tui", "local", "api_server", "webhook", "cron"}
_POLL_WAIT = 25


def _hub():
    # Read every time: the hub rewrites it when its address changes.
    try:
        data = json.loads((_HERE / "hub.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    url, key = data.get("url"), data.get("key")
    if isinstance(url, str) and url and isinstance(key, str) and key:
        return url.rstrip("/"), key
    return None


def _call(method, path, payload=None, timeout=10):
    hub = _hub()
    if hub is None:
        raise RuntimeError("Core Hub's address is not known yet")
    url, key = hub
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": "Bearer " + key}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else None


def _report(payload):
    # Off the turn's thread: a slow or absent hub never holds a turn up.
    def send():
        try:
            _call("POST", "/events", payload, timeout=5)
        except Exception:
            pass
    threading.Thread(target=send, daemon=True, name="corehub-bridge-report").start()


def _text(value, limit):
    if value is None:
        return None
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False)
        except Exception:
            value = str(value)
    return value[:limit]


def _poll(ctx):
    # Only the copy whose plugin manager holds the live gateway's injector can inject; every
    # other copy (a named profile's, under one gateway per host) waits here and does nothing.
    manager = getattr(ctx, "_manager", None)
    waited = 0.0
    while manager is None or not getattr(manager, "has_gateway_message_injector", False):
        pause = 1.0 if waited < 180 else 15.0
        time.sleep(pause)
        waited += pause
    delay = 1.0
    while True:
        try:
            answer = _call("GET", "/outbox?wait=%d" % _POLL_WAIT, timeout=_POLL_WAIT + 15)
            delay = 1.0
        except Exception:
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
            continue
        for item in (answer or {}).get("items") or []:
            accepted, reason = False, None
            try:
                accepted = bool(ctx.inject_message(
                    str(item.get("text") or ""),
                    role="user",
                    session_key=str(item.get("session_key") or ""),
                ))
                if not accepted:
                    reason = "Hermes did not accept it (no live gateway, no permission, or no such conversation)"
            except Exception as error:
                reason = "%s: %s" % (type(error).__name__, error)
            try:
                _call("POST", "/outbox/%s/ack" % item.get("id"), {"accepted": accepted, "reason": _text(reason, 500)})
            except Exception:
                pass


def register(ctx):
    if os.environ.get("COREHUB_MCP_ORIGIN") != "gateway":
        return

    def on_turn_start(session_id=None, user_message=None, platform=None, sender_id=None, **_):
        if str(platform or "") in _NOT_CHANNELS:
            return None
        _report({
            "event": "turn_started",
            "platform": str(platform),
            "session_id": _text(session_id, 200),
            "sender_id": _text(sender_id, 320) or None,
            "text": _text(user_message, 4000),
            "outcome": None,
        })
        return None

    def on_turn_end(session_id=None, platform=None, completed=None, failed=None, interrupted=None, **_):
        if str(platform or "") in _NOT_CHANNELS:
            return None
        outcome = "failed" if failed else "interrupted" if interrupted else "completed"
        _report({
            "event": "turn_ended",
            "platform": str(platform),
            "session_id": _text(session_id, 200),
            "sender_id": None,
            "text": None,
            "outcome": outcome,
        })
        return None

    ctx.register_hook("pre_llm_call", on_turn_start)
    ctx.register_hook("on_session_end", on_turn_end)
    # One poller per home in this process, however often Hermes registers the plugin again.
    name = "corehub-bridge:" + str(_HERE)
    if not any(thread.name == name and thread.is_alive() for thread in threading.enumerate()):
        threading.Thread(target=_poll, args=(ctx,), daemon=True, name=name).start()
`;
}

/** The two code files as the hub writes them. */
export function pluginFiles(): Record<string, string> {
  return { 'plugin.yaml': manifest(), '__init__.py': pluginSource() };
}

interface HubFile {
  url: string | null;
  key: string;
  profile: string;
}

function readHubFile(home: string): HubFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(bridgeDir(home), 'hub.json'), 'utf8')) as {
      url?: unknown;
      key?: unknown;
      profile?: unknown;
    };
    if (typeof parsed.key !== 'string' || !parsed.key.startsWith(BRIDGE_KEY_PREFIX)) return null;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : null,
      key: parsed.key,
      profile: typeof parsed.profile === 'string' ? parsed.profile : '',
    };
  } catch {
    return null;
  }
}

/** The key the plugin in `home` speaks with, when there is one. */
export function bridgeKeyOf(home: string): string | null {
  return readHubFile(home)?.key ?? null;
}

/**
 * Writes the plugin into `home` as the hub would — its code, and `hub.json` with the hub's
 * address and the home's key (kept when there is one) — and switches it on in the home's
 * `config.yaml`. Returns the key, and whether the code changed (a running gateway loads plugins
 * when it starts).
 */
export function writeBridgePlugin(
  home: string,
  options: { url: string | null; profile: string },
): { key: string; codeChanged: boolean; configChanged: boolean } {
  const dir = bridgeDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let codeChanged = false;
  for (const [name, text] of Object.entries(pluginFiles())) {
    const file = path.join(dir, name);
    let current: string | null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current !== text) {
      writeFileSync(file, text, { mode: 0o600 });
      codeChanged = true;
    }
  }
  const existing = readHubFile(home);
  const key = existing?.key ?? `${BRIDGE_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  // An address not known yet (a hub on port 0 before it listens) keeps the one written before.
  const url = options.url ?? existing?.url ?? null;
  const wanted: HubFile = { url, key, profile: options.profile };
  if (
    !existing ||
    existing.url !== wanted.url ||
    existing.key !== wanted.key ||
    existing.profile !== wanted.profile
  ) {
    writeFileSync(path.join(dir, 'hub.json'), `${JSON.stringify(wanted, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  const configChanged = enableBridgePlugin(home);
  return { key, codeChanged, configChanged };
}

function loadConfig(home: string): Document | null {
  const file = configPath(home);
  if (!existsSync(file)) return parseDocument('');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  // A file we cannot read is a file we must not rewrite (the rule of `mcp.ts`).
  return doc.errors.length > 0 ? null : doc;
}

/**
 * `plugins.enabled` names the plugin and `plugins.entries.corehub-bridge.allow_gateway_injection`
 * is `true`, touching nothing else in the file. A name the person put in `plugins.disabled` is
 * taken out: it is the hub's own plugin, as `hooks/corehub/` is the hub's own hook. Returns
 * whether the file changed.
 */
export function enableBridgePlugin(home: string): boolean {
  const doc = loadConfig(home);
  if (!doc) return false;
  let changed = false;
  const enabled = doc.getIn(['plugins', 'enabled']);
  if (isSeq(enabled)) {
    if (
      !enabled.items.some(
        (item) => String((item as { value?: unknown }).value ?? item) === BRIDGE_PLUGIN_ID,
      )
    ) {
      enabled.add(doc.createNode(BRIDGE_PLUGIN_ID));
      changed = true;
    }
  } else {
    doc.setIn(['plugins', 'enabled'], doc.createNode([BRIDGE_PLUGIN_ID]));
    changed = true;
  }
  const disabled = doc.getIn(['plugins', 'disabled']);
  if (isSeq(disabled)) {
    const index = disabled.items.findIndex(
      (item) => String((item as { value?: unknown }).value ?? item) === BRIDGE_PLUGIN_ID,
    );
    if (index >= 0) {
      disabled.items.splice(index, 1);
      changed = true;
    }
  }
  const entry = doc.getIn(['plugins', 'entries', BRIDGE_PLUGIN_ID]);
  if (!isMap(entry) || entry.get('allow_gateway_injection') !== true) {
    doc.setIn(['plugins', 'entries', BRIDGE_PLUGIN_ID, 'allow_gateway_injection'], true);
    changed = true;
  }
  if (changed) {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), doc.toString(), 'utf8');
  }
  return changed;
}
