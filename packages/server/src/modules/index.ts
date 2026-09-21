// The module list the app composes, in mount order. Every module in ARCHITECTURE §Modules is here.
import type { HubModule } from '../lib/module.js';
import { authModule, principalScopeResolver } from './auth/index.js';
import { agentDirectory, agentRunner, agentsModule } from './agents/index.js';
import { createSessionsModule } from './sessions/index.js';
import { roomsModule } from './rooms/index.js';
import { tasksModule } from './tasks/index.js';
import { schedulesModule } from './schedules/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { modelsModule } from './models/index.js';
import { devicesModule } from './devices/index.js';
import { notifyModule } from './notify/index.js';
import { updatesModule } from './updates/index.js';
import { auditModule } from './audit/index.js';
import { pluginsModule } from './plugins/index.js';

// The one wiring line the sessions module asked for: its ports come from `agents` (the
// registry and the runner over the adapters) and `auth` (who is asking, in which workspace).
export const sessionsModule = createSessionsModule({
  agents: agentDirectory,
  runner: agentRunner,
  scopes: principalScopeResolver,
});

export const modules: readonly HubModule[] = [
  authModule,
  agentsModule,
  sessionsModule,
  roomsModule,
  tasksModule,
  schedulesModule,
  knowledgeModule,
  modelsModule,
  devicesModule,
  notifyModule,
  updatesModule,
  auditModule,
  pluginsModule,
];
