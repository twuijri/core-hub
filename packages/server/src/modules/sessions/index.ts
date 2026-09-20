// Module `sessions`: owns chat sessions, messages, streaming runs, tool calls, approvals.
// Public surface of the module: other modules and app/ import this file only.
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';

export const sessionsModule = defineModule({
  name: 'sessions',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.sessions);
  },
});

export const registerRoutes = sessionsModule.registerRoutes.bind(sessionsModule);
export const registerEvents = sessionsModule.registerEvents.bind(sessionsModule);
