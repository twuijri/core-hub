#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible endpoint, used by `prove.sh` to show what actually reaches an
 * upstream provider from inside the container. It is deliberately dumb: it inspects the
 * `Authorization` header, answers 401 **in its own words** when the key is not the one it
 * accepts, and appends one line per request to a log the proof script prints verbatim.
 *
 * It is not a mock of any real provider. Its model ids carry a vendor prefix and a `:free`
 * suffix on purpose — the hub must write them through byte for byte.
 *
 *   node fake-provider.mjs --port 19099 --key sk-lab-correct-key --log /tmp/requests.txt
 *
 * `POST /__control {"rejecting":true}` makes it refuse the key it had been accepting, which is
 * what a revoked key looks like from the hub's side.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const port = Number(arg('port', '19099'));
const acceptedKey = arg('key', 'sk-lab-correct-key');
const logFile = arg('log', '');

let rejecting = false;

/** Opaque ids: a vendor prefix, and a `:free` suffix that is part of the name, not a flag. */
const MODELS = ['lab/tiny-1:free', 'lab/tiny-2'];

const note = (line) => {
  process.stdout.write(`${line}\n`);
  if (logFile) appendFileSync(logFile, `${line}\n`);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
};

const server = createServer(async (req, res) => {
  const raw = await readBody(req);
  const auth = req.headers.authorization ?? null;
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/__control') {
    rejecting = JSON.parse(raw || '{}').rejecting === true;
    send(res, 200, { rejecting });
    return;
  }

  let model = null;
  if (raw) {
    try {
      model = JSON.parse(raw).model ?? null;
    } catch {
      model = null;
    }
  }
  note(`${req.method} ${url.pathname}  authorization=${auth ? `'${auth}'` : 'None'}`);
  if (model !== null || req.method === 'POST') note(`   model= ${model}`);

  // The whole point of the harness: the decision is made on the header that arrived.
  const ok = auth === `Bearer ${acceptedKey}` && !rejecting;
  if (!ok) {
    send(res, 401, { error: { message: 'lab: bad or missing api key', type: 'invalid_request' } });
    return;
  }

  if (url.pathname === '/v1/models') {
    send(res, 200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'lab' })),
    });
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    let streaming;
    try {
      streaming = JSON.parse(raw || '{}').stream === true;
    } catch {
      streaming = false;
    }
    const answer = 'the lab endpoint answered';

    // Hermes asks for a stream. A plain JSON body here reads to it as "empty stream with no
    // finish_reason", which would make this harness prove a bug of its own rather than the
    // product's behaviour.
    if (streaming) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const frame = (delta, finish) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-lab-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model ?? MODELS[0],
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(frame({ role: 'assistant', content: '' }, null));
      res.write(frame({ content: answer }, null));
      res.write(frame({}, 'stop'));
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-lab-1',
          object: 'chat.completion.chunk',
          model: model ?? MODELS[0],
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }

    send(res, 200, {
      id: 'chatcmpl-lab-1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model ?? MODELS[0],
      choices: [
        { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    });
    return;
  }

  send(res, 404, { error: { message: `lab: no route ${url.pathname}` } });
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`fake-provider listening on ${port}, accepting ${acceptedKey}\n`);
});
