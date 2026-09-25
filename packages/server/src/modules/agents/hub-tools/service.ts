/**
 * The hub's own tools (contract decision §47): per-profile settings, the block written into
 * the profile's Hermes config, and the MCP endpoint's calls.
 *
 * Who a call acts as is decided in three steps, and each can only narrow:
 * 1. the bearer is a profile's key (`hub_mcp_…`, hashed here, in the profile's `.env` only):
 *    it names the profile and nothing else;
 * 2. the profile's live runs name the person (`leases.ts`); no live run, no call;
 * 3. the call goes through the hub's own HTTP stack with that run's token
 *    (`auth/run-tokens.ts`): that person, in that profile only, never an admin.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { serverBasePath, loadOpenApiDocument } from '@corehub/contracts';
import type { ModuleDb } from '../../../lib/db.js';
import { HubError } from '../../../lib/errors.js';
import { findUser, findWorkspace, type WorkspaceScope } from '../../auth/index.js';
import { hubToolCalls, hubToolSettings, type HubToolGroupState } from '../schema.js';
import { HUB_SERVER_NAME, blockInSync, removeBlock, writeBlock } from './block.js';
import {
  HUB_TOOLS,
  HUB_TOOL_GROUPS,
  ToolRefusal,
  findTool,
  toolsOf,
  type HubToolDefinition,
  type HubToolGroup,
  type ToolContext,
} from './catalog.js';
import type { RunLeases } from './leases.js';
import { handleRpc, parseError, type McpToolResult, type RpcResponse } from './protocol.js';

export const HUB_KEY_PREFIX = 'hub_mcp_';
const RECENT_CALLS = 20;
const KEPT_CALLS = 200;
const MAX_RESULT_CHARS = 100_000;

export type HubToolsUnavailable = 'runtime_absent' | 'hermes_profile_absent';

export interface HubToolsPatch {
  enabled?: boolean;
  groups?: Array<{ id: HubToolGroup; enabled?: boolean; allow_writes?: boolean }>;
}

/** Where a notice from `notifications.notify` goes; lent by `notify` through the root. */
export type HubToolsNotify = (input: {
  workspaceId: string;
  profile: string;
  userId: string;
  title: string;
  body: string | null;
}) => void;

export interface HubToolsDeps {
  app: FastifyInstance;
  db: ModuleDb;
  leases: RunLeases;
  dataDir: string;
  version: string;
  /** The Hermes agent's registry id (a new schedule runs it unless told otherwise). */
  hermesAgentId(workspaceId: string): string | null;
  notify(): HubToolsNotify | null;
  timezone(): string;
  /** Hermes reads its MCP servers when a conversation's gateway starts: start a new one. */
  refreshRuntime(): void;
  /** Where a profile's Hermes home is, or why there is none. */
  homeOf(workspace: WorkspaceScope): { home: string | null; reason: HubToolsUnavailable | null };
  /** Where Hermes reaches this hub's MCP server. */
  url(): string | null;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function newKey(): string {
  return `${HUB_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
}

/** Switched on for the first time: every group reads, none writes (§47, proposed). */
const DEFAULT_GROUP: HubToolGroupState = { enabled: true, allowWrites: false };

export class HubToolsService {
  private readonly base: string;

  constructor(private readonly deps: HubToolsDeps) {
    const document = loadOpenApiDocument();
    this.base = document ? serverBasePath(document) : '/api/v1';
  }

  private row(workspaceId: string) {
    return (
      this.deps.db
        .select()
        .from(hubToolSettings)
        .where(eq(hubToolSettings.workspace, workspaceId))
        .get() ?? null
    );
  }

  private groupsOf(stored: Record<string, HubToolGroupState> | undefined) {
    return Object.fromEntries(
      HUB_TOOL_GROUPS.map((id) => [id, { ...DEFAULT_GROUP, ...(stored?.[id] ?? {}) }]),
    ) as Record<HubToolGroup, HubToolGroupState>;
  }

  /** The contract's `HubTools` for one profile. */
  view(workspace: WorkspaceScope): Record<string, unknown> {
    const row = this.row(workspace.id);
    const groups = this.groupsOf(row?.groups);
    const { home, reason } = this.deps.homeOf(workspace);
    const calls = this.deps.db
      .select()
      .from(hubToolCalls)
      .where(eq(hubToolCalls.workspace, workspace.id))
      .orderBy(desc(hubToolCalls.createdAt), desc(hubToolCalls.id))
      .limit(RECENT_CALLS)
      .all();
    return {
      enabled: row?.enabled ?? false,
      available: home !== null,
      unavailable_reason: home ? null : reason,
      server_name: HUB_SERVER_NAME,
      url: this.deps.url(),
      groups: HUB_TOOL_GROUPS.map((id) => ({
        id,
        enabled: groups[id].enabled,
        allow_writes: groups[id].allowWrites,
        tools: toolsOf(id).map((tool) => ({ name: tool.name, access: tool.access })),
      })),
      recent_calls: calls.map((call) => ({
        id: call.id,
        tool: call.tool,
        ok: call.ok,
        error_code: call.errorCode,
        user_id: call.userId,
        session_id: call.sessionId,
        duration_ms: call.durationMs,
        created_at: call.createdAt.toISOString(),
      })),
      updated_at: row ? row.updatedAt.toISOString() : null,
    };
  }

  /** Change the settings and put the profile's Hermes config in step with them. */
  update(workspace: WorkspaceScope, actorId: string, patch: HubToolsPatch): void {
    const existing = this.row(workspace.id);
    const groups = this.groupsOf(existing?.groups);
    for (const change of patch.groups ?? []) {
      if (!(HUB_TOOL_GROUPS as readonly string[]).includes(change.id)) continue;
      groups[change.id] = {
        enabled: change.enabled ?? groups[change.id].enabled,
        allowWrites: change.allow_writes ?? groups[change.id].allowWrites,
      };
    }
    const enabled = patch.enabled ?? existing?.enabled ?? false;
    const { home, reason } = this.deps.homeOf(workspace);
    const url = this.deps.url();
    let keyHash = existing?.keyHash ?? null;
    if (enabled) {
      if (!home || !url) {
        throw new HubError('state_invalid', {
          details: { reason: reason ?? 'hub_url_unknown' },
        });
      }
      const current = keyHash;
      if (!current || !blockInSync(home, url, (key) => hashKey(key) === current)) {
        const key = newKey();
        writeBlock(home, url, key);
        keyHash = hashKey(key);
      }
    } else {
      if (home) removeBlock(home);
      keyHash = null;
    }
    const values = { enabled, groups, keyHash };
    if (existing) {
      this.deps.db
        .update(hubToolSettings)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(hubToolSettings.id, existing.id))
        .run();
    } else {
      this.deps.db
        .insert(hubToolSettings)
        .values({ ...values, workspace: workspace.id, ownerId: actorId })
        .run();
    }
    // Whether the server appeared, went or changed its tools, the next conversation's
    // gateway reads it afresh. A turn in flight keeps the one it has.
    // (A group switched off is refused at the call at once; the list catches up here.)
    if (enabled || existing?.enabled) this.deps.refreshRuntime();
  }

  /**
   * At boot, and whenever the hub's address is known again: every profile with the tools on
   * gets its block back as the hub would write it (the port may have moved, a person may
   * have edited it). A new key when the old one is not in the `.env` any more.
   */
  syncAll(): void {
    const url = this.deps.url();
    if (!url) return;
    const rows = this.deps.db
      .select()
      .from(hubToolSettings)
      .where(eq(hubToolSettings.enabled, true))
      .all();
    for (const row of rows) {
      const workspace = findWorkspace(this.deps.db, row.workspace);
      if (!workspace || workspace.id !== row.workspace) continue;
      const { home } = this.deps.homeOf({
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        isDefault: workspace.isDefault,
      });
      if (!home) continue;
      const current = row.keyHash;
      try {
        if (current && blockInSync(home, url, (key) => hashKey(key) === current)) continue;
        const key = newKey();
        writeBlock(home, url, key);
        this.deps.db
          .update(hubToolSettings)
          .set({ keyHash: hashKey(key), updatedAt: new Date() })
          .where(eq(hubToolSettings.id, row.id))
          .run();
      } catch (error) {
        this.deps.app.log.warn(
          { err: error, profile: workspace.slug },
          'agents: could not put the hub tools back into the profile config',
        );
      }
    }
  }

  // -------------------------------------------------------------- the MCP endpoint

  /** One POST to `agents.hubMcp`: the answer, or `null` for `202`. */
  async handle(bearer: string | null, body: unknown): Promise<RpcResponse | null> {
    if (!bearer || !bearer.startsWith(HUB_KEY_PREFIX)) {
      throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    }
    const row =
      this.deps.db
        .select()
        .from(hubToolSettings)
        .where(and(eq(hubToolSettings.keyHash, hashKey(bearer)), eq(hubToolSettings.enabled, true)))
        .get() ?? null;
    const workspace = row ? findWorkspace(this.deps.db, row.workspace) : null;
    if (!row || !workspace || workspace.id !== row.workspace) {
      throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    }
    if (body === undefined || body === null) return parseError();
    const groups = this.groupsOf(row.groups);
    const offered = (tool: HubToolDefinition): boolean =>
      groups[tool.group].enabled && (tool.access === 'read' || groups[tool.group].allowWrites);

    return handleRpc(body, {
      serverName: HUB_SERVER_NAME,
      serverVersion: this.deps.version,
      instructions:
        `Core Hub's own tools for the profile "${workspace.name}". Every call acts for the ` +
        'person whose conversation this is, in this profile only, with their permissions.',
      listTools: () =>
        HUB_TOOLS.filter(offered).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      callTool: (name, args) => this.call(workspace, name, args, offered),
    });
  }

  private async call(
    workspace: { id: string; slug: string },
    name: string,
    args: Record<string, unknown>,
    offered: (tool: HubToolDefinition) => boolean,
  ): Promise<McpToolResult> {
    const started = Date.now();
    const tool = findTool(name);
    const record = (
      ok: boolean,
      errorCode: string | null,
      lease: { userId: string; sessionId: string; runId: string } | null,
    ) => this.record(workspace.id, name, ok, errorCode, lease, Date.now() - started);

    if (!tool || !offered(tool)) {
      record(false, 'hub_tools_tool_off', null);
      return refusal('hub_tools_tool_off', `the tool ${name} is not offered in this profile`);
    }
    const attribution = await this.deps.leases.attribute(workspace.id);
    if (!attribution.ok) {
      record(false, attribution.reason, null);
      return refusal(
        attribution.reason,
        attribution.reason === 'hub_tools_no_live_run'
          ? 'no conversation of the hub is running in this profile, so there is nobody to act for'
          : 'several people have conversations running in this profile and the hub could not tell whose this is; try again',
      );
    }
    const { lease } = attribution;
    const person = findUser(this.deps.db, lease.userId);
    const context: ToolContext = {
      call: (method, route, options) =>
        this.inject(lease.token, workspace.slug, person?.locale ?? 'en', method, route, options),
      profile: workspace.slug,
      agentId: this.deps.hermesAgentId(workspace.id),
      filesRoot: path.join(this.deps.dataDir, 'workspaces', workspace.slug),
      notify: (title, body) => {
        const notify = this.deps.notify();
        if (!notify) throw new ToolRefusal('service_unavailable', 'notifications are not composed');
        notify({
          workspaceId: workspace.id,
          profile: workspace.slug,
          userId: lease.userId,
          title,
          body,
        });
      },
      timezone: this.deps.timezone(),
    };
    try {
      const result = await tool.run(context, args);
      record(true, null, lease);
      const text = JSON.stringify(result ?? null);
      return {
        content: [
          {
            type: 'text',
            text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text,
          },
        ],
        ...(result && typeof result === 'object' && !Array.isArray(result)
          ? { structuredContent: result as Record<string, unknown> }
          : {}),
        isError: false,
      };
    } catch (error) {
      const code = error instanceof ToolRefusal ? error.code : 'internal';
      if (!(error instanceof ToolRefusal)) {
        this.deps.app.log.warn({ err: error, tool: name }, 'agents: a hub tool failed');
      }
      record(false, code, lease);
      return refusal(code, error instanceof Error ? error.message : 'the tool failed');
    }
  }

  /** One request through the hub's own routes, as the run's principal. */
  private async inject(
    token: string,
    profile: string,
    language: string,
    method: 'GET' | 'POST' | 'PATCH',
    route: string,
    options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const search = query.toString();
    const response = await this.deps.app.inject({
      method,
      url: `${this.base}${route}${search ? `?${search}` : ''}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hub-profile': profile,
        'accept-language': language,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });
    const parsed: unknown = response.body ? safeJson(response.body) : null;
    if (response.statusCode >= 400) {
      const envelope = (parsed ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
      const reason =
        envelope.details && typeof envelope.details === 'object'
          ? (envelope.details as { reason?: unknown }).reason
          : undefined;
      throw new ToolRefusal(
        typeof envelope.code === 'string' ? envelope.code : `http_${response.statusCode}`,
        [typeof envelope.error === 'string' ? envelope.error : `HTTP ${response.statusCode}`]
          .concat(typeof reason === 'string' ? [`(${reason})`] : [])
          .join(' '),
      );
    }
    return parsed;
  }

  private record(
    workspaceId: string,
    tool: string,
    ok: boolean,
    errorCode: string | null,
    lease: { userId: string; sessionId: string; runId: string } | null,
    durationMs: number,
  ): void {
    const settings = this.row(workspaceId);
    this.deps.db
      .insert(hubToolCalls)
      .values({
        workspace: workspaceId,
        ownerId: lease?.userId ?? settings?.ownerId ?? workspaceId,
        tool: tool.slice(0, 80),
        ok,
        errorCode,
        userId: lease?.userId ?? null,
        sessionId: lease?.sessionId ?? null,
        runId: lease?.runId ?? null,
        durationMs: Math.max(0, Math.round(durationMs)),
      })
      .run();
    // Only the newest are kept: this is "what happened lately", not an audit trail.
    const old = this.deps.db
      .select({ id: hubToolCalls.id })
      .from(hubToolCalls)
      .where(eq(hubToolCalls.workspace, workspaceId))
      .orderBy(desc(hubToolCalls.createdAt), desc(hubToolCalls.id))
      .limit(1000)
      .offset(KEPT_CALLS)
      .all()
      .map((row) => row.id);
    if (old.length > 0) {
      this.deps.db.delete(hubToolCalls).where(inArray(hubToolCalls.id, old)).run();
    }
  }
}

function refusal(code: string, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
