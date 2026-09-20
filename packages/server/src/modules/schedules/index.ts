// Module `schedules`: owns cron jobs, workflows (DAG of runs), run history, approvals inside runs.
// Public surface of the module: other modules and app/ import this file only.
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';

export const schedulesModule = defineModule({
  name: 'schedules',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.schedules);
  },
});

export const registerRoutes = schedulesModule.registerRoutes.bind(schedulesModule);
export const registerEvents = schedulesModule.registerEvents.bind(schedulesModule);
