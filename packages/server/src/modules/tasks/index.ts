// Module `tasks`: owns projects, tasks (a kanban-style section), assignment to agents,
// transitions, worktrees per task.
// Public surface of the module: other modules and app/ import this file only.
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';

export const tasksModule = defineModule({
  name: 'tasks',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.tasks);
  },
});

export const registerRoutes = tasksModule.registerRoutes.bind(tasksModule);
export const registerEvents = tasksModule.registerEvents.bind(tasksModule);
