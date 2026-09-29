/**
 * The MCP OAuth operations (contract decision §122): start a sign-in, read and stop it, forget
 * it, and the public callback the provider sends the browser back to. The sign-in itself is
 * Hermes's own `hermes mcp login` (`mcp-oauth.ts`); these routes find the profile's home, write
 * the redirect the browser can reach and the port Hermes listens on, and keep the hub's own id
 * for each sign-in.
 */
import { createServer } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { newUlid } from '../../db/ids.js';
import { HubError, notFound } from '../../lib/errors.js';
import { defineRoute, type RouteDeps } from '../../lib/route.js';
import { testMcpServer, type HermesApiCall, type McpTestResult } from './hermes-tools.js';
import { McpError, getMcpServer, prepareOAuthLogin, type McpServer } from './mcp.js';
import {
  McpOAuthFlows,
  awaitLogin,
  callbackPage,
  callbackUri,
  hubBaseOf,
  isHubCallback,
  relayToLogin,
  removeOAuthTokens,
  signedInIn,
  startLogin,
  stateOf,
  viewOfLogin,
  type CallbackOutcome,
  type McpLoginSpawner,
  type McpOAuthFlowRecord,
} from './mcp-oauth.js';

export interface McpOAuthRouteHelpers {
  /** The selected profile's Hermes home and name, or the reason there is none. */
  toolHome(request: FastifyRequest, agentId: string): { home: string; profile: string };
  /** Hermes's own command for the sign-in, or null where the hub does not run Hermes. */
  loginSpawner(app: FastifyInstance): McpLoginSpawner | null;
  /** Hermes's API, to list the tools once signed in; null where there is none. */
  hermesApi(app: FastifyInstance): HermesApiCall | null;
  /** How the callback reaches Hermes's listener on this host (a test's fake). */
  fetchImpl?: typeof fetch;
  /** The contract's `McpServer`, `oauth` included. */
  toMcpServer(server: McpServer, home: string): Record<string, unknown>;
  /** Keep a test's answer as the server's last test in this profile (DECISIONS §134). */
  rememberTest?(home: string, name: string, result: McpTestResult): void;
  /** The hub's own block is not signed in from here (§67). */
  refuseManaged(name: string): void;
  mcpFault(error: unknown): never;
  /** The contract's API base (`/api/v1`). */
  apiBase: string;
}

/** A port nothing on this host listens on, for Hermes's callback listener. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function registerMcpOAuthRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  helpers: McpOAuthRouteHelpers,
): void {
  const flows = new McpOAuthFlows();
  app.addHook('onClose', async () => {
    for (const record of flows.running()) record.process.kill();
  });

  const serverOf = (home: string, name: string): McpServer => {
    let server: McpServer | null;
    try {
      server = getMcpServer(home, name);
    } catch (error) {
      return helpers.mcpFault(error);
    }
    if (!server) throw notFound({ resource: 'mcp_server', id: name });
    return server;
  };

  /**
   * Once signed in, the tools Hermes then lists — asked of Hermes's own test, once, so the page
   * and the MCP screen can show the count. A test that fails leaves the list empty. Either way
   * the answer becomes the server's last test in the profile (DECISIONS §134).
   */
  const askTools = (record: McpOAuthFlowRecord): Promise<void> => {
    if (record.toolsAsked) return record.toolsAsked;
    const api = helpers.hermesApi(app);
    record.toolsAsked = (async () => {
      if (!api) return;
      try {
        const result = await testMcpServer(api, {
          profile: record.profile,
          name: record.serverName,
          config: {},
          language: 'en',
        });
        if (result.ok) record.tools = result.tools;
        helpers.rememberTest?.(record.home, record.serverName, result);
      } catch {
        // The sign-in stands; the list is only a courtesy.
      }
    })();
    return record.toolsAsked;
  };

  const answer = async (record: McpOAuthFlowRecord) => {
    let view = viewOfLogin(record);
    if (view.status === 'approved') {
      await askTools(record);
      view = viewOfLogin(record);
    }
    return {
      id: record.id,
      server_name: record.serverName,
      status: view.status,
      authorization_url: view.authorization_url,
      redirect_uri: record.redirectUri,
      error: view.error,
      tools: view.tools,
      expires_at: flows.expiresAt(record),
    };
  };

  /** The flow this request names, in this agent, profile and server; `404` otherwise. */
  const recordOf = (request: FastifyRequest, params: Record<string, unknown>) => {
    const agentId = params.agent_id as string;
    const name = params.server_name as string;
    const { profile } = helpers.toolHome(request, agentId);
    const record = flows.get(params.flow_id as string, agentId, profile, name);
    if (!record) throw notFound({ resource: 'mcp_oauth_flow', id: params.flow_id as string });
    return record;
  };

  defineRoute(app, deps, {
    operationId: 'agents.startMcpOAuth',
    handler: async (request, { params, body }) => {
      const agentId = params.agent_id as string;
      const name = params.server_name as string;
      helpers.refuseManaged(name);
      const { home, profile } = helpers.toolHome(request, agentId);
      const spawner = helpers.loginSpawner(request.server);
      if (!spawner) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_not_supervised' },
        });
      }
      const server = serverOf(home, name);
      if (server.transport === 'stdio') {
        throw new HubError('conflict', { details: { reason: 'mcp_oauth_stdio', name } });
      }
      const input = (body ?? {}) as { hub_url?: string };
      const base = hubBaseOf(input.hub_url, `${request.protocol}://${request.host}`);
      const port = await freePort();
      let redirectUri: string;
      try {
        redirectUri = prepareOAuthLogin(
          home,
          name,
          callbackUri(base, helpers.apiBase, name),
          port,
          (current) => isHubCallback(current, helpers.apiBase, name),
        );
      } catch (error) {
        if (error instanceof McpError) return helpers.mcpFault(error);
        throw error;
      }
      const started = await startLogin(spawner, home, name);
      const record: McpOAuthFlowRecord = {
        id: newUlid(),
        agentId,
        profile,
        home,
        serverName: name,
        port,
        redirectUri,
        createdAt: Date.now(),
        state: stateOf(started.authorizationUrl),
        authorizationUrl: started.authorizationUrl,
        process: started.process,
        cancelled: false,
        tools: [],
        toolsAsked: null,
      };
      flows.add(record);
      return answer(record);
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.getMcpOAuthFlow',
    handler: async (request, { params }) => answer(recordOf(request, params)),
  });

  defineRoute(app, deps, {
    operationId: 'agents.cancelMcpOAuthFlow',
    handler: async (request, { params }) => {
      const record = recordOf(request, params);
      if (record.process.running()) {
        record.cancelled = true;
        record.process.kill();
        await record.process.exited;
      }
      return answer(record);
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.disconnectMcpOAuth',
    handler: (request, { params }) => {
      const agentId = params.agent_id as string;
      const name = params.server_name as string;
      helpers.refuseManaged(name);
      const { home } = helpers.toolHome(request, agentId);
      const server = serverOf(home, name);
      removeOAuthTokens(home, name);
      return helpers.toMcpServer(server, home);
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.mcpOAuthCallback',
    // The query is the provider's authorization code: the request's own log lines, which
    // carry the URL, are not written for this route (`logLevel` in `defineRoute`).
    logLevel: 'warn',
    handler: async (request, { params }, reply) => {
      const name = params.server_name as string;
      const url = request.raw.url ?? '';
      const at = url.indexOf('?');
      const query = at === -1 ? '' : url.slice(at + 1);
      const search = new URLSearchParams(query);
      const record = flows.byState(name, search.get('state'));
      let outcome: CallbackOutcome;
      let detail: { tools?: number; error?: string | null } = {};
      if (!record || !record.process.running()) {
        // A sign-in this hub no longer waits for: ended, cancelled, already used, or unknown.
        outcome = 'expired';
      } else if (!(await relayToLogin(record, query, helpers.fetchImpl))) {
        outcome = 'expired';
      } else {
        // The code reached Hermes; the page speaks once Hermes says how the exchange ended.
        await awaitLogin(record);
        const view = viewOfLogin(record);
        if (search.has('error') && view.status !== 'approved') outcome = 'declined';
        else if (view.status === 'pending') outcome = 'pending';
        else if (view.status === 'approved') {
          await askTools(record);
          outcome = 'connected';
          detail = {
            tools: record.tools.length || signedInIn(record.process.output())?.tools || 0,
          };
        } else if (view.status === 'failed') {
          outcome = 'failed';
          detail = { error: view.error };
        } else outcome = 'expired';
      }
      void reply
        .status(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(callbackPage(outcome, name, request.language, detail));
      return reply;
    },
  });
}
