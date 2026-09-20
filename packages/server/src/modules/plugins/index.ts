// Module `plugins`: owns Docker/MCP based extensions and skills exposure.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const pluginsModule = defineModule({
  name: 'plugins',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = pluginsModule.registerRoutes.bind(pluginsModule);
export const registerEvents = pluginsModule.registerEvents.bind(pluginsModule);
