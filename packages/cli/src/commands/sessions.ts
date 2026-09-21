// sessions list · new · show · delete
import type { CommandSpec } from '../args.js';
import { sessionTitle } from '../chat/transcript.js';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import type { Session, SessionDetail } from '../types.js';
import { formatTime, optionEnum, optionInteger, optionString, requireSession } from './shared.js';

export const sessionsListCommand: CommandSpec = {
  path: ['sessions', 'list'],
  description: 'cmd.sessions_list',
  options: {
    limit: { type: 'string', description: 'option.limit', value: 'N' },
    cursor: { type: 'string', description: 'option.cursor', value: 'CURSOR' },
    archived: { type: 'string', description: 'option.archived', value: 'true|false|all' },
    agent: { type: 'string', description: 'option.agent', value: 'ID' },
    q: { type: 'string', description: 'option.query', value: 'TEXT' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const limit = optionInteger(ctx, 'limit', 20, { min: 1, max: 100 });
    const archived = optionEnum(ctx, 'archived', ['true', 'false', 'all'] as const, 'false');
    const cursor = optionString(ctx, 'cursor');
    const agent = optionString(ctx, 'agent');
    const q = optionString(ctx, 'q');
    const { data } = await requireSession(ctx).client.request('get', '/sessions', {
      query: {
        limit,
        archived,
        ...(cursor ? { cursor } : {}),
        ...(agent ? { agent_id: agent } : {}),
        ...(q ? { q } : {}),
      },
    });
    if (ctx.globals.json) {
      ctx.out.json(data);
      return 0;
    }
    if (data.items.length === 0) {
      ctx.out.line(t('sessions.empty'));
      return 0;
    }
    ctx.out.table(
      [
        { key: 'id', label: t('sessions.id') },
        { key: 'title', label: t('sessions.title') },
        { key: 'agent', label: t('sessions.agent') },
        { key: 'status', label: t('sessions.status') },
        { key: 'messages', label: t('sessions.messages'), align: 'end' },
        { key: 'last', label: t('sessions.last') },
      ],
      (data.items as Session[]).map((session) => ({
        id: session.id,
        title: sessionTitle(session, t),
        agent: session.agent_id,
        status: session.status,
        messages: String(session.message_count),
        last: formatTime(session.last_message_at),
      })),
    );
    if (data.next_cursor)
      ctx.out.line(ctx.out.style.dim(t('sessions.more', { cursor: data.next_cursor })));
    return 0;
  },
};

export const sessionsNewCommand: CommandSpec = {
  path: ['sessions', 'new'],
  description: 'cmd.sessions_new',
  options: {
    agent: { type: 'string', description: 'option.agent', value: 'ID' },
    title: { type: 'string', description: 'option.title', value: 'TEXT' },
    'working-dir': { type: 'string', description: 'option.working_dir', value: 'PATH' },
    model: { type: 'string', description: 'option.model', value: 'MODEL' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const agent = optionString(ctx, 'agent');
    if (!agent) {
      throw new UsageError('usage.missing_argument', { name: '--agent' });
    }
    const title = optionString(ctx, 'title');
    const workingDir = optionString(ctx, 'working-dir');
    const model = optionString(ctx, 'model');
    const { data } = await requireSession(ctx).client.request('post', '/sessions', {
      body: {
        agent_id: agent,
        ...(title ? { title } : {}),
        ...(workingDir ? { working_dir: workingDir } : {}),
        ...(model ? { model } : {}),
      },
    });
    if (ctx.globals.json) ctx.out.json(data);
    else ctx.out.line(ctx.t('sessions.created', { id: data.id }));
    return 0;
  },
};

export const sessionsShowCommand: CommandSpec = {
  path: ['sessions', 'show'],
  description: 'cmd.sessions_show',
  positionals: [{ name: 'SESSION_ID', description: 'arg.session_id', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const { data } = await requireSession(ctx).client.request('get', '/sessions/{session_id}', {
      params: { session_id: ctx.positionals[0] ?? '' },
    });
    if (ctx.globals.json) ctx.out.json(data);
    else printSession(ctx, data);
    return 0;
  },
};

function printSession(ctx: CommandContext, session: SessionDetail): void {
  const { t } = ctx;
  const usage = session.usage
    ? `${session.usage.input_tokens} / ${session.usage.output_tokens}${session.usage.cost ? ` · ${session.usage.cost.amount} ${session.usage.cost.currency}` : ''}`
    : '—';
  ctx.out.kv([
    [t('sessions.id'), session.id],
    [t('sessions.title'), sessionTitle(session, t)],
    [t('sessions.agent'), session.agent_id],
    [
      t('sessions.status'),
      session.status + (session.active_run_id ? ` (${session.active_run_id})` : ''),
    ],
    [t('sessions.model'), session.model ?? '—'],
    [t('sessions.working_dir'), session.working_dir ?? '—'],
    [t('sessions.messages'), String(session.message_count)],
    [t('sessions.usage'), usage],
    [t('sessions.created_at'), formatTime(session.created_at)],
    [
      t('sessions.runs'),
      session.runs.length === 0
        ? t('sessions.none')
        : session.runs.map((run) => `${run.id} ${run.status}`).join('; '),
    ],
    [
      t('sessions.pending'),
      session.pending_approvals.length === 0
        ? t('sessions.none')
        : session.pending_approvals.map((a) => `${a.id} ${a.kind}: ${a.title}`).join('; '),
    ],
  ]);
}

export const sessionsDeleteCommand: CommandSpec = {
  path: ['sessions', 'delete'],
  description: 'cmd.sessions_delete',
  positionals: [{ name: 'SESSION_ID', description: 'arg.session_id', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const id = ctx.positionals[0] ?? '';
    await requireSession(ctx).client.request('delete', '/sessions/{session_id}', {
      params: { session_id: id },
    });
    if (ctx.globals.json) ctx.out.json({ id, deleted: true });
    else ctx.out.line(ctx.t('sessions.deleted', { id }));
    return 0;
  },
};
