/**
 * The one MCP server block the hub writes into a profile's Hermes `config.yaml`, and the key
 * beside it in the profile's `.env` (contract decision §67).
 *
 * The block is Hermes's own shape for an HTTP server — `url`, `headers` — and its bearer
 * is `${COREHUB_MCP_TOKEN}`, which Hermes fills from the profile's `.env` when it connects
 * (`tools/mcp_tool_config.py` §`_interpolate_env_vars`: the routed profile's value). So the
 * key never sits in `config.yaml`, which a profile export carries, and a profile's key is
 * never another profile's.
 *
 * Like `../mcp.ts`, only this one node of the file is touched; the rest — comments, order,
 * quoting — stays the person's. The comment above the block says whose it is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';
import { readEnv, writeEnvValue } from '../channels.js';
import { configPath } from '../mcp.js';

/** The server's name in `mcp_servers:`; Hermes names its tools `mcp__corehub__<tool>`. */
export const HUB_SERVER_NAME = 'corehub';
/** The `.env` entry the block's header reads. */
export const HUB_KEY_ENV = 'COREHUB_MCP_TOKEN';
/**
 * The variable the hub sets in the environment of each Hermes process it starts (decision §79):
 * `hub` for the one its own conversations run in, `gateway` for a messaging gateway. Never in a
 * `.env`, so it is the process's own, and the block's second header carries it to every call —
 * a call from a gateway is told apart from a call from the hub's own runs.
 */
export const HUB_ORIGIN_ENV = 'COREHUB_MCP_ORIGIN';
export const HUB_ORIGIN_HEADER = 'x-corehub-origin';
export type HubOrigin = 'hub' | 'gateway';
const BLOCK = 'mcp_servers';
const MARK =
  ' Managed by Core Hub (Agents → Hermes → MCP → Core Hub tools). The hub rewrites this block;' +
  ' edit it there, not here.';

export class HubBlockError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'HubBlockError';
  }
}

function load(home: string): Document {
  const file = configPath(home);
  if (!existsSync(file)) return parseDocument('');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  // A file we cannot read is a file we must not rewrite (the same rule as `mcp.ts`).
  if (doc.errors.length > 0) throw new HubBlockError('config_unreadable');
  return doc;
}

export function blockFor(url: string): Record<string, unknown> {
  return {
    url,
    headers: {
      Authorization: `Bearer \${${HUB_KEY_ENV}}`,
      'X-Corehub-Origin': `\${${HUB_ORIGIN_ENV}}`,
    },
    enabled: true,
    connect_timeout: 10,
  };
}

/** Whether the block and the key are there as the hub would write them. */
export function blockInSync(home: string, url: string, keyMatches: (key: string) => boolean) {
  let current: unknown;
  try {
    current = load(home).toJS()?.[BLOCK]?.[HUB_SERVER_NAME];
  } catch {
    return false;
  }
  const key = readEnv(home)[HUB_KEY_ENV];
  return (
    JSON.stringify(current ?? null) === JSON.stringify(blockFor(url)) &&
    typeof key === 'string' &&
    keyMatches(key)
  );
}

/** Write (or rewrite) the block and the key. */
export function writeBlock(home: string, url: string, key: string): void {
  const doc = load(home);
  doc.setIn([BLOCK, HUB_SERVER_NAME], doc.createNode(blockFor(url)));
  const servers = doc.getIn([BLOCK], true);
  if (isMap(servers)) {
    const pair = servers.items.find(
      (item) => isScalar(item.key) && item.key.value === HUB_SERVER_NAME,
    );
    if (pair && isScalar(pair.key)) pair.key.commentBefore = MARK;
  }
  mkdirSync(home, { recursive: true });
  // The key first: a block that names a key not yet written would fail its first connect.
  writeEnvValue(home, HUB_KEY_ENV, key);
  writeFileSync(configPath(home), doc.toString(), 'utf8');
}

/** Remove the block and the key; a profile that has neither is left as it is. */
export function removeBlock(home: string): void {
  if (existsSync(configPath(home))) {
    const doc = load(home);
    const servers = doc.toJS()?.[BLOCK] as Record<string, unknown> | undefined;
    if (servers && HUB_SERVER_NAME in servers) {
      doc.deleteIn([BLOCK, HUB_SERVER_NAME]);
      writeFileSync(configPath(home), doc.toString(), 'utf8');
    }
  }
  if (readEnv(home)[HUB_KEY_ENV] !== undefined) writeEnvValue(home, HUB_KEY_ENV, null);
}
