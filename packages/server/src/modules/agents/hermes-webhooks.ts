/**
 * Hermes's incoming webhooks, as the hub manages them (contract decision §96).
 *
 * What Hermes does, observed in its MIT source at `v2026.9.14` (`gateway/platforms/webhook.py`,
 * `hermes_cli/webhook.py`) and said in our words:
 *
 * - **The receiver is a platform of the messaging gateway**, `platforms.webhook` in a profile's
 *   `config.yaml`. Switched on, the gateway serving that profile listens on `extra.port` (8644 when
 *   none is given) on `extra.host` (every interface when none is given) and answers
 *   `POST /webhooks/<route>` and `GET /health`.
 * - **Routes** come from two places: `extra.routes` in `config.yaml` (static, they win on a name
 *   clash) and `webhook_subscriptions.json` in the profile's home (what `hermes webhook subscribe`
 *   writes, mode 0600). The second file is read again, by its modification time, on every POST,
 *   so a new or deleted route takes effect without a restart; switching the platform itself on
 *   needs the gateway to start again.
 * - **A route** has a secret (required; a route without one is skipped), a prompt template, the
 *   events it takes (empty: all), skills, and where the answer goes (`deliver`: `log` keeps it in
 *   the run's record, a platform name sends it to that platform's home chat). Its `profile` must
 *   be `default` for a gateway serving one profile, which is how the hub runs them.
 * - **A POST** is size-capped (1 MiB), checked against the secret (GitHub's
 *   `X-Hub-Signature-256`, GitLab's `X-Gitlab-Token`, Svix and Standard Webhooks, Linear, or the
 *   generic `X-Webhook-Signature[-V2]`), rate-limited per route (30 a minute), filtered by event,
 *   and de-duplicated by its delivery id for an hour. The prompt is rendered with `{a.b}` taken
 *   from the JSON body, `{event_type}` and `{__raw__}`; an empty prompt asks with the whole body.
 *   A run is started for the delivery and the POST answered `202 {status: accepted, …}` at once.
 *
 * What the hub adds: it writes the routes and switches the listener on (bound to `127.0.0.1` on a
 * port of the profile's own, so two profile gateways never meet), and it is the **public door**:
 * `POST /api/v1/hermes-webhooks/<profile>/<route>` on the hub is passed byte for byte to the
 * profile's listener on this machine. An outside service therefore needs only the hub's own
 * address — which has to be reachable from the internet — and no new port is opened on the host
 * (a Docker upgrade keeps working by replacing the image alone).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';
import { CONFIG_FILE } from './mcp.js';
import { ChannelError, readEnv } from './profile-env.js';

export const WEBHOOK_SUBSCRIPTIONS = 'webhook_subscriptions.json';
/** Hermes's port when a profile names none. */
export const HERMES_WEBHOOK_PORT = 8644;
/** Where the hub gives each profile's listener a port of its own. */
export const WEBHOOK_PORTS = { first: 18650, last: 18999 } as const;
/** Hermes's rule for a route's name (`hermes_cli/webhook.py`). */
export const WEBHOOK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Hermes's default body cap (`max_body_bytes`). */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;
/** Hermes's literal for "no signature check", allowed only on a loopback listener. */
const INSECURE_NO_AUTH = 'INSECURE_NO_AUTH';

export interface HermesWebhookRoute {
  name: string;
  description: string | null;
  prompt: string;
  events: string[];
  deliver: string;
  secret: string | null;
  static: boolean;
  createdAt: string | null;
}

export interface WebhookListener {
  enabled: boolean;
  /** Where the hub reaches it; null while it is off. */
  host: string;
  port: number | null;
}

type Json = Record<string, unknown>;

// ------------------------------------------------------------------ files

function loadConfig(home: string): Document {
  const file = path.join(home, CONFIG_FILE);
  if (!existsSync(file)) return parseDocument('');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new ChannelError('config_unreadable');
  return doc;
}

function saveConfig(home: string, doc: Document): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, CONFIG_FILE), doc.toString(), 'utf8');
}

function webhookNode(home: string): Json {
  try {
    const node = (loadConfig(home).toJS() as Json | null)?.platforms as Json | undefined;
    const webhook = node?.webhook;
    return webhook && typeof webhook === 'object' && !Array.isArray(webhook)
      ? (webhook as Json)
      : {};
  } catch {
    return {};
  }
}

function extraOf(node: Json): Json {
  const extra = node.extra;
  return extra && typeof extra === 'object' && !Array.isArray(extra) ? (extra as Json) : {};
}

const truthy = (value: string | undefined) =>
  ['true', '1', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

function portOf(raw: unknown): number | null {
  const port = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** `webhook_subscriptions.json`, or `{}` when there is none or it cannot be read (as Hermes). */
export function readSubscriptions(home: string): Record<string, Json> {
  try {
    const data = JSON.parse(
      readFileSync(path.join(home, WEBHOOK_SUBSCRIPTIONS), 'utf8'),
    ) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Record<string, Json> = {};
    for (const [name, route] of Object.entries(data as Json)) {
      if (route && typeof route === 'object' && !Array.isArray(route)) out[name] = route as Json;
    }
    return out;
  } catch {
    return {};
  }
}

/** Written whole, through a temporary file that is 0600 before it takes the name (secrets). */
function writeSubscriptions(home: string, subs: Record<string, Json>): void {
  mkdirSync(home, { recursive: true });
  const file = path.join(home, WEBHOOK_SUBSCRIPTIONS);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(subs, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

// ------------------------------------------------------------------ reads

/**
 * The profile's listener as Hermes will run it: on when the file says `enabled: true` or the
 * profile's `.env` says `WEBHOOK_ENABLED` (Hermes's `config_env.py` §_webhook, which also takes
 * `WEBHOOK_PORT`); the port from the environment, then `extra.port`, then Hermes's 8644.
 */
export function webhookListener(home: string): WebhookListener {
  const node = webhookNode(home);
  const extra = extraOf(node);
  const env = readEnv(home);
  const enabled = node.enabled === true || (truthy(env.WEBHOOK_ENABLED) && node.enabled !== false);
  const configured = typeof extra.host === 'string' ? extra.host.trim() : '';
  // A wildcard bind is reached on loopback like any other.
  const host =
    configured === '' ||
    configured === '0.0.0.0' ||
    configured === '::' ||
    configured === 'localhost'
      ? '127.0.0.1'
      : configured;
  const port = portOf(env.WEBHOOK_PORT) ?? portOf(extra.port) ?? HERMES_WEBHOOK_PORT;
  return { enabled, host, port: enabled ? port : null };
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

/** A route without its own secret signs with the listener's global one, which is not shown. */
function toRoute(name: string, route: Json, isStatic: boolean): HermesWebhookRoute {
  const secret = typeof route.secret === 'string' && route.secret !== '' ? route.secret : null;
  return {
    name,
    description: typeof route.description === 'string' ? route.description : null,
    prompt: typeof route.prompt === 'string' ? route.prompt : '',
    events: stringList(route.events),
    deliver: typeof route.deliver === 'string' && route.deliver !== '' ? route.deliver : 'log',
    secret,
    static: isStatic,
    createdAt: typeof route.created_at === 'string' ? route.created_at : null,
  };
}

/**
 * Every route Hermes would take, by name: the subscriptions, and the routes of `config.yaml`
 * (which win on a clash, as in Hermes). A subscription Hermes skips — no secret — is left out.
 */
export function listWebhooks(home: string): HermesWebhookRoute[] {
  const extra = extraOf(webhookNode(home));
  const globalSecret = typeof extra.secret === 'string' && extra.secret !== '';
  const staticRoutes =
    extra.routes && typeof extra.routes === 'object' && !Array.isArray(extra.routes)
      ? (extra.routes as Record<string, unknown>)
      : {};
  const out = new Map<string, HermesWebhookRoute>();
  for (const [name, route] of Object.entries(readSubscriptions(home))) {
    if (name in staticRoutes) continue;
    const secret = route.secret ?? (globalSecret ? extra.secret : undefined);
    if (typeof secret !== 'string' || secret === '') continue;
    out.set(name, toRoute(name, route, false));
  }
  for (const [name, route] of Object.entries(staticRoutes)) {
    if (route && typeof route === 'object' && !Array.isArray(route)) {
      out.set(name, toRoute(name, route as Json, true));
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findWebhook(home: string, name: string): HermesWebhookRoute | null {
  return listWebhooks(home).find((route) => route.name === name) ?? null;
}

// ------------------------------------------------------------------ writes

export class WebhookError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'WebhookError';
  }
}

/** Whether nothing on this machine listens on `port` of loopback right now. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Switches the profile's listener on, bound to this machine, on a port no other profile's listener
 * has, and answers the port. A port somebody wrote by hand is kept while it is the profile's own;
 * `host` is written only when the file names none.
 */
export async function ensureWebhookListener(
  home: string,
  others: readonly string[],
  isFree: (port: number) => Promise<boolean> = portFree,
): Promise<number> {
  const taken = new Set(
    others
      .map((other) => {
        const listener = webhookListener(other);
        return listener.enabled ? listener.port : portOf(extraOf(webhookNode(other)).port);
      })
      .filter((port): port is number => port !== null),
  );
  const doc = loadConfig(home);
  const current = portOf(extraOf(webhookNode(home)).port);
  let port = current !== null && !taken.has(current) ? current : null;
  for (let candidate = WEBHOOK_PORTS.first; port === null && candidate <= WEBHOOK_PORTS.last;) {
    if (!taken.has(candidate) && (await isFree(candidate))) port = candidate;
    else candidate += 1;
  }
  if (port === null) throw new WebhookError('no_webhook_port_free');
  if (!isMap(doc.get('platforms'))) doc.set('platforms', doc.createNode({}));
  if (!isMap(doc.getIn(['platforms', 'webhook']))) {
    doc.setIn(['platforms', 'webhook'], doc.createNode({}));
  }
  if (!isMap(doc.getIn(['platforms', 'webhook', 'extra']))) {
    doc.setIn(['platforms', 'webhook', 'extra'], doc.createNode({}));
  }
  doc.setIn(['platforms', 'webhook', 'enabled'], true);
  const host = doc.getIn(['platforms', 'webhook', 'extra', 'host']);
  if (typeof host !== 'string' || host.trim() === '') {
    doc.setIn(['platforms', 'webhook', 'extra', 'host'], '127.0.0.1');
  }
  doc.setIn(['platforms', 'webhook', 'extra', 'port'], port);
  saveConfig(home, doc);
  return port;
}

/** Switches the listener off again once no route is left; its port stays written. */
export function disableUnusedListener(home: string): boolean {
  if (listWebhooks(home).length > 0) return false;
  const doc = loadConfig(home);
  if (!isMap(doc.getIn(['platforms', 'webhook']))) return false;
  if (doc.getIn(['platforms', 'webhook', 'enabled']) === false) return false;
  doc.setIn(['platforms', 'webhook', 'enabled'], false);
  saveConfig(home, doc);
  return true;
}

export interface WebhookInput {
  name: string;
  prompt: string;
  description?: string | null;
  events?: string[];
  deliver?: string;
}

/**
 * Adds a route to `webhook_subscriptions.json` in the shape `hermes webhook subscribe` writes,
 * with a new random secret. A name that is taken — by a subscription or a static route — is
 * refused.
 */
export function addWebhook(
  home: string,
  input: WebhookInput,
  now = new Date(),
): HermesWebhookRoute {
  const name = input.name.trim();
  if (!WEBHOOK_NAME.test(name)) throw new WebhookError('invalid_name');
  if (findWebhook(home, name) || name in readSubscriptions(home)) {
    throw new WebhookError('webhook_exists');
  }
  const subs = readSubscriptions(home);
  const route: Json = {
    description: input.description?.trim() || null,
    events: [...new Set((input.events ?? []).map((event) => event.trim()).filter(Boolean))],
    secret: randomBytes(32).toString('base64url'),
    prompt: input.prompt,
    skills: [],
    deliver: input.deliver?.trim() || 'log',
    // A gateway serves one profile, so its routes are bound to `default` (see the top).
    profile: 'default',
    created_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  if (route.description === null) delete route.description;
  subs[name] = route;
  writeSubscriptions(home, subs);
  return toRoute(name, route, false);
}

/** Removes a subscription; a static route is not the hub's to remove. */
export function removeWebhook(home: string, name: string): void {
  const route = findWebhook(home, name);
  const subs = readSubscriptions(home);
  if (route?.static) throw new WebhookError('webhook_static');
  if (!(name in subs)) throw new WebhookError('webhook_not_found');
  delete subs[name];
  writeSubscriptions(home, subs);
}

// ------------------------------------------------------------------ the door

/** The headers Hermes reads a signature, an event or a delivery id from — passed on as sent. */
export const FORWARDED_HEADERS = [
  'content-type',
  'x-hub-signature-256',
  'x-github-event',
  'x-github-delivery',
  'x-gitlab-token',
  'x-gitlab-event',
  'svix-id',
  'svix-timestamp',
  'svix-signature',
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
  'linear-signature',
  'x-webhook-signature',
  'x-webhook-signature-v2',
  'x-webhook-timestamp',
  'x-request-id',
] as const;

export interface ListenerAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * One POST to the profile's listener on this machine. Throws `WebhookError('listener_down')` when
 * nothing answers there.
 */
export async function postToListener(
  listener: WebhookListener,
  name: string,
  body: Buffer,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ListenerAnswer> {
  if (!listener.enabled || listener.port === null) throw new WebhookError('listener_off');
  const host = listener.host.includes(':') ? `[${listener.host}]` : listener.host;
  let response: Response;
  try {
    response = await fetchImpl(
      `http://${host}:${listener.port}/webhooks/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw new WebhookError('listener_down');
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    status: response.status,
    body:
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null,
  };
}

/** `hermes webhook test`'s request: a `test` event signed as GitHub signs it. */
export function testDelivery(
  route: HermesWebhookRoute,
  deliveryId: string,
  message: string,
): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(JSON.stringify({ test: true, event_type: 'test', message }));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': 'test',
    'x-request-id': deliveryId,
  };
  if (route.secret && route.secret !== INSECURE_NO_AUTH) {
    headers['x-hub-signature-256'] = `sha256=${hmacHex(route.secret, body)}`;
  }
  return { body, headers };
}

function hmacHex(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
