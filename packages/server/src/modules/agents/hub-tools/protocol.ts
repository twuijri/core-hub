/**
 * The part of MCP the hub's server speaks (contract decision §47): JSON-RPC 2.0 over
 * Streamable HTTP, one message per POST, answered as `application/json` — which the MCP
 * transport allows a server to do instead of a stream when it has nothing to push. No
 * session id, no server-to-client stream: the hub sends no notifications, and every call
 * stands on its own (the bearer says which profile; the live run says for whom).
 *
 * This file is only the protocol. What a tool does, and as whom, is the caller's
 * (`service.ts`); a test can drive every branch here with two plain functions.
 */

/** The versions this server answers `initialize` with; the client's own when we know it. */
export const MCP_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const;
const LATEST = MCP_VERSIONS[MCP_VERSIONS.length - 1]!;

export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

export interface McpHandlers {
  serverName: string;
  serverVersion: string;
  instructions: string;
  listTools(): McpToolListing[];
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

type Id = string | number | null;

export interface RpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function failure(id: Id, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * One JSON-RPC message in, its answer out — or `null` for a notification or a response,
 * which the transport acknowledges with `202` and no body.
 */
export async function handleRpc(
  message: unknown,
  handlers: McpHandlers,
): Promise<RpcResponse | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return failure(null, INVALID_REQUEST, 'one JSON-RPC message per request');
  }
  const rpc = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (rpc.jsonrpc !== '2.0') return failure(null, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  const hasId = 'id' in rpc && rpc.id !== undefined;
  const id: Id =
    typeof rpc.id === 'string' || typeof rpc.id === 'number'
      ? rpc.id
      : rpc.id === null
        ? null
        : null;
  if (typeof rpc.method !== 'string') {
    // A response to something we asked (we never ask) or a malformed message.
    return hasId && ('result' in rpc || 'error' in rpc)
      ? null
      : failure(id, INVALID_REQUEST, 'method is required');
  }
  if (!hasId) return null; // a notification: `notifications/initialized`, a cancel, …
  const params = (rpc.params && typeof rpc.params === 'object' ? rpc.params : {}) as Record<
    string,
    unknown
  >;

  switch (rpc.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: handlers.serverName, version: handlers.serverVersion },
          instructions: handlers.instructions,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: handlers.listTools() } };
    case 'tools/call': {
      if (typeof params.name !== 'string') return failure(id, INVALID_PARAMS, 'name is required');
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const result = await handlers.callTool(params.name, args);
      return { jsonrpc: '2.0', id, result: result as unknown as Record<string, unknown> };
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `method not found: ${rpc.method}`);
  }
}

export function parseError(): RpcResponse {
  return failure(null, PARSE_ERROR, 'the body is not JSON');
}
