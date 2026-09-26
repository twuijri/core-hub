// A stand-in for Cloudflare's `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<port> run`,
// as src/main/tunnel.ts starts it: reads the token from TUNNEL_TOKEN, logs JSON lines on stderr
// (TUNNEL_LOG_OUTPUT=json), and answers /ready on the metrics port like the real one.
//
// The token decides what it does: `bad…` is refused as Cloudflare refuses a token; `crash…` dies
// after a moment; anything else connects and reports a route to FAKE_ROUTE_SERVICE.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const token = process.env.TUNNEL_TOKEN ?? '';
const log = (level, message, extra = {}) =>
  process.stderr.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), message, ...extra })}\n`,
  );

if (process.env.FAKE_CLOUDFLARED_REPORT)
  appendFileSync(
    process.env.FAKE_CLOUDFLARED_REPORT,
    `${JSON.stringify({ args, token, output: process.env.TUNNEL_LOG_OUTPUT, pid: process.pid })}\n`,
  );

if (token.startsWith('bad')) {
  log('error', 'Provided Tunnel token is not valid.');
  process.exit(1);
}

const metrics = args[args.indexOf('--metrics') + 1] ?? '127.0.0.1:0';
const [host, port] = metrics.split(':');
let ready = false;
const server = createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ready ? 200 : 503, readyConnections: ready ? 4 : 0 }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(port), host, () => {
  log('info', `Starting metrics server on ${metrics}/metrics`);
  setTimeout(() => {
    const config = {
      ingress: [
        {
          hostname: 'hub.example.com',
          service: process.env.FAKE_ROUTE_SERVICE ?? 'http://localhost:47113',
        },
        { service: 'http_status:404' },
      ],
    };
    log('info', 'Updated to new configuration', { config: JSON.stringify(config), version: 1 });
    ready = true;
    log('info', 'Registered tunnel connection', { connIndex: 0 });
  }, 50);
  if (token.startsWith('crash'))
    setTimeout(() => {
      log('error', `lost the connection (token was ${token})`);
      process.exit(2);
    }, 400);
});
process.on('SIGTERM', () => {
  log('info', 'Initiating graceful shutdown due to signal terminated ...');
  server.close(() => process.exit(0));
});
