/**
 * Presets (contract decision §100): a named, saved bundle of one agent's settings in one
 * profile, which an admin saves, reads, deletes and activates.
 *
 * The bundle is read and applied **through the hub's own operations**, as the caller: what
 * saving reads is what the agent's pages read (`models.getDefaults`, `agents.get`,
 * `agents.listSkills`, `agents.listMcpServers`, `agents.getSettings`), and activating makes
 * the same writes a person makes on those pages (`models.setDefaults`, `agents.update`,
 * `agents.updateSkill`, `agents.updateMcpServer`, `agents.updateSettings`). So every check,
 * every event and every restart those operations make happens here too, with the caller's
 * own permissions, and there is no second copy of any of their rules to drift.
 *
 * What is never saved: a secret. Providers are named by id and MCP servers by name (their
 * configuration, which holds keys, is not read), a settings field of kind `secret` is left
 * out, and so is any text value that carries a user and password (a proxy URL
 * `http://user:pass@host`). `withoutSecrets` is the one gate; the tests hold it.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ModuleDb } from '../../lib/db.js';
import { HubError, conflict, notFound, stateInvalid } from '../../lib/errors.js';
import { defineRoute, type RouteDeps } from '../../lib/route.js';
import { newUlid } from '../../db/ids.js';
import type { WorkspaceScope } from '../auth/index.js';
import { agentPresets, type AgentPresetContentBody, type AgentPresetModelBody } from './schema.js';

/** At most this many presets per agent and profile. */
export const MAX_PRESETS = 50;

export type PresetPart = 'model' | 'skills' | 'mcp_servers' | 'settings';

/** One request through the hub's own routes, as the caller. */
export type PresetCall = (
  method: 'GET' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

type ModelRef = { provider_id: string; model: string };

interface SettingsFieldView {
  key: string;
  kind: string;
  value: unknown;
}
interface SettingsSectionView {
  key: string;
  fields: SettingsFieldView[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const modelRef = (value: unknown): ModelRef | null =>
  isObject(value) && typeof value.provider_id === 'string' && typeof value.model === 'string'
    ? { provider_id: value.provider_id, model: value.model }
    : null;

/**
 * Whether a value carries a secret: a URL with a user or password in it. Anything else in a
 * non-secret field (a number, a choice, a switch, a proxy host) is a setting, not a secret.
 */
export function carriesSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    // `scheme://user:pass@host` anywhere in the text, parsed or not.
    if (/[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(value)) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some(carriesSecret);
  if (isObject(value)) return Object.values(value).some(carriesSecret);
  return false;
}

/**
 * The settings sections as a preset keeps them: section → field → value. A `secret` field
 * is never kept, and neither is a value that carries a secret. `null` values are kept: they
 * mean "the agent's default", and activating puts the field back to it.
 */
export function withoutSecrets(
  sections: readonly SettingsSectionView[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const section of sections) {
    const values: Record<string, unknown> = {};
    for (const field of section.fields ?? []) {
      if (field.kind === 'secret') continue;
      if (carriesSecret(field.value)) continue;
      values[field.key] = field.value ?? null;
    }
    if (Object.keys(values).length > 0) out[section.key] = values;
  }
  return out;
}

const enc = encodeURIComponent;

/** Reads the agent's settings as they are now. A part the agent does not have is `null`. */
export async function capturePreset(
  call: PresetCall,
  agentId: string,
): Promise<AgentPresetContentBody> {
  const agent = await call('GET', `/agents/${enc(agentId)}`);
  if (agent.status === 404) throw notFound({ resource: 'agent', id: agentId });
  const agentBody = isObject(agent.body) ? agent.body : {};

  let model: AgentPresetModelBody | null = null;
  const defaults = await call('GET', '/models/defaults');
  if (defaults.status === 200 && isObject(defaults.body)) {
    const body = defaults.body;
    const inherited = Array.isArray(body.inherited) && body.inherited.includes('default');
    model = {
      // An inherited chat model is saved as "inherit", not as the default profile's choice.
      default: inherited ? null : modelRef(body.default),
      fallbacks: inherited
        ? []
        : (Array.isArray(body.fallbacks) ? body.fallbacks : [])
            .map(modelRef)
            .filter((ref): ref is ModelRef => ref !== null),
      agent: modelRef(agentBody.default_model),
    };
  }

  let skills: Record<string, boolean> | null = null;
  if (agentBody.kind === 'hermes') {
    const listed = await call('GET', `/agents/${enc(agentId)}/skills`);
    if (listed.status === 200 && isObject(listed.body)) {
      skills = {};
      for (const category of (listed.body.categories as unknown[]) ?? []) {
        if (!isObject(category)) continue;
        for (const skill of (category.skills as unknown[]) ?? []) {
          if (!isObject(skill) || typeof skill.key !== 'string') continue;
          // Hermes's own bundled skills are not switched from the hub; not saved either.
          if (skill.source === 'builtin') continue;
          skills[skill.key] = skill.enabled === true;
        }
      }
    }
  }

  let mcpServers: Record<string, boolean> | null = null;
  const servers = await call('GET', `/agents/${enc(agentId)}/mcp-servers`);
  if (servers.status === 200 && isObject(servers.body) && Array.isArray(servers.body.items)) {
    mcpServers = {};
    for (const server of servers.body.items) {
      // The name and the switch only: a server's config holds its keys.
      if (isObject(server) && typeof server.name === 'string') {
        mcpServers[server.name] = server.enabled === true;
      }
    }
  }

  let settings: Record<string, Record<string, unknown>> | null = null;
  const read = await call('GET', `/agents/${enc(agentId)}/settings`);
  if (read.status === 200 && isObject(read.body) && Array.isArray(read.body.sections)) {
    settings = withoutSecrets(read.body.sections as SettingsSectionView[]);
  }

  return { model, skills, mcp_servers: mcpServers, settings };
}

export interface PresetActivation {
  applied: PresetPart[];
  skipped: Array<{ part: PresetPart; key: string | null; code: string }>;
  restartJobIds: string[];
}

const codeOf = (response: { status: number; body: unknown }): string =>
  isObject(response.body) && typeof response.body.code === 'string'
    ? response.body.code
    : response.status === 404
      ? 'not_found'
      : 'internal';

const ok = (status: number) => status >= 200 && status < 300;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a preset part by part. Each write is the operation a person would make; a refusal
 * is reported with its code and the rest goes on. Only what differs from the agent's current
 * state is written, so activating the preset the agent already matches restarts nothing.
 */
export async function applyPreset(
  call: PresetCall,
  agentId: string,
  content: AgentPresetContentBody,
): Promise<PresetActivation> {
  const result: PresetActivation = { applied: [], skipped: [], restartJobIds: [] };
  const skip = (part: PresetPart, key: string | null, code: string) =>
    result.skipped.push({ part, key, code });

  if (content.model) {
    const before = result.skipped.length;
    const { default: chat, fallbacks, agent } = content.model;
    const defaults = await call(
      'PUT',
      '/models/defaults',
      chat ? { default: chat, fallbacks } : { default: null },
    );
    if (!ok(defaults.status)) skip('model', 'default', codeOf(defaults));
    const patched = await call('PATCH', `/agents/${enc(agentId)}`, { default_model: agent });
    if (!ok(patched.status)) skip('model', 'agent', codeOf(patched));
    if (result.skipped.length === before) result.applied.push('model');
  }

  if (content.skills) {
    const before = result.skipped.length;
    const current = new Map<string, boolean>();
    const listed = await call('GET', `/agents/${enc(agentId)}/skills`);
    if (!ok(listed.status)) {
      skip('skills', null, codeOf(listed));
    } else {
      const body = isObject(listed.body) ? listed.body : {};
      for (const category of (body.categories as unknown[]) ?? []) {
        if (!isObject(category)) continue;
        for (const skill of (category.skills as unknown[]) ?? []) {
          if (isObject(skill) && typeof skill.key === 'string') {
            current.set(skill.key, skill.enabled === true);
          }
        }
      }
      for (const [key, enabled] of Object.entries(content.skills)) {
        if (!current.has(key)) {
          skip('skills', key, 'not_found');
          continue;
        }
        if (current.get(key) === enabled) continue;
        const res = await call('PATCH', `/agents/${enc(agentId)}/skills/${enc(key)}`, {
          enabled,
        });
        if (!ok(res.status)) skip('skills', key, codeOf(res));
      }
      if (result.skipped.length === before) result.applied.push('skills');
    }
  }

  if (content.mcp_servers) {
    const before = result.skipped.length;
    const listed = await call('GET', `/agents/${enc(agentId)}/mcp-servers`);
    if (!ok(listed.status)) {
      skip('mcp_servers', null, codeOf(listed));
    } else {
      const current = new Map<string, boolean>();
      const items =
        isObject(listed.body) && Array.isArray(listed.body.items) ? listed.body.items : [];
      for (const server of items) {
        if (isObject(server) && typeof server.name === 'string') {
          current.set(server.name, server.enabled === true);
        }
      }
      for (const [name, enabled] of Object.entries(content.mcp_servers)) {
        if (!current.has(name)) {
          skip('mcp_servers', name, 'not_found');
          continue;
        }
        if (current.get(name) === enabled) continue;
        const res = await call('PATCH', `/agents/${enc(agentId)}/mcp-servers/${enc(name)}`, {
          enabled,
        });
        if (!ok(res.status)) skip('mcp_servers', name, codeOf(res));
      }
      if (result.skipped.length === before) result.applied.push('mcp_servers');
    }
  }

  if (content.settings) {
    const before = result.skipped.length;
    const read = await call('GET', `/agents/${enc(agentId)}/settings`);
    if (!ok(read.status)) {
      skip('settings', null, codeOf(read));
    } else {
      const sections = new Map<string, Map<string, SettingsFieldView>>();
      const body =
        isObject(read.body) && Array.isArray(read.body.sections) ? read.body.sections : [];
      for (const section of body as SettingsSectionView[]) {
        sections.set(section.key, new Map((section.fields ?? []).map((f) => [f.key, f])));
      }
      for (const [sectionKey, values] of Object.entries(content.settings)) {
        const fields = sections.get(sectionKey);
        if (!fields) {
          skip('settings', sectionKey, 'not_found');
          continue;
        }
        const changed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          const field = fields.get(key);
          if (!field) {
            skip('settings', `${sectionKey}.${key}`, 'not_found');
            continue;
          }
          // A secret is never written from a preset, even one stored before this rule.
          if (field.kind === 'secret' || carriesSecret(value)) continue;
          if (!same(field.value ?? null, value ?? null)) changed[key] = value ?? null;
        }
        if (Object.keys(changed).length === 0) continue;
        const res = await call('PATCH', `/agents/${enc(agentId)}/settings`, {
          section: sectionKey,
          values: changed,
        });
        if (!ok(res.status)) {
          skip('settings', sectionKey, codeOf(res));
          continue;
        }
        const job = isObject(res.body) ? res.body.restart_job_id : null;
        if (typeof job === 'string') result.restartJobIds.push(job);
      }
      if (result.skipped.length === before) result.applied.push('settings');
    }
  }

  return result;
}

// ------------------------------------------------------------------ store and routes

type PresetRow = typeof agentPresets.$inferSelect;

export function serializePreset(row: PresetRow, profile: string) {
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    agent_id: row.agentId,
    name: row.name,
    description: row.description ?? null,
    content: row.content,
    last_activated_at: row.lastActivatedAt ? row.lastActivatedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** The caller's own credentials, carried into the hub's routes (the hub-tools precedent). */
export function callerOf(app: FastifyInstance, request: FastifyRequest, base: string): PresetCall {
  const pass: Record<string, string> = {};
  for (const name of ['authorization', 'cookie', 'x-hub-profile', 'accept-language']) {
    const value = request.headers[name];
    if (typeof value === 'string') pass[name] = value;
  }
  return async (method, path, body) => {
    const response = await app.inject({
      method,
      url: `${base}${path}`,
      headers: {
        ...pass,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let parsed: unknown;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = null;
    }
    return { status: response.statusCode, body: parsed };
  };
}

export interface PresetRouteContext {
  db(request: FastifyRequest): ModuleDb;
  scope(request: FastifyRequest): WorkspaceScope;
  actor(request: FastifyRequest): { userId: string };
  /** Throws `404` when the profile has no such agent. */
  requireAgent(request: FastifyRequest, agentId: string): void;
  base: string;
}

export function registerPresetRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  ctx: PresetRouteContext,
): void {
  const find = (db: ModuleDb, scope: WorkspaceScope, agentId: string, presetId: string) => {
    const row = db
      .select()
      .from(agentPresets)
      .where(
        and(
          eq(agentPresets.workspace, scope.id),
          eq(agentPresets.agentId, agentId),
          eq(agentPresets.id, presetId),
        ),
      )
      .get();
    if (!row) throw notFound({ resource: 'preset', id: presetId });
    return row;
  };

  defineRoute(app, deps, {
    operationId: 'agents.listPresets',
    handler: (request, { params }) => {
      const agentId = params.agent_id as string;
      ctx.requireAgent(request, agentId);
      const scope = ctx.scope(request);
      const rows = ctx
        .db(request)
        .select()
        .from(agentPresets)
        .where(and(eq(agentPresets.workspace, scope.id), eq(agentPresets.agentId, agentId)))
        .orderBy(desc(agentPresets.createdAt), desc(agentPresets.id))
        .all();
      return { items: rows.map((row) => serializePreset(row, scope.slug)) };
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.createPreset',
    status: 201,
    handler: async (request, { params, body }) => {
      const agentId = params.agent_id as string;
      ctx.requireAgent(request, agentId);
      const scope = ctx.scope(request);
      const db = ctx.db(request);
      const input = body as { name: string; description?: string | null };
      const name = input.name.trim();
      if (!name) {
        throw new HubError('validation_failed', { details: { field: 'name', reason: 'empty' } });
      }
      const existing = db
        .select({ id: agentPresets.id, name: agentPresets.name })
        .from(agentPresets)
        .where(and(eq(agentPresets.workspace, scope.id), eq(agentPresets.agentId, agentId)))
        .all();
      if (existing.some((row) => row.name === name)) {
        throw conflict({ field: 'name', reason: 'preset_name_taken' });
      }
      if (existing.length >= MAX_PRESETS) {
        throw stateInvalid({ reason: 'preset_limit', limit: MAX_PRESETS });
      }
      const content = await capturePreset(callerOf(app, request, ctx.base), agentId);
      const now = new Date();
      const row = db
        .insert(agentPresets)
        .values({
          id: newUlid(now.getTime()),
          workspace: scope.id,
          ownerId: ctx.actor(request).userId,
          agentId,
          name,
          description: input.description?.trim() || null,
          content,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      request.log.info({ agentId, preset: row.id }, 'agents: preset saved');
      return serializePreset(row, scope.slug);
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.getPreset',
    handler: (request, { params }) => {
      const agentId = params.agent_id as string;
      ctx.requireAgent(request, agentId);
      const scope = ctx.scope(request);
      return serializePreset(
        find(ctx.db(request), scope, agentId, params.preset_id as string),
        scope.slug,
      );
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.deletePreset',
    status: 204,
    handler: (request, { params }) => {
      const agentId = params.agent_id as string;
      ctx.requireAgent(request, agentId);
      const scope = ctx.scope(request);
      const db = ctx.db(request);
      const row = find(db, scope, agentId, params.preset_id as string);
      db.delete(agentPresets).where(eq(agentPresets.id, row.id)).run();
      return null;
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.activatePreset',
    handler: async (request, { params }) => {
      const agentId = params.agent_id as string;
      ctx.requireAgent(request, agentId);
      const scope = ctx.scope(request);
      const db = ctx.db(request);
      const row = find(db, scope, agentId, params.preset_id as string);
      const outcome = await applyPreset(callerOf(app, request, ctx.base), agentId, row.content);
      const now = new Date();
      const updated = db
        .update(agentPresets)
        .set({ lastActivatedAt: now })
        .where(eq(agentPresets.id, row.id))
        .returning()
        .get();
      request.log.info(
        { agentId, preset: row.id, applied: outcome.applied, skipped: outcome.skipped.length },
        'agents: preset activated',
      );
      return {
        preset: serializePreset(updated ?? row, scope.slug),
        applied: outcome.applied,
        skipped: outcome.skipped,
        restart_job_ids: outcome.restartJobIds,
      };
    },
  });
}
