/**
 * The embedded hub of local mode (ADR 0009): the same `packages/server` build, started by
 * the desktop app as a child process with Electron's own Node (`ELECTRON_RUN_AS_NODE`).
 *
 * Two differences from the image's entry (`packages/server/src/main.ts`), both about being on
 * a person's computer rather than in a container: it listens on 127.0.0.1 only — a hub the
 * app runs is nobody else's on the network — and it does not serve the web client, which the
 * app serves itself. `PORT=0` picks a free port, and the port is reported to the app over the
 * IPC channel `fork` opens. Configuration is the hub's own (`DATA_DIR`, `PORT`, …).
 */
import { buildServer } from '../../../../packages/server/src/app/server.js';
import { RelayHostRefusal } from '../../../../packages/server/src/modules/devices/index.js';
import { createServer } from 'node:net';
import { ipcRelayHost } from '../shared/hub-ipc.js';

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// The way in from outside (DECISIONS §95) is the app's to open: the hub asks it over IPC.
const relayHost = process.send
  ? ipcRelayHost({
      send: (message) => process.send?.(message),
      listen: (listener) => process.on('message', listener),
      refusal: (reason, message) => new RelayHostRefusal(reason, message),
    })
  : null;

// The app asks for the port it used last (`COREHUB_DESKTOP_PORT`), so a tunnel pointed at it
// keeps working after a restart; when another program has taken it, any free port will do.
const preferred = Number(process.env.COREHUB_DESKTOP_PORT) || 0;
if (preferred && (await portFree(preferred))) process.env.PORT = String(preferred);

const app = await buildServer({ webDir: null, relayHost });

try {
  await app.listen({ port: app.hub.config.port, host: '127.0.0.1' });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : app.hub.config.port;
app.log.info({ port, dataDir: app.hub.config.dataDir }, 'embedded hub listening');
process.send?.({ type: 'listening', port });

let closing = false;
const stop = (reason: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ reason }, 'embedded hub stopping');
  void app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop(signal));
// The app went away without saying so (crashed, killed): a hub nobody can reach must not stay.
process.on('disconnect', () => stop('parent gone'));
process.on('message', (message) => {
  if ((message as { type?: string } | null)?.type === 'stop') stop('asked');
});
