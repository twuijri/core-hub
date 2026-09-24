#!/usr/bin/env node
// A tiny MCP server over stdio, for the real-Hermes test of `agents.testMcpServer`.
//
// It speaks just enough of the protocol for a client to connect and list tools: newline-
// delimited JSON-RPC 2.0 on stdin/stdout, `initialize`, the `initialized` notification,
// `tools/list` and `ping`. Everything else is "method not found". No dependencies, so it
// runs with the `node` the image already has.
//
// `MCP_FIXTURE_FAIL=1` makes it exit before answering, so the failure path is testable
// against the same file.
import { createInterface } from 'node:readline';

if (process.env.MCP_FIXTURE_FAIL === '1') {
  process.stderr.write('fixture: refusing to start (MCP_FIXTURE_FAIL=1)\n');
  process.exit(3);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Repeat the text it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // a notification: nothing to answer
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'corehub-fixture', version: '1.0.0' },
        },
      });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
