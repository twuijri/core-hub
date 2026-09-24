/**
 * The `ScopeResolver` the `sessions` module asks for (`modules/sessions/scope.ts`): who is
 * asking and in which workspace, from the request's principal and `X-Hub-Profile`.
 *
 * The shape is restated here rather than imported: a module never reaches into another
 * module's internals (ARCHITECTURE §Modules); the wiring line in `src/modules/index.ts`
 * is where the two must agree, and a mismatch is a type error there.
 *
 * Rules, all of `auth`'s and none new: no principal -> `401 unauthorized` (or the reason
 * the bearer was refused); an unknown or not-enterable workspace -> `404 profile_not_found`.
 * The ids handed back are the real rows' — `workspaces.id` and `users.id` — so every
 * scoped row `sessions` writes carries them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { auditFor } from '../audit/index.js';
import { findUser } from './users.js';
import { listWorkspacesFor, resolveWorkspaceFor } from './workspace.js';

export interface PrincipalScope {
  workspaceId: string;
  profile: string;
  userId: string;
  userName: string;
}

/** An HTTP request, or a socket's verified principal (`/rt/sessions` `subscribe`). */
export type PrincipalScopeCaller = Pick<FastifyRequest, 'principal' | 'authError'>;

export interface PrincipalScopeResolver {
  resolve(profile: string, caller: PrincipalScopeCaller): Promise<PrincipalScope | null>;
  enterable(caller: PrincipalScopeCaller): Promise<PrincipalScope[]>;
}

export function principalScopeResolver(app: FastifyInstance): PrincipalScopeResolver {
  const db = requireSqlite(app.hub.database);
  return {
    async resolve(profile, caller) {
      const principal = caller.principal;
      if (!principal) throw caller.authError ?? new HubError('unauthorized');
      const workspace = resolveWorkspaceFor(db, principal.user, profile);
      // Jobs store the workspace id and report its slug (`/rt/jobs` names the profile).
      auditFor(app).rememberWorkspace(workspace.id, workspace.slug);
      const user = findUser(db, principal.user.id);
      return {
        workspaceId: workspace.id,
        profile: workspace.slug,
        userId: principal.user.id,
        userName: user?.displayName || principal.user.username,
      };
    },
    /**
     * The profiles a list across profiles covers (ADR 0016): the same membership rule the
     * header is checked with (`listWorkspacesFor` — owners and admins every workspace, a
     * member the ones they are enrolled in), so "all" can never reach further than a
     * header could.
     */
    async enterable(caller) {
      const principal = caller.principal;
      if (!principal) throw caller.authError ?? new HubError('unauthorized');
      const user = findUser(db, principal.user.id);
      const userName = user?.displayName || principal.user.username;
      return listWorkspacesFor(db, principal.user).map((row) => {
        auditFor(app).rememberWorkspace(row.id, row.slug);
        return { workspaceId: row.id, profile: row.slug, userId: principal.user.id, userName };
      });
    },
  };
}
