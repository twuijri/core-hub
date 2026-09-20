// Module `models`: owns providers, keys (secrets), model catalogue, fallbacks, STT/TTS providers.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const modelsModule = defineModule({
  name: 'models',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = modelsModule.registerRoutes.bind(modelsModule);
export const registerEvents = modelsModule.registerEvents.bind(modelsModule);
