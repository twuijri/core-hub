#!/usr/bin/env node
/**
 * A stand-in for DaVinci Resolve's AI integration, for tests (ADR 0025): an MCP server over
 * stdio with the tools such an integration typically offers — create a project, import media
 * into the media pool, build a timeline from it, and render — and a render that takes a while
 * and reports progress. It writes a small MP4 where it is told to, and knows nothing of Core Hub.
 *
 * `RESOLVE_MCP_KEY` must be set (the setting its manifest asks for), or every tool refuses.
 * `FAKE_RENDER_MS` is how long a render takes (1500 ms by default).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const RENDER_MS = Number(process.env.FAKE_RENDER_MS ?? 1500);
const state = { project: null, media: [], timeline: null, renders: new Map() };

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: 'text', text: value }], isError: false });
const fail = (value) => ({ content: [{ type: 'text', text: value }], isError: true });

/** An MP4's first box (`ftyp`, brand isom) and an empty `free` box: enough to be a video file. */
function mp4Bytes() {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from('isomiso2'),
  ]);
  const free = Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('free'), Buffer.alloc(8)]);
  return Buffer.concat([ftyp, free, Buffer.alloc(2048, 0x2a)]);
}

const tools = [
  {
    name: 'create_project',
    description: 'Create a new Resolve project and open it.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
  {
    name: 'import_media',
    description: 'Import files into the media pool of the open project.',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: { paths: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'create_timeline',
    description: 'Create a timeline from every clip in the media pool.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
  {
    name: 'render',
    description: 'Render the current timeline to an MP4 file and wait until it is written.',
    inputSchema: {
      type: 'object',
      required: ['output_dir', 'file_name'],
      properties: { output_dir: { type: 'string' }, file_name: { type: 'string' } },
    },
  },
  {
    name: 'get_render_status',
    description: 'Status of the last render.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function call(name, args, progressToken) {
  if (!process.env.RESOLVE_MCP_KEY) return fail('RESOLVE_MCP_KEY is not set');
  switch (name) {
    case 'create_project':
      state.project = String(args.name ?? 'Untitled');
      state.media = [];
      state.timeline = null;
      return text(`Created project "${state.project}".`);
    case 'import_media': {
      if (!state.project) return fail('No project is open.');
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const missing = paths.filter((p) => !existsSync(p));
      if (missing.length > 0) return fail(`Not found: ${missing.join(', ')}`);
      state.media.push(...paths);
      return text(`Imported ${paths.length} clip(s) into the media pool.`);
    }
    case 'create_timeline':
      if (state.media.length === 0) return fail('The media pool is empty.');
      state.timeline = { name: String(args.name ?? 'Timeline 1'), clips: state.media.length };
      return text(`Created timeline "${state.timeline.name}" with ${state.timeline.clips} clip(s).`);
    case 'render': {
      if (!state.timeline) return fail('There is no timeline to render.');
      const out = path.join(String(args.output_dir), String(args.file_name));
      const steps = 5;
      for (let i = 1; i <= steps; i += 1) {
        await new Promise((r) => setTimeout(r, RENDER_MS / steps));
        if (progressToken !== undefined)
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: i * 20, total: 100, message: `Rendering ${i * 20}%` },
          });
      }
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, mp4Bytes());
      state.renders.set('last', { status: 'complete', file: out });
      return text(`Rendered ${out}`);
    }
    case 'get_render_status':
      return text(JSON.stringify(state.renders.get('last') ?? { status: 'none' }));
    default:
      return fail(`Unknown tool ${name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'initialize')
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-davinci-resolve', version: '0.0.1' },
      },
    });
  if (id === undefined) return; // a notification
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') {
    void call(params.name, params.arguments ?? {}, params._meta?.progressToken).then((result) =>
      send({ jsonrpc: '2.0', id, result }),
    );
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
rl.on('close', () => process.exit(0));
