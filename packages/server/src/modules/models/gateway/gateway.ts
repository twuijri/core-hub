/**
 * The hub's model gateway (ADR 0029): the one door every coding agent the hub runs uses to reach
 * a model, so any agent can run on any model connected once in the hub.
 *
 *     agent ──(session token, alias model)──▶ this gateway (127.0.0.1, a port of its own)
 *              ├─ the token → which profile, person, agent and conversation; which turn
 *              ├─ the alias (`corehub-main`) → the model the turn chose → `h<row>/<model>`
 *              └─ CLIProxyAPI (127.0.0.1, the hub's key only) ──(the row's real key)──▶ provider
 *
 * The agent speaks its own wire — Anthropic Messages (Claude Code), OpenAI Responses (Codex),
 * OpenAI Chat Completions (Goose, OpenCode, Qwen Code, Kimi Code, Grok Build, Pi), Google Gemini
 * `generateContent` (Gemini CLI) — and CLIProxyAPI translates it
 * to whatever the provider speaks, tools, streaming and thinking included. The answer comes back
 * byte for byte; the gateway only reads the usage out of it for the run's ledger.
 *
 * It listens on a loopback port of its own, not on the hub's: a reverse proxy, a tunnel or the LAN
 * reaches the hub's port, never this one — and a request that is not from 127.0.0.1 / ::1 is
 * refused all the same. Nothing is served without a live session token.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import type { GatewayUpstream } from './cliproxy-config.js';
import { upstreamModel } from './cliproxy-config.js';
import { CliproxyUnavailable, type CliproxySupervisor } from './cliproxy.js';
import {
  GatewayTokens,
  type GatewayGrantInput,
  type GatewayGrantRecord,
  type GatewayTurn,
  type GatewayTurnUsage,
} from './tokens.js';
import { NO_USAGE, UsageTap, addUsage, type CallUsage } from './usage.js';

/** The model names an agent is started with; each resolves to the model its turn chose. */
export const GATEWAY_MODEL_ALIASES = ['corehub-main', 'corehub-small'] as const;
export const GATEWAY_MAIN_MODEL = 'corehub-main';
export const GATEWAY_SMALL_MODEL = 'corehub-small';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

type Wire = 'anthropic' | 'openai' | 'google';

interface Route {
  wire: Wire;
  /** The path CLIProxyAPI serves it on. */
  upstream: string;
}

/**
 * The Gemini wire's one route shape: the model and the method in the path
 * (`/v1beta/models/<model>:streamGenerateContent?alt=sse`), as `@google/genai` sends it under
 * `GOOGLE_GEMINI_BASE_URL`. CLIProxyAPI 8.0.4 serves the same three methods on `/v1beta` and
 * translates them to whatever the provider speaks (`translator/openai/gemini`, tools included).
 */
const GEMINI_ACTION =
  /^\/gateway\/google\/(v1beta|v1alpha|v1)\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;
const GEMINI_MODELS = /^\/gateway\/google\/(v1beta|v1alpha|v1)\/models(?:\/([^:]+))?$/;

const ROUTES: Record<string, Route> = {
  '/gateway/anthropic/v1/messages': { wire: 'anthropic', upstream: '/v1/messages' },
  '/gateway/anthropic/v1/messages/count_tokens': {
    wire: 'anthropic',
    upstream: '/v1/messages/count_tokens',
  },
  '/gateway/openai/v1/responses': { wire: 'openai', upstream: '/v1/responses' },
  '/gateway/openai/v1/chat/completions': { wire: 'openai', upstream: '/v1/chat/completions' },
};

/** A model the turn may run on, as `models` resolves it for the gateway. */
export interface GatewayTarget {
  /** The provider row that serves it for this profile (its own over a shared one). */
  providerId: string;
  model: string;
  modelLabel: string;
  price(usage: CallUsage): { costMicroUsd?: number; costSource: 'estimated' | 'unknown' };
}

/** What the gateway asks of the `models` module; it never reads a row or a key itself. */
export interface GatewaySource {
  /** Every provider CLIProxyAPI may serve, with its key (never a signed-in subscription). */
  upstreams(): GatewayUpstream[];
  /** A `"<provider slug>/<model>"` catalogue key, resolved in a profile. */
  resolveKey(workspace: string, key: string): { providerId: string; model: string } | null;
  /** The row and model a profile runs `model` of `providerId` on, or why it cannot. */
  target(workspace: string, providerId: string, model: string): GatewayTarget | { refusal: string };
  /** The catalogue keys a profile's coding agents can run, for `/v1/models`. */
  modelKeys(workspace: string): string[];
  /** A call that ended after its turn did: added to that run's ledger row. */
  recordLate(grant: GatewayGrantRecord, runId: string, usage: GatewayTurnUsage): void;
}

export interface ModelGatewayOptions {
  cliproxy: CliproxySupervisor;
  source: GatewaySource;
  log: FastifyBaseLogger;
  /** False when the operator switched it off (`COREHUB_MODEL_GATEWAY=off`). */
  enabled: boolean;
  /** Tests: the address it listens on (always a loopback one). */
  host?: string;
}

/** What an agent session is given: where the gateway is, its token, and the turn switch. */
export interface GatewayGrant {
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  /** The Gemini API root (`…/gateway/google`; the client adds `/v1beta/models/…`). */
  googleBaseUrl: string;
  /** `http://127.0.0.1:<port>`, for an agent that takes a host and a path separately. */
  origin: string;
  token: string;
  setTurn(turn: GatewayTurn | null): void;
  revoke(): void;
}

export class ModelGatewayUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelGatewayUnavailable';
  }
}

export class ModelGateway {
  readonly tokens = new GatewayTokens();
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private upstreamCache: { at: number; value: GatewayUpstream[] } | null = null;

  constructor(private readonly options: ModelGatewayOptions) {}

  /** Whether an agent can be pointed here at all: switched on, and CLIProxyAPI is present. */
  available(): boolean {
    return this.options.enabled && this.options.cliproxy.status().state !== 'absent';
  }

  /** The loopback port it listens on, starting the listener the first time. */
  listen(): Promise<number> {
    if (this.listening) return this.listening;
    this.listening = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          this.options.log.warn({ err: error }, 'gateway: request failed');
          if (!response.headersSent) {
            fail(response, 'openai', 500, 'api_error', 'the model gateway failed');
          } else response.destroy();
        });
      });
      server.keepAliveTimeout = 65_000;
      server.requestTimeout = 0;
      server.once('error', reject);
      server.listen(0, this.options.host ?? '127.0.0.1', () => {
        this.server = server;
        const port = (server.address() as AddressInfo).port;
        this.options.log.info({ port }, 'gateway: listening on loopback');
        resolve(port);
      });
    });
    return this.listening;
  }

  /**
   * A session token for one agent process, and the addresses it is to use. Starts the listener
   * (and, on first use, CLIProxyAPI) so the agent's first call finds both.
   */
  async open(input: GatewayGrantInput): Promise<GatewayGrant> {
    if (!this.available())
      throw new ModelGatewayUnavailable('the model gateway is off on this hub');
    const port = await this.listen();
    // Started now rather than on the agent's first call: a missing or broken translator is said
    // when the conversation opens, not in the middle of its first answer.
    await this.options.cliproxy.lease(this.upstreams(true)).then((lease) => lease.done());
    const record = this.tokens.mint(input);
    const origin = `http://127.0.0.1:${port}`;
    return {
      anthropicBaseUrl: `${origin}/gateway/anthropic`,
      openaiBaseUrl: `${origin}/gateway/openai/v1`,
      googleBaseUrl: `${origin}/gateway/google`,
      origin,
      token: record.token,
      setTurn: (turn) => this.tokens.setTurn(record, turn),
      revoke: () => this.tokens.revoke(record),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.options.cliproxy.stop();
  }

  /** Every upstream, read at most once every few seconds (a turn makes many calls). */
  private upstreams(fresh = false): GatewayUpstream[] {
    const at = Date.now();
    if (!fresh && this.upstreamCache && at - this.upstreamCache.at < 3_000) {
      return this.upstreamCache.value;
    }
    const value = this.options.source.upstreams();
    this.upstreamCache = { at, value };
    return value;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const wire: Wire = url.pathname.startsWith('/gateway/anthropic')
      ? 'anthropic'
      : url.pathname.startsWith('/gateway/google/')
        ? 'google'
        : 'openai';
    if (!isLoopback(request.socket.remoteAddress)) {
      fail(response, wire, 403, 'permission_error', 'the model gateway serves this computer only');
      return;
    }
    // Claude Code's warm-up probe: nothing to authenticate, nothing to say.
    if (url.pathname === '/gateway/anthropic/api/hello') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const grant = this.tokens.resolve(presentedToken(request, url));
    if (!grant) {
      request.resume();
      fail(
        response,
        wire,
        401,
        'authentication_error',
        'a Core Hub session token is required; this one is unknown, expired or revoked',
      );
      return;
    }
    if (
      request.method === 'GET' &&
      (url.pathname === '/gateway/anthropic/v1/models' ||
        url.pathname === '/gateway/openai/v1/models')
    ) {
      this.models(response, wire, grant);
      return;
    }
    if (wire === 'google') {
      await this.handleGemini(request, response, url, grant);
      return;
    }
    const route = ROUTES[url.pathname];
    if (!route || request.method !== 'POST') {
      request.resume();
      fail(
        response,
        wire,
        404,
        'not_found_error',
        `the model gateway has no ${request.method} ${url.pathname}`,
      );
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('not an object');
    } catch (error) {
      fail(
        response,
        route.wire,
        400,
        'invalid_request_error',
        `the request body is not JSON: ${String(error instanceof Error ? error.message : error)}`,
      );
      return;
    }
    const resolved = this.resolveModel(grant, typeof body.model === 'string' ? body.model : '');
    if ('refusal' in resolved) {
      fail(response, route.wire, 400, 'invalid_request_error', resolved.refusal);
      return;
    }
    const upstreams = this.upstreams();
    if (!upstreams.some((upstream) => upstream.providerId === resolved.target.providerId)) {
      fail(
        response,
        route.wire,
        400,
        'invalid_request_error',
        `${resolved.target.modelLabel} is not available to coding agents through Core Hub: its provider has no key the hub can use, or it is a signed-in subscription, which the hub does not lend to other agents`,
      );
      return;
    }
    body.model = upstreamModel(resolved.target.providerId, resolved.target.model);
    await this.forward(
      request,
      response,
      route.wire,
      `${route.upstream}${url.search}`,
      body,
      grant,
      resolved.target,
      upstreams,
    );
  }

  /**
   * The Gemini wire (Gemini CLI): the model is in the path, not the body, so the path is what is
   * rewritten — `models/corehub-main:streamGenerateContent` becomes
   * `models/h<row>/<model>:streamGenerateContent` on CLIProxyAPI's `/v1beta`. The key a client may
   * put in the query (`?key=`) is taken out before anything is forwarded.
   */
  private async handleGemini(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    grant: GatewayGrantRecord,
  ): Promise<void> {
    if (request.method === 'GET') {
      const listing = GEMINI_MODELS.exec(url.pathname);
      request.resume();
      if (listing) {
        const ids = this.modelIds(grant);
        const one = listing[2] ? safeDecode(listing[2]).replace(/^models\//, '') : null;
        if (one && !ids.includes(one)) {
          fail(response, 'google', 404, 'NOT_FOUND', `models/${one} is not found`);
          return;
        }
        const describe = (id: string) => ({
          name: `models/${id}`,
          displayName: id,
          description: id,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(one ? describe(one) : { models: ids.map(describe) }));
        return;
      }
    }
    const action = GEMINI_ACTION.exec(url.pathname);
    if (!action || request.method !== 'POST') {
      request.resume();
      fail(
        response,
        'google',
        404,
        'NOT_FOUND',
        `the model gateway has no ${request.method} ${url.pathname}`,
      );
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('not an object');
    } catch (error) {
      fail(
        response,
        'google',
        400,
        'INVALID_ARGUMENT',
        `the request body is not JSON: ${String(error instanceof Error ? error.message : error)}`,
      );
      return;
    }
    const resolved = this.resolveModel(grant, safeDecode(action[2]!));
    if ('refusal' in resolved) {
      fail(response, 'google', 400, 'INVALID_ARGUMENT', resolved.refusal);
      return;
    }
    const upstreams = this.upstreams();
    if (!upstreams.some((upstream) => upstream.providerId === resolved.target.providerId)) {
      fail(
        response,
        'google',
        400,
        'INVALID_ARGUMENT',
        `${resolved.target.modelLabel} is not available to coding agents through Core Hub: its provider has no key the hub can use, or it is a signed-in subscription, which the hub does not lend to other agents`,
      );
      return;
    }
    const query = new URLSearchParams(url.search);
    query.delete('key');
    const search = query.size > 0 ? `?${query.toString()}` : '';
    const model = upstreamModel(resolved.target.providerId, resolved.target.model);
    await this.forward(
      request,
      response,
      'google',
      `/v1beta/models/${model}:${action[3]}${search}`,
      body,
      grant,
      resolved.target,
      upstreams,
    );
  }

  private resolveModel(
    grant: GatewayGrantRecord,
    asked: string,
  ): { target: GatewayTarget } | { refusal: string } {
    const { source } = this.options;
    // A catalogue key the agent was given or typed (`/model openrouter/…`) names its own model.
    if (asked.includes('/') && !(GATEWAY_MODEL_ALIASES as readonly string[]).includes(asked)) {
      const key = source.resolveKey(grant.workspace, asked);
      if (key) {
        const target = source.target(grant.workspace, key.providerId, key.model);
        return 'refusal' in target ? target : { target };
      }
    }
    // An alias — or any id this hub does not know, such as a vendor's default a subagent asks
    // for — is the model the person chose for this turn.
    const selection = grant.turn ?? grant.selection;
    if (!selection) {
      return {
        refusal:
          'no model is chosen for this conversation: pick one in the model picker, or set a default model in Settings → Models',
      };
    }
    const target = source.target(grant.workspace, selection.providerId, selection.model);
    return 'refusal' in target ? target : { target };
  }

  /** The ids a profile's agents may ask for: the aliases, then the catalogue keys. */
  private modelIds(grant: GatewayGrantRecord): string[] {
    return [...GATEWAY_MODEL_ALIASES, ...this.options.source.modelKeys(grant.workspace)];
  }

  private models(response: ServerResponse, wire: Wire, grant: GatewayGrantRecord): void {
    const ids = this.modelIds(grant);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (wire === 'anthropic') {
      response.end(
        JSON.stringify({
          data: ids.map((id) => ({
            type: 'model',
            id,
            display_name: id,
            created_at: '1970-01-01T00:00:00Z',
          })),
          has_more: false,
          first_id: ids[0] ?? null,
          last_id: ids.at(-1) ?? null,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'corehub' })),
      }),
    );
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    wire: Wire,
    /** CLIProxyAPI's path, query included. */
    upstreamPath: string,
    body: Record<string, unknown>,
    grant: GatewayGrantRecord,
    target: GatewayTarget,
    upstreams: GatewayUpstream[],
  ): Promise<void> {
    let lease;
    try {
      lease = await this.options.cliproxy.lease(upstreams);
    } catch (error) {
      const message =
        error instanceof CliproxyUnavailable
          ? error.message
          : 'the model gateway could not start its translator';
      fail(response, wire, 503, 'api_error', message);
      return;
    }
    // A call belongs to the turn it started in, even if it ends after the turn.
    const turn = grant.turn;
    const runId = turn?.runId ?? grant.lastRunId;
    const payload = Buffer.from(JSON.stringify(body));
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: lease.port,
      method: 'POST',
      path: upstreamPath,
      headers: {
        ...forwardHeaders(request.headers),
        authorization: `Bearer ${lease.key}`,
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      lease.done();
    };
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy();
      finish();
    });
    upstream.on('error', (error) => {
      finish();
      if (!response.headersSent) {
        fail(
          response,
          wire,
          502,
          'api_error',
          `the model gateway's translator did not answer: ${error.message}`,
        );
      } else response.destroy();
    });
    upstream.on('response', (answer) => {
      const status = answer.statusCode ?? 502;
      response.writeHead(status, answerHeaders(answer.headers));
      const tap = status < 400 ? new UsageTap(answer.headers['content-type']) : null;
      answer.on('data', (chunk: Buffer) => {
        tap?.push(chunk);
        if (!response.write(chunk)) {
          answer.pause();
          response.once('drain', () => answer.resume());
        }
      });
      answer.on('end', () => {
        response.end();
        finish();
        const used = tap?.result();
        if (used && runId) this.account(grant, turn, runId, target, used);
      });
      answer.on('error', () => {
        finish();
        response.destroy();
      });
    });
    upstream.end(payload);
  }

  /** One call's usage into its turn's totals (or, the turn over, straight into the ledger). */
  private account(
    grant: GatewayGrantRecord,
    turn: GatewayTurn | null,
    runId: string,
    target: GatewayTarget,
    used: CallUsage,
  ): void {
    const priced = (usage: CallUsage): GatewayTurnUsage => ({
      modelLabel: target.modelLabel,
      providerId: target.providerId,
      ...usage,
      ...target.price(usage),
    });
    const live = turn && grant.turn === turn && !grant.revoked;
    if (live) {
      const previous = grant.totals.get(target.modelLabel);
      const total = addUsage(previous ?? NO_USAGE, used);
      const report = priced(total);
      grant.totals.set(target.modelLabel, report);
      try {
        turn.report(report);
      } catch (error) {
        this.options.log.warn({ err: error }, 'gateway: the turn refused a usage report');
      }
      return;
    }
    try {
      this.options.source.recordLate(grant, runId, priced(used));
    } catch (error) {
      this.options.log.warn({ err: error, runId }, 'gateway: could not record a late call');
    }
  }
}

/** Whether a peer address is this computer's own (IPv4, IPv6, IPv4-mapped IPv6). */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * The token as each wire sends its key: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`,
 * or — the Gemini API's other way — `?key=` in the query.
 */
function presentedToken(request: IncomingMessage, url: URL): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim();
  }
  for (const name of ['x-api-key', 'x-goog-api-key']) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const key = url.searchParams.get('key');
  return key?.trim() ? key.trim() : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** The agent's headers, less its credential, the hop's own and anything naming a client address. */
function forwardHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (
      [
        'host',
        'content-length',
        'authorization',
        'x-api-key',
        'x-goog-api-key',
        'cookie',
        'forwarded',
        'x-real-ip',
      ].includes(lower) ||
      lower.startsWith('x-forwarded-')
    ) {
      continue;
    }
    out[lower] = value;
  }
  return out;
}

/** The translator's headers, less the hop's own, cookies and its CORS answer. */
function answerHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie' || lower.startsWith('access-control-')) {
      continue;
    }
    out[lower] = value;
  }
  return out;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`larger than ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** An error in the envelope the agent's own wire uses, so it reads the words. */
function fail(
  response: ServerResponse,
  wire: Wire,
  status: number,
  type: string,
  message: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body =
    wire === 'anthropic'
      ? { type: 'error', error: { type, message } }
      : wire === 'google'
        ? { error: { code: status, message, status: googleStatus(status, type) } }
        : { error: { message, type, code: type } };
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The Gemini API's `status` word for an error (its `google.rpc.Code` names). */
function googleStatus(status: number, type: string): string {
  if (/^[A-Z_]+$/.test(type)) return type;
  switch (status) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}
