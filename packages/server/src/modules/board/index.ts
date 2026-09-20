// Module `board`: owns projects, tasks (kanban), assignment to agents, transitions, worktrees per task.
// Public surface of the module: other modules and app/ import this file only.
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';

export const boardModule = defineModule({
  name: 'board',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.board);
  },
});

export const registerRoutes = boardModule.registerRoutes.bind(boardModule);
export const registerEvents = boardModule.registerEvents.bind(boardModule);
