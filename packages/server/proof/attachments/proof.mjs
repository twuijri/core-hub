/**
 * The container proof, driven from the host over HTTP:
 *
 *   sign in -> upload a file -> open a session -> send a turn carrying the file
 *           -> the agent reads it from the working directory and writes a file back
 *           -> the reply carries the produced file -> download it.
 *
 * Nothing here reaches into the container: every step is an operation of the contract.
 */
const base = process.argv[2];
const password = process.argv[3];

const say = (...parts) => console.log(...parts);

async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const init = {
    method,
    headers: {
      accept: 'application/json',
      'x-hub-profile': 'default',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}/api/v1${path}`, init);
  if (raw)
    return {
      status: response.status,
      headers: response.headers,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

const health = await call('GET', '/health');
say('health', health.status, JSON.stringify(health.data));

const login = await call('POST', '/auth/login', { body: { username: 'admin', password } });
say('login', login.status);
const token = login.data.access_token;

const agents = await call('GET', '/agents', { token });
const hermes = agents.data.items.find((agent) => agent.kind === 'hermes');
say('hermes agent', JSON.stringify({ status: hermes.status, runtime: hermes.runtime }));

// 1. upload — multipart, the client's filename deliberately hostile and its type a lie.
const csv = 'id,total\n1,42\n2,17\n';
const form = new FormData();
form.append('file', new Blob([csv]), '../../order.csv');
form.append('purpose', 'message');
const uploaded = await call('POST', '/attachments', { token, body: form });
say('upload', uploaded.status, JSON.stringify(uploaded.data));

// 2. a session, then a turn that carries the file.
const session = await call('POST', '/sessions', {
  token,
  body: { agent_id: hermes.id, title: 'files' },
});
say('session', session.status, session.data.id, 'working_dir', session.data.working_dir);

const accepted = await call('POST', `/sessions/${session.data.id}/runs`, {
  token,
  body: {
    content: [
      { type: 'text', text: 'read the attached file and write a summary' },
      { type: 'file', attachment_id: uploaded.data.id },
    ],
  },
});
say('run accepted', accepted.status, JSON.stringify(accepted.data));

// 3. wait for the job the run is executed as (invariant 4).
let job;
for (let attempt = 0; attempt < 300; attempt += 1) {
  job = await call('GET', `/jobs/${accepted.data.job_id}`, { token });
  if (['succeeded', 'failed', 'cancelled'].includes(job.data.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
say('run job', job.data.status);

const run = await call('GET', `/sessions/${session.data.id}/runs/${accepted.data.run_id}`, {
  token,
});
say(
  'run',
  JSON.stringify({ status: run.data.status, error: run.data.error, usage: run.data.usage }),
);

// 4. the transcript: what the agent said, and what it handed back.
const messages = await call('GET', `/sessions/${session.data.id}/messages`, { token });
for (const message of messages.data.items) {
  say(
    'message',
    JSON.stringify({
      role: message.role,
      status: message.status,
      content: message.content.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : {
              type: block.type,
              name: block.name,
              mime: block.mime,
              size_bytes: block.size_bytes,
              url: block.url,
            },
      ),
    }),
  );
}

const reply = messages.data.items.at(-1);
const produced = reply.content.find((block) => block.type === 'file' || block.type === 'image');
if (!produced) {
  say('FAIL no produced file on the reply');
  process.exit(1);
}

// 5. download the produced file, with the bearer in the header as the contract says.
const bytes = await call('GET', `/attachments/${produced.attachment_id}/content`, {
  token,
  raw: true,
});
say(
  'download',
  bytes.status,
  JSON.stringify({
    'content-type': bytes.headers.get('content-type'),
    'content-disposition': bytes.headers.get('content-disposition'),
    'content-length': bytes.headers.get('content-length'),
  }),
);
say('--- produced file ---');
say(bytes.bytes.toString('utf8'));

// 6. a range request, and the refusal to delete a file the conversation uses.
const ranged = await call('GET', `/attachments/${produced.attachment_id}/content`, {
  token,
  raw: true,
  headers: { range: 'bytes=0-8' },
});
say(
  'range',
  ranged.status,
  JSON.stringify(ranged.headers.get('content-range')),
  JSON.stringify(ranged.bytes.toString('utf8')),
);

const refused = await call('DELETE', `/attachments/${uploaded.data.id}`, { token });
say('delete a file a message uses', refused.status, JSON.stringify(refused.data));

// 7. a file nobody sent can be deleted.
const spare = new FormData();
spare.append('file', new Blob(['scratch']), 'scratch.txt');
const temporary = await call('POST', '/attachments', { token, body: spare });
const removed = await call('DELETE', `/attachments/${temporary.data.id}`, { token });
say('delete an unused file', removed.status);

// 8. the resumable flow, over the same API.
const big = Buffer.alloc(600 * 1024, 7);
const started = await call('POST', '/attachment-uploads', {
  token,
  body: { name: 'blob.bin', mime: 'application/octet-stream', size_bytes: big.length },
});
say('upload start', started.status, JSON.stringify(started.data));
let offset = started.data.next_offset;
while (offset < big.length) {
  const end = Math.min(offset + started.data.chunk_bytes, big.length);
  const chunk = await fetch(
    `${base}/api/v1/attachment-uploads/${started.data.id}?offset=${offset}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-hub-profile': 'default',
        'content-type': 'application/octet-stream',
      },
      body: big.subarray(offset, end),
    },
  );
  const next = await chunk.json();
  say('chunk', chunk.status, JSON.stringify(next));
  offset = next.next_offset;
}
const completed = await call('POST', `/attachment-uploads/${started.data.id}/complete`, { token });
say('upload complete', completed.status, JSON.stringify(completed.data));
const bigBack = await call('GET', `/attachments/${completed.data.id}/content`, {
  token,
  raw: true,
});
say('resumable bytes match', bigBack.bytes.equals(big));
