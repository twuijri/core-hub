#!/usr/bin/env node
// The image is sealed (docs/changes/2026-09-23-twuijri-sealed-image.md): the hub's code in
// /app and Hermes's in /opt/hermes are read-only to the user the hub runs as, and Hermes still
// works — its commands run, and a feature that needs an optional package still gets it, in
// /data, where it survives the container being recreated. Hermes's dashboard API, which the hub
// starts on demand (ADR 0015), starts against the sealed code and keeps its token.
//
//   node scripts/image-sealed-check.mjs <image>        (CI: core-hub:ci)
//
// Needs Docker, and the network for the one optional package it installs (edge-tts, Hermes's
// default voice). Leaves nothing behind: its containers and volume are removed at the end.
import { execFileSync } from 'node:child_process';

const image = process.argv[2];
if (!image) {
  console.error('usage: node scripts/image-sealed-check.mjs <image>');
  process.exit(2);
}

const tag = `sealed-check-${process.pid}`;
const volume = `${tag}-data`;
const failures = [];

function docker(args, { allowFail = false } = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`docker ${args.join(' ')}\n${error.stderr ?? error.message}`, { cause: error });
  }
}

/** Run a shell line in a container as the hub's own user (the image's default user). */
const run = (container, line, opts) => docker(['exec', container, 'sh', '-c', line], opts);

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function start(name) {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-v',
    `${volume}:/data`,
    '-e',
    'HUB_ADMIN_PASSWORD=sealed-check-only',
    image,
  ]);
  const probe =
    'node -e "fetch(\'http://127.0.0.1:8080/api/v1/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"';
  for (let i = 0; i < 60; i += 1) {
    if (run(name, probe, { allowFail: true }) !== null) return;
    execFileSync('sleep', ['1']);
  }
  throw new Error(
    `${name} never answered /api/v1/health:\n${docker(['logs', name], { allowFail: true })}`,
  );
}

/**
 * Runs inside the container: start `hermes serve` with a fresh token, time it to Hermes's
 * ready line, call it without and with the token, read its resident memory, stop it. Prints
 * one JSON line.
 */
const DASHBOARD_PROBE = `
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const token = randomBytes(32).toString('hex');
const began = Date.now();
const child = spawn('hermes', ['serve', '--host', '127.0.0.1', '--port', '0'], {
  env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token, PYTHONUNBUFFERED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const port = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 120000);
  child.stdout.on('data', (chunk) => {
    out += chunk;
    const ready = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\\d+)/.exec(out);
    if (ready) { clearTimeout(timer); resolve(Number(ready[1])); }
  });
  child.on('exit', () => { clearTimeout(timer); resolve(null); });
});
const readyMs = Date.now() - began;
const result = { port, readyMs };
if (port) {
  const url = 'http://127.0.0.1:' + port + '/api/plugins/kanban/board';
  result.bare = (await fetch(url)).status;
  result.withToken = (await fetch(url, { headers: { 'X-Hermes-Session-Token': token } })).status;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const status = readFileSync('/proc/' + child.pid + '/status', 'utf8');
  result.rssMiB = Math.round(Number(/VmRSS:\\s+(\\d+)/.exec(status)[1]) / 1024);
}
child.kill('SIGTERM');
await new Promise((resolve) => child.on('exit', resolve));
console.log(JSON.stringify(result));
`;

const first = `${tag}-a`;
const second = `${tag}-b`;
try {
  start(first);
  check('the hub answers /api/v1/health', true);

  const writable = run(first, 'find /app /opt/hermes -writable -print 2>/dev/null | head -5');
  check('nothing under /app or /opt/hermes is writable by the hub', writable === '', writable);

  const patched = run(first, 'echo x >> /opt/hermes/src/tui_gateway/server.py', {
    allowFail: true,
  });
  check("Hermes's own code cannot be edited", patched === null);
  const hubPatched = run(first, 'echo x >> /app/packages/server/dist/main.js', { allowFail: true });
  check("the hub's own code cannot be edited", hubPatched === null);

  const version = run(first, 'hermes --version', { allowFail: true });
  check('hermes runs', Boolean(version), version?.split('\n')[0] ?? '');
  const created = run(
    first,
    'hermes profile create sealed-check --no-alias >/dev/null && hermes profile list',
    {
      allowFail: true,
    },
  );
  check('hermes writes a profile to its home in /data', Boolean(created?.includes('sealed-check')));

  const installed = run(
    first,
    'python -c "from tools import lazy_deps; lazy_deps.ensure(\'tts.edge\', prompt=False); import edge_tts; print(edge_tts.__file__)"',
    { allowFail: true },
  );
  check(
    'an optional package Hermes needs lands in /data/hermes-packages',
    Boolean(installed?.startsWith('/data/hermes-packages/')),
    installed ?? 'install failed',
  );

  // Hermes's dashboard API (ADR 0015): the hub runs `hermes serve` on demand, as the hub's
  // user, against the sealed code. It must start, refuse a call without the token and answer
  // one with it. The script runs inside the container with node, as argv — no shell.
  const served = docker(['exec', first, 'node', '--input-type=module', '-e', DASHBOARD_PROBE], {
    allowFail: true,
  });
  let probe = null;
  try {
    probe = served ? JSON.parse(served.split('\n').at(-1)) : null;
  } catch {
    probe = null;
  }
  check(
    "Hermes's dashboard API starts in the sealed image",
    Boolean(probe?.port),
    probe ? `ready in ${probe.readyMs} ms, ${probe.rssMiB} MiB resident` : (served ?? 'no answer'),
  );
  check('it refuses a call without the token (401)', probe?.bare === 401, String(probe?.bare));
  check(
    'it answers /api/plugins/kanban/board with the token (200)',
    probe?.withToken === 200,
    String(probe?.withToken),
  );

  // Nothing Hermes ran above changed the image's files — no __pycache__, no package, no edit.
  const changed = docker(['diff', first])
    .split('\n')
    .filter((line) => /^[ACD] \/(app|opt\/hermes)(\/|$)/.test(line));
  check(
    'the container changed nothing under /app or /opt/hermes',
    changed.length === 0,
    changed.slice(0, 5).join(', '),
  );

  // A new container on the same data: the package installed before is still there.
  docker(['rm', '-f', first]);
  start(second);
  const kept = run(
    second,
    'python -c "import hermes_bootstrap, edge_tts; print(edge_tts.__file__)"',
    { allowFail: true },
  );
  check(
    'the package survives the container being recreated',
    Boolean(kept?.startsWith('/data/hermes-packages/')),
    kept ?? '',
  );
} catch (error) {
  console.error(String(error.message ?? error));
  failures.push('the check itself');
} finally {
  docker(['rm', '-f', first, second], { allowFail: true });
  docker(['volume', 'rm', '-f', volume], { allowFail: true });
}

if (failures.length > 0) {
  console.error(`\nimage:sealed-check  ${failures.length} failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nimage:sealed-check  OK');
