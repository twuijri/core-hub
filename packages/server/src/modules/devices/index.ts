// Module `devices`: owns phones/computers linked to the hub, capabilities they expose, media relay.
// Public surface of the module: other modules and app/ import this file only.
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';

export const devicesModule = defineModule({
  name: 'devices',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.devices);
  },
});

export const registerRoutes = devicesModule.registerRoutes.bind(devicesModule);
export const registerEvents = devicesModule.registerEvents.bind(devicesModule);
