/**
 * The model gateway's external entrance (DECISIONS §156, ADR 0033 §3): the gateway's OpenAI and
 * Anthropic wires on the hub's own API port, for a person's own programs — DeepSeek Harness
 * through the Core Hub plugin — with that person's app token.
 *
 * - **Off until an admin switches it on** (`models.updateExternalGateway`). The switch is kept in
 *   `<DATA_DIR>/gateway/external.json` (`0600`), beside the gateway's other state.
 * - **Who may call:** a person's own app token (`hub_at_…`, a paired device's or a personal one).
 *   Never a web session, an agent's run token, or a session token of the loopback gateway (those
 *   are not even read here: they are not principals of the hub). `x-api-key` is accepted in place
 *   of `Authorization: Bearer`, as Anthropic clients send it (auth's hook reads it on these paths).
 * - **A rate limit per token**: `COREHUB_EXTERNAL_GATEWAY_RATE_LIMIT` calls a minute (120).
 * - **Errors are in the caller's own wire** (`wireError`), never the hub's `{error, code}`.
 *
 * What is served and how — the models offered, the call, the usage — is `ModelGateway`'s
 * (`serveExternal`): the same road to CLIProxyAPI as the hub's own agents take.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { defineRoute, type RouteDeps } from '../../../lib/route.js';
import { HubError } from '../../../lib/errors.js';
import { requireSqlite } from '../../../lib/db.js';
import { t } from '../../../i18n/index.js';
import { listWorkspacesFor } from '../../auth/index.js';
import { auditFor } from '../../audit/index.js';
import { wireError, type ExternalRoute, type ModelGateway } from './gateway.js';

/** Calls a minute one token may make when the operator does not say. */
export const DEFAULT_EXTERNAL_RATE_LIMIT = 120;
/** A model call carries the whole conversation: as large as the loopback gateway takes. */
const MAX_CALL_BYTES = 64 * 1024 * 1024;
/** The window the rate limit counts in. */
const WINDOW_MS = 60_000;

/** Where an OpenAI and an Anthropic client point, on this hub (a client adds its origin). */
export const EXTERNAL_PATHS = {
  openai: '/api/v1/gateway/openai/v1',
  anthropic: '/api/v1/gateway/anthropic',
} as const;

/** The one switch, kept beside the gateway's other state. */
export class ExternalGatewaySettings {
  private cached: boolean | null = null;

  constructor(private readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, 'external.json');
  }

  enabled(): boolean {
    if (this.cached !== null) return this.cached;
    try {
      if (existsSync(this.file)) {
        const read = JSON.parse(readFileSync(this.file, 'utf8')) as { enabled?: unknown };
        return (this.cached = read.enabled === true);
      }
    } catch {
      // An unreadable file is the default: off.
    }
    return (this.cached = false);
  }

  set(enabled: boolean, by: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.file,
      JSON.stringify({ enabled, updated_at: new Date().toISOString(), updated_by: by }),
      { mode: 0o600 },
    );
    chmodSync(this.file, 0o600);
    this.cached = enabled;
  }
}

/** Calls per token in the last minute; a call over the limit is told when to try again. */
export class TokenRateLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts the call, or returns the seconds until one more is allowed. */
  take(tokenId: string): { ok: true } | { ok: false; retryAfterS: number } {
    const at = this.now();
    const recent = (this.calls.get(tokenId) ?? []).filter((time) => at - time < WINDOW_MS);
    if (recent.length >= this.perMinute) {
      this.calls.set(tokenId, recent);
      return {
        ok: false,
        retryAfterS: Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - at) / 1000)),
      };
    }
    recent.push(at);
    this.calls.set(tokenId, recent);
    if (this.calls.size > 10_000) this.sweep(at);
    return { ok: true };
  }

  private sweep(at: number): void {
    for (const [token, times] of this.calls) {
      if (times.every((time) => at - time >= WINDOW_MS)) this.calls.delete(token);
    }
  }
}

const ROUTES: ReadonlyArray<{ operationId: string; route: ExternalRoute }> = [
  { operationId: 'gateway.openaiListModels', route: { wire: 'openai', call: 'models' } },
  {
    operationId: 'gateway.openaiChatCompletions',
    route: { wire: 'openai', call: 'chat/completions' },
  },
  { operationId: 'gateway.openaiResponses', route: { wire: 'openai', call: 'responses' } },
  { operationId: 'gateway.anthropicListModels', route: { wire: 'anthropic', call: 'models' } },
  { operationId: 'gateway.anthropicMessages', route: { wire: 'anthropic', call: 'messages' } },
];

export interface ExternalGatewayDeps {
  gateway: () => ModelGateway;
  settings: ExternalGatewaySettings;
  limiter: TokenRateLimiter;
}

/** `ExternalGateway` of the contract, in the request's language. */
function view(deps: ExternalGatewayDeps, request: FastifyRequest) {
  const gateway = deps.gateway();
  const reason = !gateway.enabled()
    ? t('models.external_gateway.gateway_off', request.uiLanguage)
    : !gateway.available()
      ? t('models.external_gateway.no_translator', request.uiLanguage)
      : null;
  return {
    enabled: deps.settings.enabled(),
    available: reason === null,
    reason,
    openai_base_path: EXTERNAL_PATHS.openai,
    anthropic_base_path: EXTERNAL_PATHS.anthropic,
    rate_limit_per_minute: deps.limiter.perMinute,
  };
}

export function registerExternalGatewayRoutes(
  app: FastifyInstance,
  routeDeps: RouteDeps,
  deps: ExternalGatewayDeps,
): void {
  defineRoute(app, routeDeps, {
    operationId: 'models.getExternalGateway',
    handler: (request) => view(deps, request),
  });

  defineRoute(app, routeDeps, {
    operationId: 'models.updateExternalGateway',
    handler: (request, { body }) => {
      const principal = request.principal;
      if (!principal) throw new HubError('unauthorized');
      const enabled = (body as { enabled: boolean }).enabled;
      const was = deps.settings.enabled();
      deps.settings.set(enabled, principal.user.id);
      if (was !== enabled) {
        auditFor(app).record({
          actorKind: 'user',
          actorId: principal.user.id,
          ownerId: principal.user.id,
          action: 'gateway.external_switched',
          summary: `model gateway external entrance ${enabled ? 'on' : 'off'}`,
          data: { enabled },
          requestId: request.id,
        });
      }
      return view(deps, request);
    },
  });

  for (const { operationId, route } of ROUTES) {
    defineRoute(app, routeDeps, {
      operationId,
      bodyLimit: MAX_CALL_BYTES,
      handler: (request, { body }, reply) => serve(app, deps, route, request, reply, body),
    });
  }
}

async function serve(
  app: FastifyInstance,
  deps: ExternalGatewayDeps,
  route: ExternalRoute,
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
): Promise<FastifyReply> {
  reply.hijack();
  const response = reply.raw;
  const refuse = (
    status: number,
    type: string,
    message: string,
    headers: Record<string, string> = {},
  ) => {
    wireError(response, route.wire, status, type, message, headers);
    return reply;
  };
  if (!deps.settings.enabled()) {
    return refuse(
      403,
      'permission_error',
      'the external entrance of the model gateway is off on this hub; an admin switches it on in Settings → Models',
    );
  }
  const principal = request.principal;
  if (!principal) {
    return refuse(
      401,
      'authentication_error',
      request.authError
        ? 'a Core Hub app token is required; this one is unknown, expired or revoked'
        : 'a Core Hub app token is required (Authorization: Bearer hub_at_…)',
    );
  }
  // A person's own app token only: not a web session, not an agent's run token.
  if (
    principal.kind !== 'app_token' ||
    principal.user.pinnedWorkspaceId ||
    (principal.tokenKind !== 'personal' && principal.tokenKind !== 'device')
  ) {
    return refuse(
      403,
      'permission_error',
      "only a person's own app token (hub_at_…) may use the external entrance",
    );
  }
  const scope = route.call === 'models' ? 'read' : 'write';
  if (!principal.scopes.includes(scope)) {
    return refuse(403, 'permission_error', `this app token lacks the ${scope} scope`);
  }
  const limited = deps.limiter.take(principal.tokenId);
  if (!limited.ok) {
    return refuse(
      429,
      'rate_limit_error',
      `too many calls through Core Hub this minute; try again in ${limited.retryAfterS} seconds`,
      { 'retry-after': String(limited.retryAfterS) },
    );
  }
  const db = requireSqlite(app.hub.database);
  const entered = listWorkspacesFor(db, principal.user);
  // A profile the caller names (`X-Hub-Profile`) is asked first; the default otherwise.
  const named = request.headers['x-hub-profile'];
  const wanted = (Array.isArray(named) ? named[0] : named)?.trim();
  const first = wanted ? entered.find((row) => row.slug === wanted || row.id === wanted) : null;
  const workspaces = [
    ...(first ? [first.id] : []),
    ...entered.map((row) => row.id).filter((id) => id !== first?.id),
  ];
  try {
    await deps.gateway().serveExternal(request.raw, response, route, body, {
      userId: principal.user.id,
      tokenId: principal.tokenId,
      workspaces,
    });
  } catch (error) {
    request.log.warn({ err: error }, 'gateway: an external call failed');
    if (!response.headersSent) {
      wireError(response, route.wire, 500, 'api_error', 'the model gateway failed');
    } else response.destroy();
  }
  return reply;
}
