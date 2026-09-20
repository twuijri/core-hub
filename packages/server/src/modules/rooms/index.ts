// Module `rooms`: owns multi-agent rooms, seats, mentions, handoffs, room memory.
// Public surface of the module: other modules and app/ import this file only.
import { REALTIME_NAMESPACES, defineModule } from '../../lib/module.js';

export const roomsModule = defineModule({
  name: 'rooms',
  registerRoutes(_app) {
    // Routes are added here once their operations exist in packages/contracts/openapi.yaml.
  },
  registerEvents(io) {
    // Realtime handlers attach to the module's namespace once the contract declares its events.
    io.of(REALTIME_NAMESPACES.rooms);
  },
});

export const registerRoutes = roomsModule.registerRoutes.bind(roomsModule);
export const registerEvents = roomsModule.registerEvents.bind(roomsModule);
