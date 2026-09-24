/**
 * Module `plugins`: Docker- and MCP-based extensions of the hub, and how they are exposed
 * to agents.
 *
 * Implemented: `plugins.list` — what is installed on this hub, and whether it is running.
 *
 * **A hub with no plugins answers with an empty list, and that is the whole truth of it.**
 * Installing, starting and exposing a plugin is the rest of this module and is not built;
 * nothing here pretends otherwise, and no plugin is invented to fill the page. The tables
 * (`plugins`, `plugin_bindings`, `plugin_tools`) are the schema the installer will write
 * to, so the list is already reading its real source rather than a placeholder.
 *
 * The status a person sees is the *binding's*, not the row's: a plugin is installed on the
 * hub once, and each workspace decides whether to run it. With no binding in this
 * workspace the honest word is `stopped`.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@corehub/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite } from '../../lib/db.js';
import { defineModule } from '../../lib/module.js';
import { defineRoute } from '../../lib/route.js';
import { requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { plugins, pluginBindings } from './schema.js';

/** The two kinds the contract names; a `skill_pack` is carried by whichever runtime hosts it. */
function wireKind(kind: string): 'docker' | 'mcp' {
  return kind === 'docker' ? 'docker' : 'mcp';
}

export const pluginsModule = defineModule({
  name: 'plugins',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    defineRoute(app, deps, {
      operationId: 'plugins.list',
      handler: (request) => {
        const db = requireSqlite(request.server.hub.database);
        const workspace = request.workspace?.id ?? null;
        const rows = db
          .select({ plugin: plugins, binding: pluginBindings })
          .from(plugins)
          .leftJoin(
            pluginBindings,
            and(
              eq(pluginBindings.pluginId, plugins.id),
              workspace === null ? undefined : eq(pluginBindings.workspace, workspace),
            ),
          )
          .where(isNull(plugins.archivedAt))
          .orderBy(asc(plugins.slug))
          .all();

        return {
          items: rows.map(({ plugin, binding }) => ({
            id: plugin.id,
            slug: plugin.slug,
            name: plugin.name,
            version: plugin.version ?? '0.0.0',
            kind: wireKind(plugin.kind),
            // Not running until something started it; `error` only when one was recorded.
            status:
              binding?.status === 'running' ? 'running' : plugin.lastError ? 'error' : 'stopped',
            url: null,
            created_at: plugin.createdAt.toISOString(),
            updated_at: plugin.updatedAt.toISOString(),
          })),
        };
      },
    });
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = pluginsModule.registerRoutes.bind(pluginsModule);
export const registerEvents = pluginsModule.registerEvents.bind(pluginsModule);
