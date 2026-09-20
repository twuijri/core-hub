// Module `agents`: owns registry of agents, adapters, install/version state, per-agent settings, capabilities.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const agentsModule = defineModule({
  name: 'agents',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = agentsModule.registerRoutes.bind(agentsModule);
export const registerEvents = agentsModule.registerEvents.bind(agentsModule);
