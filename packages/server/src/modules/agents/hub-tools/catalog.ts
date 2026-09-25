/**
 * The hub's own tools, as an agent sees them (contract decision §47).
 *
 * **Every tool is a REST call the person could make.** A tool builds one request of the
 * contract from its arguments and sends it through the hub's own HTTP stack as the run's
 * principal (`ToolContext.call`): the same route, the same validation, the same permission
 * checks, the same `X-Hub-Profile` — the run's profile, which no argument can change. The
 * two exceptions have no REST operation to go through and are confined here instead:
 * `notifications.notify` writes a notice to the run's owner only, and the `files` tools read
 * and write under the profile's own folder only.
 *
 * Results are shortened to what an agent needs to act on (ids, titles, states); the REST
 * body in full would cost the model tokens and say nothing more it could use.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const HUB_TOOL_GROUPS = [
  'tasks',
  'schedules',
  'conversations',
  'notifications',
  'workflows',
  'files',
] as const;
export type HubToolGroup = (typeof HUB_TOOL_GROUPS)[number];
export type HubToolAccess = 'read' | 'write';

/** A refusal in the hub's words: its error code and the sentence the route said. */
export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

export interface ToolContext {
  /** One request of the contract, as the run's principal, in the run's profile. */
  call(
    method: 'GET' | 'POST' | 'PATCH',
    route: string,
    options?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<unknown>;
  /** The profile's slug (what `schedules.list` is asked for). */
  profile: string;
  /** The Hermes agent whose tools these are: a new schedule runs it unless told otherwise. */
  agentId: string | null;
  /** The folder of the profile's work: `${DATA_DIR}/workspaces/<profile>`. */
  filesRoot: string;
  /** A notice in the run owner's inbox, in this profile. */
  notify(title: string, body: string | null): void;
  timezone: string;
}

export interface HubToolDefinition {
  name: string;
  group: HubToolGroup;
  access: HubToolAccess;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

// ------------------------------------------------------------------ arguments

const LIMIT = { type: 'integer', minimum: 1, maximum: 50, description: 'At most this many (20).' };
const ID = (what: string) => ({ type: 'string', minLength: 1, description: `The ${what}'s id.` });

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolRefusal('validation_failed', `${key} must be text`);
  return value;
}

function need(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value || value.trim() === '') {
    throw new ToolRefusal('validation_failed', `${key} is required`);
  }
  return value;
}

function limitOf(args: Record<string, unknown>, fallback = 20, max = 50): number {
  const value = args.limit;
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolRefusal('validation_failed', 'limit must be a positive whole number');
  }
  return Math.min(value, max);
}

/** A path segment in a URL: an id is never allowed to become `../other`. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

function pick<T extends Record<string, unknown>>(row: unknown, keys: readonly string[]): T {
  const source = (row ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out as T;
}

function items(body: unknown): unknown[] {
  const list = (body as { items?: unknown } | null)?.items;
  return Array.isArray(list) ? list : [];
}

const TASK_KEYS = [
  'id',
  'title',
  'status',
  'priority',
  'assignee',
  'tags',
  'due_at',
  'blocked_reason',
  'updated_at',
] as const;
const SCHEDULE_KEYS = [
  'id',
  'name',
  'enabled',
  'trigger',
  'next_run_at',
  'last_run_at',
  'last_status',
] as const;
const SESSION_KEYS = [
  'id',
  'title',
  'source',
  'preview',
  'message_count',
  'archived',
  'last_message_at',
] as const;

const TASK_STATUSES = [
  'triage',
  'todo',
  'ready',
  'scheduled',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
];

// ------------------------------------------------------------------ files

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST = 500;

/**
 * A path under the profile's folder, or a refusal. The same rule as a session's working
 * folder (`sessions/working-dir.ts`): resolved against the root's real path, and a symbolic
 * link anywhere on the way is refused rather than followed out of it.
 */
export function confined(root: string, requested: string | undefined): string {
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  const raw = (requested ?? '.').trim() || '.';
  if (raw.includes('\0')) throw new ToolRefusal('validation_failed', 'path is not a path');
  const target = path.resolve(realRoot, raw.replace(/^\/+/, ''));
  if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
    throw new ToolRefusal('path_outside_profile', "that path is outside the profile's folder");
  }
  let walked = realRoot;
  for (const part of path.relative(realRoot, target).split(path.sep).filter(Boolean)) {
    walked = path.join(walked, part);
    try {
      if (lstatSync(walked).isSymbolicLink()) {
        throw new ToolRefusal('path_outside_profile', 'links are not followed');
      }
    } catch (error) {
      if (error instanceof ToolRefusal) throw error;
      break; // the rest does not exist yet: nothing further to follow
    }
  }
  return target;
}

function relative(root: string, target: string): string {
  return path.relative(realpathSync(root), target) || '.';
}

// ------------------------------------------------------------------ the tools

export const HUB_TOOLS: readonly HubToolDefinition[] = [
  // ---------------------------------------------------------------- tasks
  {
    name: 'tasks.list',
    group: 'tasks',
    access: 'read',
    description: "List tasks on this profile's board, newest first; filter by status or words.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: TASK_STATUSES },
        query: { type: 'string', maxLength: 200, description: 'Words in the title or brief.' },
        limit: LIMIT,
      },
    },
    async run(ctx, args) {
      const body = await ctx.call('GET', '/tasks', {
        query: { status: str(args, 'status'), q: str(args, 'query'), limit: limitOf(args) },
      });
      return { tasks: items(body).map((row) => pick(row, TASK_KEYS)) };
    },
  },
  {
    name: 'tasks.create',
    group: 'tasks',
    access: 'write',
    description: "Create a task on this profile's board.",
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 300 },
        description: { type: 'string' },
        status: { type: 'string', enum: ['triage', 'todo', 'ready'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        tags: { type: 'array', items: { type: 'string' } },
        due_at: { type: 'string', description: 'ISO 8601 date and time.' },
      },
    },
    async run(ctx, args) {
      const body = await ctx.call('POST', '/tasks', {
        body: {
          title: need(args, 'title'),
          ...(str(args, 'description') !== undefined
            ? { description: str(args, 'description') }
            : {}),
          ...(str(args, 'status') ? { status: str(args, 'status') } : {}),
          ...(str(args, 'priority') ? { priority: str(args, 'priority') } : {}),
          ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
          ...(str(args, 'due_at') ? { due_at: str(args, 'due_at') } : {}),
        },
      });
      return { task: pick(body, TASK_KEYS) };
    },
  },
  {
    name: 'tasks.move',
    group: 'tasks',
    access: 'write',
    description: 'Move a task to another column. `blocked` needs a reason.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'status'],
      properties: {
        task_id: ID('task'),
        status: { type: 'string', enum: TASK_STATUSES },
        reason: { type: 'string', description: 'Why it is blocked.' },
        summary: { type: 'string', description: 'A note for review or done.' },
      },
    },
    async run(ctx, args) {
      const body = await ctx.call('POST', `/tasks/${seg(need(args, 'task_id'))}/move`, {
        body: {
          status: need(args, 'status'),
          ...(str(args, 'reason') !== undefined ? { reason: str(args, 'reason') } : {}),
          ...(str(args, 'summary') !== undefined ? { summary: str(args, 'summary') } : {}),
        },
      });
      return { task: pick(body, TASK_KEYS) };
    },
  },
  {
    name: 'tasks.assign',
    group: 'tasks',
    access: 'write',
    description:
      'Give a task to an agent. With start=true the agent starts on it at once in a conversation of its own.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'agent_id'],
      properties: {
        task_id: ID('task'),
        agent_id: ID('agent'),
        instructions: { type: 'string', maxLength: 8000 },
        start: { type: 'boolean' },
      },
    },
    async run(ctx, args) {
      return ctx.call('POST', `/tasks/${seg(need(args, 'task_id'))}/assign`, {
        body: {
          agent_id: need(args, 'agent_id'),
          ...(str(args, 'instructions') !== undefined
            ? { instructions: str(args, 'instructions') }
            : {}),
          start: args.start === true,
        },
      });
    },
  },
  {
    name: 'tasks.comment',
    group: 'tasks',
    access: 'write',
    description: 'Add a comment to a task.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'content'],
      properties: {
        task_id: ID('task'),
        content: { type: 'string', minLength: 1, maxLength: 8000 },
      },
    },
    async run(ctx, args) {
      const body = await ctx.call('POST', `/tasks/${seg(need(args, 'task_id'))}/comments`, {
        body: { content: need(args, 'content') },
      });
      return { comment: pick(body, ['id', 'content', 'created_at']) };
    },
  },
  // ---------------------------------------------------------------- schedules
  {
    name: 'schedules.list',
    group: 'schedules',
    access: 'read',
    description: "List this profile's schedules with their next and last run.",
    inputSchema: { type: 'object', properties: { limit: LIMIT } },
    async run(ctx, args) {
      const body = await ctx.call('GET', '/schedules', {
        query: { profile: ctx.profile, limit: limitOf(args) },
      });
      return { schedules: items(body).map((row) => pick(row, SCHEDULE_KEYS)) };
    },
  },
  {
    name: 'schedules.create',
    group: 'schedules',
    access: 'write',
    description:
      'Schedule a prompt for an agent (this one unless agent_id says otherwise). Give exactly one of cron (5 fields), every_minutes or run_at.',
    inputSchema: {
      type: 'object',
      required: ['name', 'prompt'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        prompt: { type: 'string', minLength: 1 },
        cron: { type: 'string', description: 'Five-field cron expression.' },
        every_minutes: { type: 'integer', minimum: 1 },
        run_at: { type: 'string', description: 'ISO 8601 date and time, once.' },
        timezone: { type: 'string', description: 'IANA zone; the hub’s own when omitted.' },
        agent_id: ID('agent'),
      },
    },
    async run(ctx, args) {
      const cron = str(args, 'cron');
      const runAt = str(args, 'run_at');
      const every = args.every_minutes;
      const given = [cron !== undefined, runAt !== undefined, every !== undefined].filter(Boolean);
      if (given.length !== 1) {
        throw new ToolRefusal(
          'validation_failed',
          'give exactly one of cron, every_minutes or run_at',
        );
      }
      if (every !== undefined && (typeof every !== 'number' || !Number.isInteger(every))) {
        throw new ToolRefusal('validation_failed', 'every_minutes must be a whole number');
      }
      const body = await ctx.call('POST', '/schedules', {
        body: {
          name: need(args, 'name'),
          trigger: {
            kind: cron !== undefined ? 'cron' : runAt !== undefined ? 'once' : 'interval',
            expression: cron ?? null,
            every_minutes: typeof every === 'number' ? every : null,
            run_at: runAt ?? null,
            timezone: str(args, 'timezone') ?? ctx.timezone,
          },
          target: {
            kind: 'agent_prompt',
            agent_id: str(args, 'agent_id') ?? ctx.agentId,
            prompt: need(args, 'prompt'),
            model: null,
            provider: null,
            skills: [],
            workflow_id: null,
            input: null,
          },
          enabled: true,
        },
      });
      return { schedule: pick(body, SCHEDULE_KEYS) };
    },
  },
  {
    name: 'schedules.pause',
    group: 'schedules',
    access: 'write',
    description: 'Pause a schedule, or resume it with paused=false.',
    inputSchema: {
      type: 'object',
      required: ['schedule_id'],
      properties: { schedule_id: ID('schedule'), paused: { type: 'boolean' } },
    },
    async run(ctx, args) {
      const body = await ctx.call('PATCH', `/schedules/${seg(need(args, 'schedule_id'))}`, {
        body: { enabled: args.paused === false },
      });
      return { schedule: pick(body, SCHEDULE_KEYS) };
    },
  },
  {
    name: 'schedules.run_now',
    group: 'schedules',
    access: 'write',
    description: 'Run a schedule now, once, without changing its times.',
    inputSchema: {
      type: 'object',
      required: ['schedule_id'],
      properties: { schedule_id: ID('schedule') },
    },
    async run(ctx, args) {
      return ctx.call('POST', `/schedules/${seg(need(args, 'schedule_id'))}/run`);
    },
  },
  // ---------------------------------------------------------------- conversations
  {
    name: 'conversations.list',
    group: 'conversations',
    access: 'read',
    description: 'List the conversations in this profile, most recent first.',
    inputSchema: { type: 'object', properties: { limit: LIMIT } },
    async run(ctx, args) {
      const body = await ctx.call('GET', '/sessions', { query: { limit: limitOf(args) } });
      return { conversations: items(body).map((row) => pick(row, SESSION_KEYS)) };
    },
  },
  {
    name: 'conversations.search',
    group: 'conversations',
    access: 'read',
    description: 'Find conversations in this profile by words in their title or messages.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: LIMIT },
    },
    async run(ctx, args) {
      const body = await ctx.call('GET', '/sessions', {
        query: { q: need(args, 'query'), limit: limitOf(args), archived: 'all' },
      });
      return { conversations: items(body).map((row) => pick(row, SESSION_KEYS)) };
    },
  },
  {
    name: 'conversations.summary',
    group: 'conversations',
    access: 'read',
    description: 'Read a conversation: its title, size and its latest messages (10 unless asked).',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: ID('conversation'),
        messages: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    async run(ctx, args) {
      const id = seg(need(args, 'session_id'));
      const count =
        typeof args.messages === 'number' && Number.isInteger(args.messages)
          ? Math.min(Math.max(args.messages, 1), 50)
          : 10;
      const session = await ctx.call('GET', `/sessions/${id}`);
      const page = await ctx.call('GET', `/sessions/${id}/messages`, { query: { limit: count } });
      return {
        conversation: pick(session, SESSION_KEYS),
        messages: items(page).map((row) => {
          const message = row as { role?: unknown; content?: unknown; created_at?: unknown };
          const text = typeof message.content === 'string' ? message.content : '';
          return {
            role: message.role,
            text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
            created_at: message.created_at,
          };
        }),
      };
    },
  },
  // ---------------------------------------------------------------- notifications
  {
    name: 'notifications.notify',
    group: 'notifications',
    access: 'write',
    description:
      'Tell the person this run is for: a notice in their inbox (and on their devices, as their notification settings allow).',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', maxLength: 2000 },
      },
    },
    async run(ctx, args) {
      const title = need(args, 'title');
      if (title.length > 200) throw new ToolRefusal('validation_failed', 'title is too long');
      const body = str(args, 'body') ?? null;
      if (body && body.length > 2000) {
        throw new ToolRefusal('validation_failed', 'body is too long');
      }
      ctx.notify(title, body);
      return { notified: true };
    },
  },
  // ---------------------------------------------------------------- workflows
  {
    name: 'workflows.list',
    group: 'workflows',
    access: 'read',
    description: "List this profile's workflows.",
    inputSchema: { type: 'object', properties: { limit: LIMIT } },
    async run(ctx, args) {
      const body = await ctx.call('GET', '/workflows', { query: { limit: limitOf(args) } });
      return {
        workflows: items(body).map((row) =>
          pick(row, ['id', 'name', 'description', 'enabled', 'updated_at']),
        ),
      };
    },
  },
  {
    name: 'workflows.run',
    group: 'workflows',
    access: 'write',
    description: 'Run a workflow, with an optional input its steps read as {{input}}.',
    inputSchema: {
      type: 'object',
      required: ['workflow_id'],
      properties: { workflow_id: ID('workflow'), input: { type: 'string' } },
    },
    async run(ctx, args) {
      return ctx.call('POST', `/workflows/${seg(need(args, 'workflow_id'))}/run`, {
        body: { input: str(args, 'input') ?? null },
      });
    },
  },
  // ---------------------------------------------------------------- files
  {
    name: 'files.list',
    group: 'files',
    access: 'read',
    description: "List a folder of this profile's work (its root unless path says otherwise).",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative to the profile folder.' } },
    },
    async run(ctx, args) {
      const target = confined(ctx.filesRoot, str(args, 'path'));
      let names: string[];
      try {
        names = readdirSync(target).sort();
      } catch {
        throw new ToolRefusal('not_found', 'no such folder');
      }
      return {
        path: relative(ctx.filesRoot, target),
        entries: names.slice(0, MAX_LIST).map((name) => {
          const entry = lstatSync(path.join(target, name));
          return {
            name,
            type: entry.isDirectory() ? 'folder' : entry.isSymbolicLink() ? 'link' : 'file',
            size: entry.isFile() ? entry.size : null,
          };
        }),
        truncated: names.length > MAX_LIST,
      };
    },
  },
  {
    name: 'files.read',
    group: 'files',
    access: 'read',
    description: "Read a text file of this profile's work (up to 1 MB).",
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: 'Relative to the profile folder.' } },
    },
    async run(ctx, args) {
      const target = confined(ctx.filesRoot, need(args, 'path'));
      let size: number;
      try {
        const stat = statSync(target);
        if (!stat.isFile()) throw new Error('not a file');
        size = stat.size;
      } catch {
        throw new ToolRefusal('not_found', 'no such file');
      }
      if (size > MAX_READ_BYTES) throw new ToolRefusal('file_too_large', 'the file is over 1 MB');
      const bytes = readFileSync(target);
      if (bytes.includes(0)) throw new ToolRefusal('file_not_text', 'the file is not text');
      return { path: relative(ctx.filesRoot, target), content: bytes.toString('utf8') };
    },
  },
  {
    name: 'files.write',
    group: 'files',
    access: 'write',
    description: "Write a text file in this profile's work, making its folders; replaces it.",
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'Relative to the profile folder.' },
        content: { type: 'string' },
      },
    },
    async run(ctx, args) {
      const target = confined(ctx.filesRoot, need(args, 'path'));
      const content = str(args, 'content') ?? '';
      if (Buffer.byteLength(content) > MAX_READ_BYTES) {
        throw new ToolRefusal('file_too_large', 'the content is over 1 MB');
      }
      if (target === realpathSync(ctx.filesRoot)) {
        throw new ToolRefusal('validation_failed', 'name a file, not the folder');
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      return { path: relative(ctx.filesRoot, target), bytes: Buffer.byteLength(content) };
    },
  },
];

/** The tools a group carries, in the catalog's order. */
export function toolsOf(group: HubToolGroup): HubToolDefinition[] {
  return HUB_TOOLS.filter((tool) => tool.group === group);
}

export function findTool(name: string): HubToolDefinition | null {
  return HUB_TOOLS.find((tool) => tool.name === name) ?? null;
}
