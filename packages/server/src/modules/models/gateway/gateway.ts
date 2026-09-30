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
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { GatewayUpstream } from './cliproxy-config.js';
import { upstreamModel } from './cliproxy-config.js';
import { CliproxyUnavailable, type CliproxySupervisor } from './cliproxy.js';
import { CodexDeviceLogin } from './cliproxy-login.js';
import { ManagementClient } from './cliproxy-management.js';
import type { SubscriptionBackend, SubscriptionModel } from '../subscriptions.js';
import {
  GatewayTokens,
  type GatewayGrantInput,
  type GatewayGrantRecord,
  type GatewayLimitReason,
  type GatewayQuotaFailure,
  type GatewayTurn,
  type GatewayTurnUsage,
} from './tokens.js';
import { NO_USAGE, UsageTap, addUsage, type CallUsage } from './usage.js';
import { redactSecrets } from '../../../lib/redact-text.js';

/** The model names an agent is started with; each resolves to the model its turn chose. */
export const GATEWAY_MODEL_ALIASES = ['corehub-main', 'corehub-small'] as const;
export const GATEWAY_MAIN_MODEL = 'corehub-main';
export const GATEWAY_SMALL_MODEL = 'corehub-small';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** An error answer is read whole before it is passed on; one larger than this is not an error body. */
const MAX_ERROR_BYTES = 1024 * 1024;

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
  /** The provider's name as the person gave it, for words people read (never the row's id). */
  providerLabel?: string;
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
  /**
   * Where the gateway keeps what outlives a restart (DECISIONS §143): the port it listened on
   * last (tried again first, so the address written into Hermes's files stays the same) and the
   * secret Hermes's profile tokens are signed with. Absent in tests of the gateway alone.
   */
  stateDir?: string;
  /** Tests: shorter waits for a provider's passing limit (`LIMIT_WAIT`). */
  limitWait?: { defaultMs: number; maxMs: number };
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

  private readonly limitWait: { defaultMs: number; maxMs: number };
  /** What CLIProxyAPI's Chat route said of a refused model, per grant, turn and model. */
  private readonly probed = new WeakMap<
    GatewayGrantRecord,
    Map<string, { ok: boolean; text: string }>
  >();

  constructor(private readonly options: ModelGatewayOptions) {
    this.limitWait = options.limitWait ?? LIMIT_WAIT;
  }

  /** Switched on by the operator (`COREHUB_MODEL_GATEWAY` is not `off`). */
  enabled(): boolean {
    return this.options.enabled;
  }

  /** Whether an agent can be pointed here at all: switched on, and CLIProxyAPI is present. */
  available(): boolean {
    return this.options.enabled && this.options.cliproxy.status().state !== 'absent';
  }

  /** The port it listens on now, or null before `listen()` has resolved. */
  port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  /**
   * The secret Hermes's profile tokens are signed with (DECISIONS §143): 32 random bytes, made
   * once, `0600` in the gateway's folder. Null without a folder.
   */
  private hermesSecret(): Buffer | null {
    if (this.secretCache !== undefined) return this.secretCache;
    const dir = this.options.stateDir;
    if (!dir) return (this.secretCache = null);
    const file = path.join(dir, 'hermes-token.key');
    try {
      if (existsSync(file)) {
        const read = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
        if (read.length >= 32) return (this.secretCache = read);
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const made = randomBytes(32);
      writeFileSync(file, made.toString('base64url'), { mode: 0o600 });
      chmodSync(file, 0o600);
      return (this.secretCache = made);
    } catch (error) {
      this.options.log.warn({ err: error }, 'gateway: no secret for Hermes tokens');
      return (this.secretCache = null);
    }
  }
  private secretCache: Buffer | null | undefined = undefined;

  /** A Hermes profile's long-lived token (DECISIONS §143), or null when there can be none. */
  hermesToken(workspace: string): string | null {
    if (!this.available()) return null;
    return this.tokens.hermesToken(workspace, this.hermesSecret());
  }

  /**
   * The address of one provider row through the gateway, for Hermes's per-row `providers:`
   * blocks (DECISIONS §143): `…/gateway/row/<row>/anthropic` (Messages) or
   * `…/gateway/row/<row>/openai/v1` (Responses, Chat Completions). Null before the listener is up.
   */
  rowAddress(providerId: string, wire: 'anthropic' | 'openai'): string | null {
    const port = this.port();
    if (!port) return null;
    const base = `http://127.0.0.1:${port}/gateway/row/${providerId}`;
    return wire === 'anthropic' ? `${base}/anthropic` : `${base}/openai/v1`;
  }

  /** The port the listener had last time, which it asks for again first. */
  private lastPort(): number {
    const dir = this.options.stateDir;
    if (!dir) return 0;
    try {
      const port = Number(readFileSync(path.join(dir, 'gateway.port'), 'utf8').trim());
      return Number.isInteger(port) && port > 1024 && port < 65536 ? port : 0;
    } catch {
      return 0;
    }
  }

  private rememberPort(port: number): void {
    const dir = this.options.stateDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, 'gateway.port'), String(port), { mode: 0o600 });
    } catch {
      // Only the next start's address is at stake.
    }
  }

  /** The loopback port it listens on, starting the listener the first time. */
  listen(): Promise<number> {
    if (this.listening) return this.listening;
    this.listening = this.listenOn(this.lastPort()).catch(() => this.listenOn(0));
    return this.listening;
  }

  private listenOn(wanted: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
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
      server.listen(wanted, this.options.host ?? '127.0.0.1', () => {
        this.server = server;
        const port = (server.address() as AddressInfo).port;
        this.options.log.info({ port }, 'gateway: listening on loopback');
        this.rememberPort(port);
        resolve(port);
      });
    });
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

  /**
   * What the models module needs to hold subscription sign-ins (DECISIONS §143): CLIProxyAPI's
   * management API on a running process, its ChatGPT device sign-in, and the models it serves
   * under a row's prefix.
   */
  subscriptions(fetchImpl: typeof fetch = fetch): SubscriptionBackend {
    const cliproxy = this.options.cliproxy;
    const lease = () => cliproxy.lease(this.upstreams(true));
    return {
      unavailable: () => {
        if (!this.options.enabled) return 'the model gateway is switched off on this hub';
        if (cliproxy.status().state === 'absent') return 'this hub has no CLIProxyAPI';
        return null;
      },
      open: async () => {
        const held = await lease();
        return {
          client: new ManagementClient({
            port: held.port,
            secret: held.managementKey,
            fetchImpl,
          }),
          done: () => held.done(),
        };
      },
      codexDeviceLogin: () => {
        const binary = cliproxy.binary();
        if (!binary) return null;
        return new CodexDeviceLogin({
          binary,
          stateDir: cliproxy.stateDir(),
          authDir: cliproxy.authDir(),
          env: cliproxy.env(),
        });
      },
      models: async (prefix) => {
        const held = await lease();
        try {
          const response = await fetchImpl(`http://127.0.0.1:${held.port}/v1/models`, {
            headers: { authorization: `Bearer ${held.key}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`the translator answered ${response.status}`);
          const body = (await response.json()) as { data?: Record<string, unknown>[] };
          const lead = `${prefix}/`;
          const out: SubscriptionModel[] = [];
          for (const entry of body.data ?? []) {
            const id = typeof entry.id === 'string' ? entry.id : '';
            if (!id.toLowerCase().startsWith(lead)) continue;
            const count = (value: unknown) =>
              typeof value === 'number' && value > 0 ? value : null;
            out.push({
              id: id.slice(lead.length),
              label: typeof entry.display_name === 'string' ? entry.display_name : null,
              contextWindow: count(entry.context_length) ?? count(entry.max_context_length),
              maxOutputTokens: count(entry.max_completion_tokens),
            });
          }
          return out;
        } finally {
          held.done();
        }
      },
    };
  }

  /** Whether any subscription is signed in through the gateway (an account in its store). */
  hasSubscriptionAccounts(): boolean {
    return this.available() && this.options.cliproxy.hasAccounts();
  }

  /**
   * The translator's own OpenAI address and key, held for one `direct` turn on a subscription
   * (DECISIONS §143): the hub's own agent reaches a signed-in account the way every other agent
   * does, through CLIProxyAPI, with no token of the account ever in the hub.
   */
  async direct(): Promise<{ baseUrl: string; key: string; done(): void }> {
    if (!this.available())
      throw new ModelGatewayUnavailable('the model gateway is off on this hub');
    const held = await this.options.cliproxy.lease(this.upstreams(true));
    return { baseUrl: `http://127.0.0.1:${held.port}/v1`, key: held.key, done: () => held.done() };
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

  /** The upstreams, read again when the cached list lacks the row a call is for. */
  private upstreamsWith(providerId: string): GatewayUpstream[] {
    const cached = this.upstreams();
    return cached.some((upstream) => upstream.providerId === providerId)
      ? cached
      : this.upstreams(true);
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
    // One provider row's own address (Hermes's per-row blocks, DECISIONS §143):
    // `/gateway/row/<row>/<wire>/…` is `/gateway/<wire>/…` for that row's models only.
    let row: string | null = null;
    const rowPath = /^\/gateway\/row\/([0-9A-Za-z]{10,40})(\/.*)$/.exec(url.pathname);
    if (rowPath) {
      row = rowPath[1]!;
      url.pathname = `/gateway${rowPath[2]}`;
    }
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
    const grant = this.tokens.resolve(presentedToken(request, url), this.hermesSecret());
    // A Hermes profile's token has no turn and lives for months: each of its calls stands alone
    // (Hermes keeps its own fallback chain), so nothing one call learnt about a quota stays.
    if (grant && !grant.turn && grant.agentSlug === 'hermes' && grant.sessionId === '') {
      grant.exhausted.clear();
      grant.waited.clear();
      grant.redirect = null;
    }
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
      this.models(response, wire, grant, row);
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
    const resolved = this.resolveModel(
      grant,
      typeof body.model === 'string' ? body.model : '',
      row,
    );
    if ('refusal' in resolved) {
      fail(response, route.wire, 400, 'invalid_request_error', resolved.refusal);
      return;
    }
    // The cached list, unless it does not have the row yet (a provider added a moment ago).
    const upstreams = this.upstreamsWith(resolved.target.providerId);
    if (!upstreams.some((upstream) => upstream.providerId === resolved.target.providerId)) {
      fail(
        response,
        route.wire,
        400,
        'invalid_request_error',
        `${resolved.target.modelLabel} is not available to agents through Core Hub: its provider has no key or signed-in account the hub can use, or it is a subscription signed in to through Hermes (move it to Core Hub's gateway in Settings → Models)`,
      );
      return;
    }
    await this.forward(
      request,
      response,
      {
        wire: route.wire,
        call: (target) => ({
          path: `${route.upstream}${url.search}`,
          body: { ...body, model: upstreamModel(target.providerId, target.model) },
        }),
      },
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
    // The cached list, unless it does not have the row yet (a provider added a moment ago).
    const upstreams = this.upstreamsWith(resolved.target.providerId);
    if (!upstreams.some((upstream) => upstream.providerId === resolved.target.providerId)) {
      fail(
        response,
        'google',
        400,
        'INVALID_ARGUMENT',
        `${resolved.target.modelLabel} is not available to agents through Core Hub: its provider has no key or signed-in account the hub can use, or it is a subscription signed in to through Hermes (move it to Core Hub's gateway in Settings → Models)`,
      );
      return;
    }
    const query = new URLSearchParams(url.search);
    query.delete('key');
    const search = query.size > 0 ? `?${query.toString()}` : '';
    await this.forward(
      request,
      response,
      {
        wire: 'google',
        call: (target) => ({
          path: `/v1beta/models/${upstreamModel(target.providerId, target.model)}:${action[3]}${search}`,
          body,
        }),
      },
      grant,
      resolved.target,
      upstreams,
    );
  }

  /**
   * The model a call runs on: the turn's, always (owner, 2026-09-30). Whatever id the agent
   * names — `corehub-main`, `corehub-small`, a vendor default a subagent asks for, or a model it
   * picked by itself from the list `/v1/models` gives it (Claude Code's bridge matches "opus" in
   * it) — the person chose the model in the hub's picker, and that is the one served. Once the
   * turn's model ran out of quota, the chain's model it moved on to (`redirect`).
   */
  private resolveModel(
    grant: GatewayGrantRecord,
    asked: string,
    row: string | null = null,
  ): { target: GatewayTarget } | { refusal: string } {
    const { source } = this.options;
    // A row's own address (Hermes's per-row blocks, DECISIONS §143) names the row, and the model is
    // that row's own id (or its catalogue key): Hermes names its model itself and has no turn.
    if (row && asked && !(GATEWAY_MODEL_ALIASES as readonly string[]).includes(asked)) {
      const keyed = asked.includes('/') ? source.resolveKey(grant.workspace, asked) : null;
      const model = keyed && keyed.providerId === row ? keyed.model : asked;
      const target = source.target(grant.workspace, row, model);
      return 'refusal' in target ? target : { target };
    }
    const selection = grant.redirect ?? grant.turn ?? grant.selection;
    if (!selection) {
      return {
        refusal:
          'no model is chosen for this conversation: pick one in the model picker, or set a default model in Settings → Models',
      };
    }
    if (asked && !(GATEWAY_MODEL_ALIASES as readonly string[]).includes(asked)) {
      this.options.log.debug(
        { agent: grant.agentSlug, asked },
        'gateway: the agent named a model of its own; the turn’s model serves it',
      );
    }
    const target = source.target(grant.workspace, selection.providerId, selection.model);
    return 'refusal' in target ? target : { target };
  }

  /** The ids a profile's agents may ask for: the aliases, then the catalogue keys. */
  private modelIds(grant: GatewayGrantRecord): string[] {
    return [...GATEWAY_MODEL_ALIASES, ...this.options.source.modelKeys(grant.workspace)];
  }

  private models(
    response: ServerResponse,
    wire: Wire,
    grant: GatewayGrantRecord,
    row: string | null = null,
  ): void {
    // A row's own address lists that row's models, by the ids its provider knows them by.
    const ids = row
      ? this.modelIds(grant).flatMap((id) => {
          const key = id.includes('/') ? this.options.source.resolveKey(grant.workspace, id) : null;
          return key && key.providerId === row ? [key.model] : [];
        })
      : this.modelIds(grant);
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
    route: {
      wire: Wire;
      /** CLIProxyAPI's path (query included) and the body, for the model a call goes to. */
      call(target: GatewayTarget): { path: string; body: Record<string, unknown> };
    },
    grant: GatewayGrantRecord,
    target: GatewayTarget,
    upstreams: GatewayUpstream[],
  ): Promise<void> {
    const { wire } = route;
    // A model this turn was already told is out of quota is not asked again: the agent's own
    // retries get the answer at once, or the chain's next model.
    if (grant.exhausted.has(exhaustedKey(target))) {
      const failure =
        grant.refusals.get(exhaustedKey(target)) ??
        this.quotaFailure(target, 'quota_exhausted', 'the provider said the quota is spent');
      const next = this.fallBack(grant, failure, upstreams);
      if (next) {
        await this.forward(request, response, route, grant, next, upstreams);
        return;
      }
      answerQuota(response, wire, failure);
      return;
    }
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
    const call = route.call(target);
    const payload = Buffer.from(JSON.stringify(call.body));
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: lease.port,
      method: 'POST',
      path: call.path,
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
    const onClose = () => {
      if (!response.writableFinished) upstream.destroy();
      finish();
    };
    response.on('close', onClose);
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
      if (status >= 400) {
        // An error is read whole before anything is said: a quota is answered in words the
        // agent will not retry (or the chain takes over), and no answer carries the hub's
        // internal names for its providers.
        void readBody(answer, MAX_ERROR_BYTES)
          .catch(() => Buffer.alloc(0))
          .then(async (raw) => {
            finish();
            response.off('close', onClose);
            let text = raw.toString('utf8');
            const key = exhaustedKey(target);
            // CLIProxyAPI answers Claude Code, Codex and Gemini CLI with the provider's message
            // alone, so Google's own reason (QUOTA_EXHAUSTED, MODEL_CAPACITY_EXHAUSTED, an
            // account restriction) and its retry delay are lost there. The Chat route keeps the
            // provider's whole answer: one small request on it says which it is (owner,
            // 2026-10-01: "ran out of quota" on an account signed in minutes earlier).
            const asked = `${grant.turn?.runId ?? grant.lastRunId ?? ''}\n${key}`;
            if (
              !call.path.startsWith('/v1/chat/completions') &&
              LIMIT_HINT.test(`${status} ${text}`) &&
              !/"(?:reason|details|retryDelay)"/.test(text)
            ) {
              // Once per model and turn: a second refusal is read with what the first one said.
              const known = this.probed.get(grant)?.get(asked);
              const probed = known ?? (await this.probeLimit(target, upstreams));
              if (!known && probed) {
                const seen =
                  this.probed.get(grant) ?? new Map<string, { ok: boolean; text: string }>();
                seen.set(asked, probed);
                this.probed.set(grant, seen);
              }
              if (!known && probed?.ok && !grant.waited.has(key)) {
                // It answers now: the limit has passed; ask again at once.
                grant.waited.add(key);
                if (response.destroyed || response.writableEnded) return;
                await this.forward(request, response, route, grant, target, upstreams);
                return;
              }
              if (probed && !probed.ok && probed.text) text = probed.text;
            }
            const verdict = classifyLimit(status, text, answer.headers, this.limitWait);
            if (
              verdict.kind === 'wait' &&
              verdict.ms <= this.limitWait.maxMs &&
              !grant.waited.has(key)
            ) {
              // A limit that passes (Google says RESOURCE_EXHAUSTED for a per-minute limit as
              // for a spent quota; owner, 2026-09-30), or no capacity for the model right now
              // (Antigravity, 2026-10-01): wait the provider's time once, then ask again within
              // the same turn. A second refusal ends the model's part in the turn.
              grant.waited.add(key);
              this.options.log.info(
                {
                  providerId: target.providerId,
                  model: target.model,
                  waitMs: verdict.ms,
                  reason: verdict.reason,
                },
                'gateway: the provider refuses the model for now; waiting once before asking again',
              );
              this.tellWaiting(grant, target, verdict.ms, verdict.reason);
              await new Promise((resolve) => setTimeout(resolve, verdict.ms));
              if (response.destroyed || response.writableEnded) return;
              await this.forward(request, response, route, grant, target, upstreams);
              return;
            }
            if (verdict.kind !== 'pass') {
              const failure = this.quotaFailure(
                target,
                verdict.kind === 'spent' ? 'quota_exhausted' : verdict.reason,
                providerWords(text, target),
              );
              grant.exhausted.add(exhaustedKey(target));
              grant.refusals.set(exhaustedKey(target), failure);
              this.options.log.info(
                {
                  providerId: target.providerId,
                  model: target.model,
                  status,
                  reason: failure.reason,
                },
                'gateway: the provider refuses the model for this turn',
              );
              const next = this.fallBack(grant, failure, upstreams);
              if (next) {
                await this.forward(request, response, route, grant, next, upstreams);
                return;
              }
              // Only the turn's own model ends the turn: a model an agent named itself (a
              // catalogue key) being out of quota is that call's answer alone.
              const current =
                grant.redirect ??
                (grant.turn
                  ? { providerId: grant.turn.providerId, model: grant.turn.model }
                  : null);
              if (current && exhaustedKey(current) === exhaustedKey(target)) {
                this.tellExhausted(grant, failure);
              }
              answerQuota(response, wire, failure);
              return;
            }
            const headers = answerHeaders(answer.headers);
            delete headers['content-length'];
            response.writeHead(status, headers);
            response.end(scrubInternalNames(text, target));
          });
        return;
      }
      response.writeHead(status, answerHeaders(answer.headers));
      const tap = new UsageTap(answer.headers['content-type']);
      answer.on('data', (chunk: Buffer) => {
        tap.push(chunk);
        if (!response.write(chunk)) {
          answer.pause();
          response.once('drain', () => answer.resume());
        }
      });
      answer.on('end', () => {
        response.end();
        finish();
        const used = tap.result();
        if (used && runId) this.account(grant, turn, runId, target, used);
      });
      answer.on('error', () => {
        finish();
        response.destroy();
      });
    });
    upstream.end(payload);
  }

  /**
   * One small Chat Completions request for the model, on CLIProxyAPI's Chat route, which passes
   * the provider's whole error on: `ok` when the model answers now, else the provider's answer.
   * `null` when it could not be asked.
   */
  private async probeLimit(
    target: GatewayTarget,
    upstreams: GatewayUpstream[],
  ): Promise<{ ok: boolean; text: string } | null> {
    let lease;
    try {
      lease = await this.options.cliproxy.lease(upstreams);
    } catch {
      return null;
    }
    const payload = Buffer.from(
      JSON.stringify({
        model: upstreamModel(target.providerId, target.model),
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
        stream: false,
      }),
    );
    try {
      return await new Promise((resolve) => {
        const probe = httpRequest(
          {
            host: '127.0.0.1',
            port: lease.port,
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${lease.key}`,
              'content-type': 'application/json',
              'content-length': String(payload.length),
            },
            timeout: 20_000,
          },
          (answer) => {
            void readBody(answer, MAX_ERROR_BYTES)
              .catch(() => Buffer.alloc(0))
              .then((body) =>
                resolve({ ok: (answer.statusCode ?? 500) < 400, text: body.toString('utf8') }),
              );
          },
        );
        probe.on('timeout', () => probe.destroy());
        probe.on('error', () => resolve(null));
        probe.end(payload);
      });
    } finally {
      lease.done();
    }
  }

  private quotaFailure(
    target: GatewayTarget,
    reason: GatewayLimitReason,
    said: string,
  ): GatewayQuotaFailure {
    return {
      providerId: target.providerId,
      model: target.model,
      reason,
      providerLabel: target.providerLabel ?? 'The provider',
      modelLabel: target.modelLabel,
      said,
    };
  }

  /**
   * The next model of the profile's fallback chain this turn can move on to (contract §54: a
   * rate limit is one of the failures the chain is for), or null. Only a model the gateway can
   * serve and not already out of quota this turn; the turn keeps it for its remaining calls.
   */
  private fallBack(
    grant: GatewayGrantRecord,
    failed: GatewayQuotaFailure,
    upstreams: GatewayUpstream[],
  ): GatewayTarget | null {
    const turn = grant.turn;
    if (!turn?.fallbacks?.length) return null;
    for (const member of turn.fallbacks) {
      if (grant.exhausted.has(`${member.providerId}\n${member.model}`)) continue;
      if (!upstreams.some((upstream) => upstream.providerId === member.providerId)) continue;
      const target = this.options.source.target(grant.workspace, member.providerId, member.model);
      if ('refusal' in target) continue;
      grant.redirect = { providerId: target.providerId, model: target.model };
      this.options.log.info(
        { from: failed.model, to: target.model },
        'gateway: the turn moves on down the fallback chain',
      );
      try {
        turn.fellBack?.({
          failed,
          answered: {
            providerId: target.providerId,
            model: target.model,
            modelLabel: target.modelLabel,
            providerLabel: target.providerLabel ?? 'The provider',
          },
        });
      } catch (error) {
        this.options.log.warn({ err: error }, 'gateway: the turn refused a fallback report');
      }
      return target;
    }
    return null;
  }

  private tellWaiting(
    grant: GatewayGrantRecord,
    target: GatewayTarget,
    ms: number,
    reason: Exclude<GatewayLimitReason, 'quota_exhausted'>,
  ): void {
    try {
      grant.turn?.waiting?.({
        providerLabel: target.providerLabel ?? 'The provider',
        modelLabel: target.modelLabel,
        seconds: Math.ceil(ms / 1000),
        reason,
      });
    } catch (error) {
      this.options.log.warn({ err: error }, 'gateway: the turn refused a wait report');
    }
  }

  private tellExhausted(grant: GatewayGrantRecord, failure: GatewayQuotaFailure): void {
    try {
      grant.turn?.exhausted?.(failure);
    } catch (error) {
      this.options.log.warn({ err: error }, 'gateway: the turn refused a quota report');
    }
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
        // Plain bodies on the loopback hop: an error is read (a spent quota recognised, the hub's
        // internal names taken out), which a compressed one could not be.
        'accept-encoding',
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

function readBody(request: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error(`larger than ${max} bytes`));
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

function exhaustedKey(target: { providerId: string; model: string }): string {
  return `${target.providerId}\n${target.model}`;
}

/** How long to wait for a provider's passing limit: its own word, else this; never longer. */
const LIMIT_WAIT = { defaultMs: 20_000, maxMs: 30_000 };

/**
 * Words that say a quota is spent for longer than a turn can wait, or money is. Antigravity's
 * "You have exhausted your capacity on this model. Your quota will reset after 2h10m" is the
 * account's own quota for that model (its `QUOTA_EXHAUSTED`), not the server's capacity.
 */
const SPENT =
  /insufficient[_ ]?(?:quota|balance|credits?)|exceeded your current|billing|payment|out of credits|credit balance|usage[_ ]limit|per[_ ]?day|perday|daily|per[_ ]?month|permonth|monthly|"?QUOTA_EXHAUSTED"?|quota exhausted|exhausted your capacity|quota will reset/i;
/**
 * Words that say the provider has no capacity for the model right now — nothing about the
 * account: Antigravity's `MODEL_CAPACITY_EXHAUSTED`, "No capacity available for model … on the
 * server", an overloaded model. Worth a short wait, or another model.
 */
const NO_CAPACITY =
  /MODEL_CAPACITY_EXHAUSTED|no capacity available|capacity (?:is )?(?:exceeded|unavailable)|model (?:is )?overloaded|overloaded_error|server (?:is )?(?:busy|overloaded)/i;
/**
 * Words that say a limit that passes: a quota word without a spent one ("Resource has been
 * exhausted (e.g. check quota)", a per-minute metric, `RATE_LIMIT_EXCEEDED`), or CLIProxyAPI's
 * cooling down. A plain rate limit ("slow down", `rate_limit_error` alone) is not one: the
 * agent's own retries are for it, as before.
 */
const LIMITED =
  /quota|resource[_ ]?exhausted|rate_limit_exceeded|per[_ ]?minute|model_cooldown|cooling down/i;

/** An error that may be a limit, worth asking CLIProxyAPI's Chat route what it really is. */
const LIMIT_HINT =
  /^(?:429|503|529)\b|quota|resource[_ ]?exhausted|capacity|overloaded|rate[_ ]?limit|cooling down/i;

/** How long a model with no capacity is waited for, when the provider does not say. */
const CAPACITY_WAIT_MS = 5_000;

/**
 * What a provider's error says of its limits:
 * - `spent` — the money or the account's quota for the model is gone (402, `insufficient_quota`,
 *   billing, credit, a daily/monthly quota, Antigravity's `QUOTA_EXHAUSTED` / "exhausted your
 *   capacity … quota will reset"): answered at once, no retry will get past it this turn;
 * - `wait` — refused for now, with why (`no_capacity`: the provider has no capacity for the
 *   model; `rate_limited`: a limit that passes — Google says `RESOURCE_EXHAUSTED` for a per-minute
 *   limit as for a spent quota, owner 2026-09-30) and how long to wait: the provider's
 *   `retry-after(-ms)`, Google's `RetryInfo.retryDelay`, "Please retry in …", CLIProxyAPI's
 *   `reset_seconds` — else a default;
 * - `pass` — anything else, passed on as it came.
 */
export function classifyLimit(
  status: number,
  text: string,
  headers: IncomingMessage['headers'] = {},
  wait: { defaultMs: number; maxMs: number } = LIMIT_WAIT,
):
  | { kind: 'spent' }
  | { kind: 'wait'; ms: number; reason: 'no_capacity' | 'rate_limited' }
  | { kind: 'pass' } {
  if (status === 402) return { kind: 'spent' };
  if (status !== 429 && status !== 403 && status !== 503 && status !== 529) {
    return { kind: 'pass' };
  }
  if (status !== 503 && status !== 529 && SPENT.test(text)) return { kind: 'spent' };
  const ms = retryDelayMs(text, headers);
  if (NO_CAPACITY.test(text)) {
    return {
      kind: 'wait',
      ms: ms ?? Math.min(wait.defaultMs, CAPACITY_WAIT_MS),
      reason: 'no_capacity',
    };
  }
  if (status === 503 || status === 529) return { kind: 'pass' };
  if (!LIMITED.test(text)) return { kind: 'pass' };
  if (status === 403 && !/quota|resource[_ ]?exhausted/i.test(text)) return { kind: 'pass' };
  return { kind: 'wait', ms: ms ?? wait.defaultMs, reason: 'rate_limited' };
}

/** How long the provider asks to wait, in milliseconds, or null when it does not say. */
export function retryDelayMs(
  text: string,
  headers: IncomingMessage['headers'] = {},
): number | null {
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
  };
  const ms = Number(header('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const after = header('retry-after');
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const unescaped = text.replace(/\\"/g, '"');
  const delay = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(unescaped);
  if (delay) return Number(delay[1]) * 1000;
  const retryIn = /retry in ([\d.]+)\s*(ms|s)\b/i.exec(text);
  if (retryIn) return Number(retryIn[1]) * (retryIn[2] === 'ms' ? 1 : 1000);
  const reset = /"reset_seconds"\s*:\s*(\d+)/.exec(unescaped);
  if (reset && Number(reset[1]) > 0) return Number(reset[1]) * 1000;
  return null;
}

/** `h<row id>/`: the prefix CLIProxyAPI knows a provider row by (`cliproxy-config.ts`). */
const INTERNAL_PREFIX = /\bh[0-9a-z]{26}\//g;

/**
 * An answer's text with the hub's internal names for its providers taken out: the call's own
 * model named as people know it, any other row's prefix dropped (owner, 2026-09-30: an error
 * showed `h01m3az…/gemini-3.8-flash-high`).
 */
export function scrubInternalNames(
  text: string,
  target: Pick<GatewayTarget, 'providerId' | 'model' | 'modelLabel' | 'providerLabel'>,
): string {
  const own = upstreamModel(target.providerId, target.model);
  const named = target.providerLabel
    ? `${target.providerLabel} / ${target.modelLabel}`
    : target.modelLabel;
  return text.split(own).join(named).replace(INTERNAL_PREFIX, '');
}

/** What the provider said, as one short sentence without the hub's internal names. */
function providerWords(text: string, target: GatewayTarget): string {
  let said = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    const message =
      error && typeof error === 'object'
        ? (error as { message?: unknown }).message
        : typeof error === 'string'
          ? error
          : parsed.message;
    if (typeof message === 'string' && message.trim()) said = message;
    // Google's own reason and quota names, which tell a spent quota from no capacity or an
    // account restriction.
    const details =
      error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined;
    const codes = new Set<string>();
    for (const detail of Array.isArray(details) ? details : []) {
      const entry = (detail ?? {}) as {
        reason?: unknown;
        retryDelay?: unknown;
        violations?: { quotaId?: unknown }[];
      };
      if (typeof entry.reason === 'string') codes.add(entry.reason);
      for (const violation of Array.isArray(entry.violations) ? entry.violations : []) {
        if (typeof violation?.quotaId === 'string') codes.add(violation.quotaId);
      }
      if (typeof entry.retryDelay === 'string') codes.add(`retry in ${entry.retryDelay}`);
    }
    if (codes.size > 0) said = `${said} (${[...codes].join(', ')})`;
  } catch {
    // Not JSON: its text as it came.
  }
  said = redactSecrets(scrubInternalNames(said, target)).replace(/\s+/g, ' ').trim();
  return said.length > 400 ? `${said.slice(0, 399)}…` : said || 'the provider gave no reason';
}

/** Why a provider refused a model, as a person reads it (English; the chat says it localised). */
export function limitSentence(
  failure: Pick<GatewayQuotaFailure, 'reason' | 'providerLabel' | 'modelLabel'>,
): string {
  switch (failure.reason) {
    case 'no_capacity':
      return `${failure.providerLabel} has no capacity for ${failure.modelLabel} right now`;
    case 'rate_limited':
      return `${failure.providerLabel} is limiting requests to ${failure.modelLabel} right now`;
    default:
      return `${failure.providerLabel} ran out of quota for ${failure.modelLabel}`;
  }
}

/**
 * A spent quota, in the envelope of the agent's own wire and in words it will not retry: 429 with
 * `x-should-retry: false` (Claude Code and the Anthropic and OpenAI SDKs stop there), OpenAI's
 * `insufficient_quota`, and for Gemini CLI an `ErrorInfo` it counts as a terminal quota error.
 */
function answerQuota(response: ServerResponse, wire: Wire, failure: GatewayQuotaFailure): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const message = `${limitSentence(failure)}: pick another model for this chat in Core Hub. The provider said: ${failure.said}`;
  const body =
    wire === 'anthropic'
      ? { type: 'error', error: { type: 'rate_limit_error', message } }
      : wire === 'google'
        ? {
            error: {
              code: 429,
              message,
              status: 'RESOURCE_EXHAUSTED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'MODEL_CAPACITY_EXHAUSTED',
                  domain: 'corehub.gateway',
                  metadata: { provider: failure.providerLabel, model: failure.modelLabel },
                },
              ],
            },
          }
        : {
            error: {
              message,
              type: 'insufficient_quota',
              code: 'insufficient_quota',
              param: null,
            },
          };
  response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' });
  response.end(JSON.stringify(body));
}
