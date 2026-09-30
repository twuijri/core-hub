/**
 * The configuration the hub writes for CLIProxyAPI, the format translator behind its model
 * gateway (ADR 0029).
 *
 * CLIProxyAPI (router-for-me/CLIProxyAPI, MIT) is run as the hub's own helper, never as the
 * person's: loopback only, its management API and control panel off, no OAuth credential, no
 * plugins, no LAN discovery, no request logs. The only client key it accepts is one the hub made
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

/** How CLIProxyAPI reaches one provider: its native Anthropic or Gemini surface, or OpenAI's. */
export type UpstreamKind = 'claude' | 'gemini' | 'openai-compatibility';

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
  /** An empty folder of the hub's: CLIProxyAPI's OAuth store, which the hub never fills. */
  authDir: string;
  upstreams: readonly GatewayUpstream[];
}

/** The YAML text of CLIProxyAPI's config file (its v8 layout). */
export function cliproxyConfig(input: CliproxyConfigInput): string {
  const groups: Record<UpstreamKind, unknown[]> = {
    claude: [],
    gemini: [],
    'openai-compatibility': [],
  };
  for (const upstream of input.upstreams) {
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
    // An empty secret key turns the management API off entirely (404), panel included.
    management: {
      'allow-remote': false,
      'secret-key': '',
      'disable-control-panel': true,
      'disable-auto-update-panel': true,
    },
    access: { 'api-keys': [input.internalKey] },
    routing: {
      strategy: 'round-robin',
      'session-affinity': false,
      'force-model-prefix': true,
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
      usage: { 'usage-statistics-enabled': false },
      pprof: { enable: false },
    },
    plugins: { enabled: false },
  };
  return `# Written by Core Hub for its model gateway (ADR 0029). Do not edit: it is rewritten\n# whenever the hub's providers change. It holds provider keys: readable by the hub only.\n${stringify(document, { lineWidth: 0 })}`;
}
