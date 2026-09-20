// `pnpm db:migrate` entry: apply ./drizzle migrations to the configured database and exit.
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ pretty: process.stdout.isTTY });
const config = loadConfig();
const database = createDatabase(config.database, log);
try {
  await database.migrate();
} finally {
  await database.close();
}
