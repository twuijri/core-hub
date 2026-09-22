// The module list the app composes, in mount order. Every module in ARCHITECTURE §Modules is here.
import type { HubModule } from '../lib/module.js';
import { authModule, principalScopeResolver } from './auth/index.js';
import { agentDirectory, agentRunner, agentsModule } from './agents/index.js';
import { attachmentReferences, createSessionsModule } from './sessions/index.js';
import { roomsModule } from './rooms/index.js';
import { tasksModule } from './tasks/index.js';
import { schedulesModule } from './schedules/index.js';
import {
  attachmentsPort,
  knowledgeModule,
  registerAttachmentReferences,
} from './knowledge/index.js';
import { modelsModule } from './models/index.js';
import { devicesModule } from './devices/index.js';
import { notifyModule } from './notify/index.js';
import { updatesModule } from './updates/index.js';
import { auditModule } from './audit/index.js';
import { pluginsModule } from './plugins/index.js';

// The one wiring line the sessions module asked for: its ports come from `agents` (the
// registry and the runner over the adapters), `auth` (who is asking, in which workspace)
// and `knowledge` (the file registry a turn reads from and writes back to).
export const sessionsModule = createSessionsModule({
  agents: agentDirectory,
  runner: agentRunner,
  attachments: attachmentsPort,
  scopes: principalScopeResolver,
});

// The other direction of the same pair: `knowledge` refuses to delete a file a message
// still points at, and only `sessions` knows that (contract `409` on deleteAttachment).
registerAttachmentReferences(attachmentReferences);

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
