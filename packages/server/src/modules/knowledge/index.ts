// Module `knowledge`: owns journal, notes/memory browser, files/attachments, search.
// Public surface of the module: other modules and app/ import this file only.
import { defineModule } from '../../lib/module.js';

export const knowledgeModule = defineModule({
  name: 'knowledge',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = knowledgeModule.registerRoutes.bind(knowledgeModule);
export const registerEvents = knowledgeModule.registerEvents.bind(knowledgeModule);
