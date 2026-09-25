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
 *
 * `--script images` (`prove-images.sh`, decision §72) also serves pictures, in the two shapes the
 * hub's image backend speaks: OpenAI's Images API (`/v1/images/generations`, `/v1/images/edits`,
 * for `gpt-image-1`) and a chat model that draws (`gemini-3.1-flash-image` on
 * `/v1/chat/completions`, the picture in `message.images` as cli-proxy-api and OpenRouter return
 * it). Its chat model asks for Hermes's `image_generate` tool once, then answers.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const port = Number(arg('port', '19099'));
const acceptedKey = arg('key', 'sk-lab-correct-key');
const logFile = arg('log', '');
/**
 * `--script rooms` (`prove-rooms.sh`): answer as the seat the prompt addresses, so a real
 * Hermes in a room passes the turn and a summary comes back. Otherwise one fixed answer.
 */
const script = arg('script', '');

/** The words of the last user message of a chat request. */
function lastUser(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((part) => part?.text ?? '').join('');
  }
  return '';
}

function answerFor(body) {
  if (script !== 'rooms') return 'the lab endpoint answered';
  const asked = lastUser(body);
  if (asked.includes('Update the running summary')) {
    return 'ملخّص: المخطِّط وضع الخطة، والمبرمج أنهى الخطوة الأولى.';
  }
  if (asked.includes('You are @المخطِّط,'))
    return 'الخطة: نبدأ بالواجهة. @المبرمج ابدأ بالخطوة الأولى.';
  if (asked.includes('You are @المبرمج,')) return 'أنهيت الخطوة الأولى: الواجهة جاهزة.';
  return 'حاضر.';
}

let rejecting = false;

/** Opaque ids: a vendor prefix, and a `:free` suffix that is part of the name, not a flag. */
const MODELS =
  script === 'images'
    ? ['lab/tiny-1:free', 'gpt-image-1', 'gemini-3.1-flash-image']
    : ['lab/tiny-1:free', 'lab/tiny-2'];

// ---------------------------------------------------------------- pictures (`--script images`)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
/**
 * A 32×32 PNG: a red square in the middle of a flat background — pure green (`#00FF00`, the
 * flat colour `image-edit remove-bg` asks a chat model for) or, with `alpha`, fully transparent
 * (what a gpt-image model sends for `background: transparent`).
 */
function png({ alpha = false } = {}) {
  const size = 32;
  const channels = alpha ? 4 : 3;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * channels);
    for (let x = 0; x < size; x += 1) {
      const inside = x >= 8 && x < 24 && y >= 8 && y < 24;
      const pixel = inside ? [220, 30, 30, 255] : alpha ? [0, 0, 0, 0] : [0, 255, 0];
      pixel.slice(0, channels).forEach((value, i) => (row[1 + x * channels + i] = value));
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The prompt text of a chat request's last user message, image parts named. */
const userParts = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  if (!last) return { text: '', images: 0 };
  if (typeof last.content === 'string') return { text: last.content, images: 0 };
  const parts = Array.isArray(last.content) ? last.content : [];
  return {
    text: parts.map((part) => part?.text ?? '').join(''),
    images: parts.filter((part) => part?.type === 'image_url').length,
  };
};

/**
 * The chat model's side of a Hermes turn: ask for `image_generate` while the tool has not
 * answered, then say what it answered. Hermes defers `image_generate` behind its tool-search
 * bridge by default (`tools/tool_search.py`, `_DEFAULT_DEFERRED_TOOLS`): it is then named in
 * `tool_search`'s listing — only while its backend is available — and called through
 * `tool_call`, as a real model would once it sees the name. Anything without the tool (a title,
 * a summary) gets plain words.
 */
function imagesTurn(body) {
  const tools = body.tools ?? [];
  const names = tools.map((tool) => tool?.function?.name ?? '');
  const listing = tools.find((tool) => tool?.function?.name === 'tool_search')?.function
    ?.description;
  const deferred = typeof listing === 'string' && listing.includes('image_generate');
  note(
    `   tools offered= ${names.length} image_generate=${names.includes('image_generate')} ` +
      `deferred image_generate=${deferred}`,
  );
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolAnswer = [...messages].reverse().find((m) => m?.role === 'tool');
  if (toolAnswer) {
    const said =
      typeof toolAnswer.content === 'string'
        ? toolAnswer.content
        : JSON.stringify(toolAnswer.content ?? '');
    note(`   tool answered= ${said.slice(0, 400)}`);
    return { text: 'Here is the red fox you asked for.' };
  }
  const drawing = { prompt: 'a red fox in flat style', aspect_ratio: 'square' };
  if (names.includes('image_generate')) {
    return { call: { name: 'image_generate', arguments: drawing } };
  }
  if (deferred && names.includes('tool_call')) {
    return {
      call: {
        name: 'tool_call',
        arguments: { calls: [{ name: 'image_generate', arguments: drawing }] },
      },
    };
  }
  return { text: 'the lab endpoint answered' };
}

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

  if (script === 'images' && url.pathname.startsWith('/v1/images/')) {
    // `/generations` is JSON; `/edits` is multipart, where the form fields are read as text.
    const transparent = /"background":\s*"transparent"|name="background"\r\n\r\ntransparent/.test(
      raw,
    );
    const sources = (raw.match(/name="image(\[\])?"; filename=/g) ?? []).length;
    note(`   images api= ${url.pathname} sources=${sources} transparent=${transparent}`);
    send(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: png({ alpha: transparent }).toString('base64') }],
    });
    return;
  }

  if (script === 'images' && url.pathname === '/v1/chat/completions' && /image/.test(model ?? '')) {
    // A chat model that draws, answered the way cli-proxy-api answers for gemini-*-image.
    const body = JSON.parse(raw || '{}');
    const asked = userParts(body);
    note(
      `   drawing chat= modalities=${JSON.stringify(body.modalities)} sources=${asked.images} ` +
        `asked=${JSON.stringify(asked.text.slice(0, 80))}`,
    );
    send(res, 200, {
      id: 'chatcmpl-lab-image',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Here is the picture.',
            images: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${png().toString('base64')}` },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    });
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    let streaming;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
      streaming = body.stream === true;
    } catch {
      streaming = false;
    }
    const turn = script === 'images' ? imagesTurn(body) : { text: answerFor(body) };
    const answer = turn.text ?? '';
    const toolCalls = turn.call
      ? [
          {
            id: `call_lab_${Date.now()}`,
            type: 'function',
            function: { name: turn.call.name, arguments: JSON.stringify(turn.call.arguments) },
          },
        ]
      : null;
    if (toolCalls) note(`   asked for tool= ${turn.call.name}`);
    if (script === 'rooms') note(`   asked= ${JSON.stringify(lastUser(body).slice(0, 160))}`);

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
      if (toolCalls) {
        res.write(
          frame(
            {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls.map((entry, index) => ({ index, ...entry })),
            },
            null,
          ),
        );
        res.write(frame({}, 'tool_calls'));
      } else {
        res.write(frame({ role: 'assistant', content: '' }, null));
        res.write(frame({ content: answer }, null));
        res.write(frame({}, 'stop'));
      }
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
        toolCalls
          ? {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: toolCalls },
              finish_reason: 'tool_calls',
            }
          : { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
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
