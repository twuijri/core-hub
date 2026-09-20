// Module `auth`: owns users, roles (owner, admin, member), passwords, app tokens, device pairing (QR).
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const authModule = defineModule({
  name: 'auth',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = authModule.registerRoutes.bind(authModule);
export const registerEvents = authModule.registerEvents.bind(authModule);
