// Module `notify`: owns push/APNs/FCM, in-app notices, webhooks out.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const notifyModule = defineModule({
  name: 'notify',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = notifyModule.registerRoutes.bind(notifyModule);
export const registerEvents = notifyModule.registerEvents.bind(notifyModule);
