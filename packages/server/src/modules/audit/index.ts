// Module `audit`: owns usage, costs, logs, performance snapshots.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const auditModule = defineModule({
  name: 'audit',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = auditModule.registerRoutes.bind(auditModule);
export const registerEvents = auditModule.registerEvents.bind(auditModule);
