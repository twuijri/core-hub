/**
 * The configuration the hub writes for CLIProxyAPI, the format translator behind its model
 * gateway (ADR 0029).
 *
 * CLIProxyAPI (router-for-me/CLIProxyAPI, MIT) is run as the hub's own helper, never as the
 * person's: loopback only, its control panel off, no plugins, no LAN discovery, no request logs.
 * Its management API answers the hub alone (a random secret, loopback) for the subscription
 * sign-ins it holds (DECISIONS §143). The only client key it accepts is one the hub made
 * (`internalKey`), so the only way in is through the hub's own gateway, which checks a session
 * token first. The provider keys it needs are the hub's — this file is the one place outside the
 * encrypted `secrets` table they are written to, readable by the hub's user only (0600,
 * `cliproxy.ts`).
 *
 * Every provider row is one upstream group named and prefixed `h<row id>`: the gateway asks for
 * `h<row id>/<model>` and `routing.force-model-prefix` makes that name reach exactly that row,
 * whatever else serves a model of the same name. Each group lists the row's chat models, because
 * CLIProxyAPI serves only the models a group names.
 */
import { stringify } from 'yaml';

/**
 * How CLIProxyAPI reaches one provider: its native Anthropic or Gemini surface, or OpenAI's — or,
 * for a subscription signed in to through the gateway (DECISIONS §143), the accounts in its own
 * store that carry the row's prefix. Such a row is in no group of the file: its accounts are.
 */
export type UpstreamKind = 'claude' | 'gemini' | 'openai-compatibility' | 'subscription';

/** Key groups of the file: every kind but `subscription`. */
type KeyGroupKind = Exclude<UpstreamKind, 'subscription'>;

/** One provider row, as the gateway hands it to CLIProxyAPI. */
export interface GatewayUpstream {
  /** The hub's `providers` row id. */
  providerId: string;
  kind: UpstreamKind;
  baseUrl: string;
  /** The row's key; `null` for a provider that needs none (Ollama, LM Studio). */
  apiKey: string | null;
  /** Non-secret headers the row carries (an organisation id). */
  headers: Readonly<Record<string, string>>;
  models: readonly { id: string; contextWindow: number | null }[];
}

/** Stands in for the key of a provider that needs none: CLIProxyAPI wants a key per group. */
export const NO_KEY = 'corehub-no-key';

/** `h` and the row id, lower case: a model prefix CLIProxyAPI routes on. */
export function upstreamPrefix(providerId: string): string {
  return `h${providerId.toLowerCase()}`;
}

/**
 * The name CLIProxyAPI knows a row's model by, before the prefix: the model's own id, except that
 * a `:` (Ollama's `qwen3:8b`) becomes `__`. The Gemini wire carries the model in the path, where
 * CLIProxyAPI splits `models/<model>:<method>` on the colon (8.0.4 `GeminiHandler`); the alias
 * maps back to the real id upstream (`name`), so the provider sees the id it listed.
 */
export function upstreamAlias(model: string): string {
  return model.replaceAll(':', '__');
}

/** The model name CLIProxyAPI serves a row's model under. */
export function upstreamModel(providerId: string, model: string): string {
  return `${upstreamPrefix(providerId)}/${upstreamAlias(model)}`;
}

export interface CliproxyConfigInput {
  port: number;
  /** The one client key CLIProxyAPI accepts: the hub's own. */
  internalKey: string;
  /**
   * The management API's secret (DECISIONS §143): random, made by the hub, known to the hub only,
   * accepted from loopback only. The subscription sign-ins, their accounts and their health are
   * read and changed through it. Its control panel stays off.
   */
  managementKey: string;
  /**
   * CLIProxyAPI's account store: the subscriptions signed in to through the gateway, one `0600`
   * file per account, in a `0700` folder of the hub's.
   */
  authDir: string;
  upstreams: readonly GatewayUpstream[];
}

/** The YAML text of CLIProxyAPI's config file (its v8 layout). */
export function cliproxyConfig(input: CliproxyConfigInput): string {
  const groups: Record<KeyGroupKind, unknown[]> = {
    claude: [],
    gemini: [],
    'openai-compatibility': [],
  };
  for (const upstream of input.upstreams) {
    if (upstream.kind === 'subscription') continue;
    if (upstream.models.length === 0) continue;
    const prefix = upstreamPrefix(upstream.providerId);
    groups[upstream.kind].push({
      name: prefix,
      prefix,
      'base-url': upstream.baseUrl,
      ...(Object.keys(upstream.headers).length > 0 ? { headers: { ...upstream.headers } } : {}),
      keys: [{ 'api-key': upstream.apiKey ?? NO_KEY }],
      models: upstream.models.map((model) => ({
        name: model.id,
        alias: upstreamAlias(model.id),
        ...(model.contextWindow ? { 'max-context-length': model.contextWindow } : {}),
      })),
    });
  }
  const apiKeys = Object.fromEntries(Object.entries(groups).filter(([, list]) => list.length > 0));
  const document = {
    'config-version': 8,
    server: {
      host: '127.0.0.1',
      port: input.port,
      'trusted-proxies': [],
      tls: { enable: false },
      discovery: { enabled: false },
    },
    // The management API, for the subscription sign-ins (DECISIONS §143): loopback only, a
    // secret only the hub knows (CLIProxyAPI hashes it into this file at start), no panel.
    management: {
      'allow-remote': false,
      'secret-key': input.managementKey,
      'disable-control-panel': true,
      'disable-auto-update-panel': true,
    },
    access: { 'api-keys': [input.internalKey] },
    routing: {
      strategy: 'round-robin',
      'session-affinity': false,
      'force-model-prefix': true,
      // Each provider row is one key, so there is no other credential to rotate to: a provider's
      // 429 goes straight back to the gateway, which decides (a quota answered at once, a
      // passing rate limit left to the agent's own retries). Cooling would refuse the row for
      // a growing while after one 429 — every turn, even after the provider has recovered, told
      // "All credentials for model h<row>/… are cooling down" (owner, 2026-09-30) — and a
      // retry round would hold the request while nothing is said.
      retry: { 'request-retry': 0, 'max-retry-interval': 0 },
      cooldown: { 'disable-cooling': true },
    },
    requests: {
      'proxy-url': '',
      'passthrough-headers': false,
      // A model that thinks for minutes must not look like a dead stream: Claude Code gives up
      // after 300 s of silence, Codex after its `stream_idle_timeout_ms`.
      streaming: { 'keepalive-seconds': 15, 'bootstrap-retries': 0 },
    },
    ...(Object.keys(apiKeys).length > 0 ? { 'api-keys': apiKeys } : {}),
    oauth: { 'auth-dir': input.authDir },
    multimedia: { 'disable-image-generation': true },
    observability: {
      logs: { debug: false, 'logging-to-file': false, 'request-log': false },
      // Kept in memory only: the failed calls the provider's dialog lists come from its queue.
      usage: { 'usage-statistics-enabled': true, 'redis-usage-queue-retention-seconds': 300 },
      pprof: { enable: false },
    },
    plugins: { enabled: false },
  };
  return `# Written by Core Hub for its model gateway (ADR 0029). Do not edit: it is rewritten\n# whenever the hub's providers change. It holds provider keys: readable by the hub only.\n${stringify(document, { lineWidth: 0 })}`;
}
