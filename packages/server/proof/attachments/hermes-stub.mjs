/**
 * A scripted Hermes gateway, for the container proof of the attachment path.
 *
 * It speaks the same surface the hub's `hermes` adapter drives (ADR 0008 §1):
 *
 *   GET  /health                   unauthenticated
 *   POST /v1/runs                  202 { run_id }
 *   GET  /v1/runs/{id}/events      SSE, one JSON object per frame
 *
 * and it behaves like an agent that can use files: it reads the attachment path out of
 * the prompt, opens the file, and writes its answer into the output folder the prompt
 * names. Everything else in the proof — the image, the hub, the multipart upload, the
 * blob store, the run engine, the download — is the real thing. Only the model is
 * scripted, because a real one needs a provider key the hub does not have here.
 *
 * NOT part of the product: this file lives in the proof scratch directory and is
 * mounted into the container for the run.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const runs = new Map();

function answer(input) {
  // "- order.csv (text/csv; charset=utf-8, 21 bytes) — /data/.../in/order.csv"
  const attachment = /^- .*? — (\/\S+)$/m.exec(input);
  const outputDir = /Write any file the user should be able to download into: (\/\S+)$/m.exec(
    input,
  );
  const lines = [];
  let produced = null;

  if (attachment) {
    const file = attachment[1];
    const text = readFileSync(file, 'utf8');
    const rows = text.trim().split('\n');
    lines.push(`read ${path.basename(file)}: ${rows.length} line(s), ${text.length} bytes`);
    lines.push(`first line: ${rows[0]}`);
    if (outputDir) {
      mkdirSync(outputDir[1], { recursive: true });
      produced = path.join(outputDir[1], 'summary.md');
      writeFileSync(
        produced,
        `# summary\n\nsource: ${path.basename(file)}\nlines: ${rows.length}\nsha-ish: ${text.length}\n`,
      );
      lines.push(`wrote ${path.basename(produced)}`);
    }
  } else {
    lines.push('no attachment in this turn');
  }
  return { text: lines.join('\n'), produced };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', platform: 'hermes-stub', version: '0.0.0' }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/runs') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const parsed = JSON.parse(body);
      const runId = `run_${Math.random().toString(16).slice(2)}`;
      let outcome;
      try {
        outcome = answer(String(parsed.input ?? ''));
      } catch (error) {
        outcome = { text: `stub failed: ${error.message}`, produced: null };
      }
      runs.set(runId, { sessionId: parsed.session_id, ...outcome, input: parsed.input });
      console.log(`[stub] run ${runId} session=${parsed.session_id}`);
      console.log(`[stub] input:\n${parsed.input}`);
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ run_id: runId, status: 'started' }));
    });
    return;
  }

  const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method === 'GET' && events) {
    const run = runs.get(events[1]);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const frame = (object) => response.write(`data: ${JSON.stringify(object)}\n\n`);
    frame({ event: 'run.started', run_id: events[1] });
    for (const piece of (run?.text ?? 'unknown run').match(/.{1,24}/gs) ?? []) {
      frame({ event: 'message.delta', delta: piece });
    }
    frame({
      event: 'run.completed',
      run_id: events[1],
      session_id: run?.sessionId,
      output: run?.text ?? '',
      usage: { input_tokens: 11, output_tokens: 7 },
      runtime: { model: 'hermes-stub', provider: 'stub' },
    });
    response.end();
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(8642, '127.0.0.1', () => console.log('[stub] hermes gateway on 127.0.0.1:8642'));
