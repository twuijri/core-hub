// Module `updates`: owns release channels for the clients, in-app update source.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const updatesModule = defineModule({
  name: 'updates',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = updatesModule.registerRoutes.bind(updatesModule);
export const registerEvents = updatesModule.registerEvents.bind(updatesModule);
