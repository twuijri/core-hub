// Process entry: build the hub and listen. Configuration comes from app/config.ts only.
import { buildServer } from './app/server.js';

const app = await buildServer();
const { port } = app.hub.config;

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(
    {
      modules: app.hub.modules,
      namespaces: app.hub.namespaces,
      stubs: app.hub.stubs.length,
      database: app.hub.database.kind,
      dataDir: app.hub.config.dataDir,
    },
    'core hub listening',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}
