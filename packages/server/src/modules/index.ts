// The module list the app composes, in mount order. Every module in ARCHITECTURE §Modules is here.
import type { FastifyInstance } from 'fastify';
import type { HubModule } from '../lib/module.js';
import { requireSqlite } from '../lib/db.js';
import type { SessionsNotifier } from './sessions/ports.js';
import { authModule, principalScopeResolver } from './auth/index.js';
import {
  agentDirectory,
  agentRunner,
  agentsModule,
  agentsServiceFor,
  hermesRuntimeFor,
} from './agents/index.js';
import { attachmentReferences, createSessionsModule } from './sessions/index.js';
import { roomsModule } from './rooms/index.js';
import { registerHermesBoard, tasksModule } from './tasks/index.js';
import { createHermesKanban, processRunner } from './tasks/hermes-kanban.js';
import { schedulesModule } from './schedules/index.js';
import {
  attachmentsPort,
  knowledgeModule,
  registerAttachmentReferences,
} from './knowledge/index.js';
import { modelsModule } from './models/index.js';
import { devicesModule } from './devices/index.js';
import { createNotifier, notifyModule } from './notify/index.js';
import { updatesModule } from './updates/index.js';
import { auditModule } from './audit/index.js';
import { pluginsModule } from './plugins/index.js';

// The one wiring line the sessions module asked for: its ports come from `agents` (the
// registry and the runner over the adapters), `auth` (who is asking, in which workspace)
// and `knowledge` (the file registry a turn reads from and writes back to).
/**
 * `sessions` announces what happened; `notify` decides whether the person hears it and in
 * which words. The translation between the two lives here, in the composition root, so
 * neither module has to know the other exists (ARCHITECTURE §Modules).
 */
export const notifierPort = (app: FastifyInstance): SessionsNotifier => {
  const notifier = createNotifier(requireSqlite(app.hub.database), () => app.hub.io);
  return {
    runFinished(input) {
      notifier.announce(
        { userId: input.userId, workspace: input.workspace, profile: input.profile },
        input.outcome === 'succeeded'
          ? { kind: 'run_completed', agent: input.agentName, session: input.sessionTitle }
          : {
              kind: 'run_failed',
              agent: input.agentName,
              session: input.sessionTitle,
              reason: input.reason,
            },
        { kind: 'session', id: input.sessionId },
      );
    },
    approvalRequested(input) {
      notifier.announce(
        { userId: input.userId, workspace: input.workspace, profile: input.profile },
        { kind: 'approval_requested', agent: input.agentName, session: '', what: input.what },
        { kind: 'session', id: input.sessionId },
      );
    },
  };
};

export const sessionsModule = createSessionsModule({
  agents: agentDirectory,
  runner: agentRunner,
  attachments: attachmentsPort,
  scopes: principalScopeResolver,
  notifier: notifierPort,
});

// The other direction of the same pair: `knowledge` refuses to delete a file a message
// still points at, and only `sessions` knows that (contract `409` on deleteAttachment).
registerAttachmentReferences(attachmentReferences);

/**
 * The Tasks board reflects Hermes's own kanban (owner decision, 2026-09-23). `agents`
 * knows where Hermes lives — its executable and the home the gateway runs in — and
 * `tasks` knows what a card is; this is the one place allowed to put them together.
 *
 * There is a kanban only while both exist: no executable on this host, or no home to
 * point it at, and every card is simply the hub's own.
 */
registerHermesBoard((app) => ({
  kanban() {
    const runtime = hermesRuntimeFor(app);
    const home = runtime.status().home;
    const command = runtime.executable();
    if (!home || !command) return null;
    return createHermesKanban(processRunner({ command, home, env: runtime.cliEnv() }));
  },
  agentId(workspace) {
    // Agents are hub-wide rows; the scope only decides how settings are shown.
    const found = agentsServiceFor(app)
      .list({ id: workspace, slug: '', name: '', isDefault: false }, { kind: 'hermes' })
      .find((agent) => agent.slug === 'hermes');
    return found?.id ?? null;
  },
}));

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
