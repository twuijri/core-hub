// The module list the app composes, in mount order. Every module in ARCHITECTURE §Modules is here.
import type { HubModule } from '../lib/module.js';
import { authModule } from './auth/index.js';
import { agentsModule } from './agents/index.js';
import { sessionsModule } from './sessions/index.js';
import { roomsModule } from './rooms/index.js';
import { boardModule } from './board/index.js';
import { schedulesModule } from './schedules/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { modelsModule } from './models/index.js';
import { devicesModule } from './devices/index.js';
import { notifyModule } from './notify/index.js';
import { updatesModule } from './updates/index.js';
import { auditModule } from './audit/index.js';
import { pluginsModule } from './plugins/index.js';

export const modules: readonly HubModule[] = [
  authModule,
  agentsModule,
  sessionsModule,
  roomsModule,
  boardModule,
  schedulesModule,
  knowledgeModule,
  modelsModule,
  devicesModule,
  notifyModule,
  updatesModule,
  auditModule,
  pluginsModule,
];
