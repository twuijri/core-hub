// agents list · get · install · remove
import type { CommandSpec } from '../args.js';
import type { CommandContext } from '../context.js';
import type { Agent } from '../types.js';
import { optionEnum, requireSession } from './shared.js';

const KINDS = ['hermes', 'acp', 'harness', 'builtin'] as const;

export const agentsListCommand: CommandSpec = {
  path: ['agents', 'list'],
  description: 'cmd.agents_list',
  options: { kind: { type: 'string', description: 'option.kind', value: 'KIND' } },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const kind =
      ctx.options.kind === undefined ? undefined : optionEnum(ctx, 'kind', KINDS, 'hermes');
    const { data } = await requireSession(ctx).client.request('get', '/agents', {
      ...(kind ? { query: { kind } } : {}),
    });
    if (ctx.globals.json) {
      ctx.out.json(data);
      return 0;
    }
    if (data.items.length === 0) {
      ctx.out.line(t('agents.empty'));
      return 0;
    }
    ctx.out.table(
      [
        { key: 'id', label: t('agents.id') },
        { key: 'slug', label: t('agents.slug') },
        { key: 'name', label: t('agents.name') },
        { key: 'kind', label: t('agents.kind') },
        { key: 'status', label: t('agents.status') },
        { key: 'version', label: t('agents.version') },
      ],
      data.items.map((agent) => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        kind: agent.kind,
        status: agent.status,
        version: agent.install.version ?? '—',
      })),
    );
    return 0;
  },
};

export const agentsGetCommand: CommandSpec = {
  path: ['agents', 'get'],
  description: 'cmd.agents_get',
  positionals: [{ name: 'AGENT_ID', description: 'arg.agent_id', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const { data } = await requireSession(ctx).client.request('get', '/agents/{agent_id}', {
      params: { agent_id: ctx.positionals[0] ?? '' },
    });
    if (ctx.globals.json) ctx.out.json(data);
    else printAgent(ctx, data);
    return 0;
  },
};

function printAgent(ctx: CommandContext, agent: Agent): void {
  const { t } = ctx;
  const model = agent.default_model
    ? `${agent.default_model.model} (${agent.default_model.provider_id})`
    : '—';
  ctx.out.kv([
    [t('agents.id'), agent.id],
    [t('agents.slug'), agent.slug],
    [t('agents.name'), agent.name],
    [t('agents.vendor'), agent.vendor ?? '—'],
    [t('agents.kind'), agent.kind],
    [t('agents.status'), agent.status],
    [t('agents.enabled'), t(agent.enabled ? 'common.yes' : 'common.no')],
    [
      t('agents.install'),
      `${agent.install.source} ${agent.install.version ?? ''} ${agent.install.path ?? ''}`.trim(),
    ],
    [
      t('agents.runtime'),
      agent.runtime.state + (agent.runtime.error ? ` — ${agent.runtime.error}` : ''),
    ],
    [t('agents.capabilities'), agent.capabilities.join(', ') || '—'],
    [t('agents.default_model'), model],
  ]);
}

const jobCommand = (
  path: readonly string[],
  description: string,
  method: 'post' | 'delete',
): CommandSpec => ({
  path,
  description,
  positionals: [{ name: 'AGENT_ID', description: 'arg.agent_id', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const params = { agent_id: ctx.positionals[0] ?? '' };
    const client = requireSession(ctx).client;
    const { data } =
      method === 'post'
        ? await client.request('post', '/agents/{agent_id}/install', { params })
        : await client.request('delete', '/agents/{agent_id}/install', { params });
    if (ctx.globals.json) ctx.out.json(data);
    else ctx.out.line(ctx.t('agents.job', { job_id: data.job_id }));
    return 0;
  },
});

export const agentsInstallCommand = jobCommand(['agents', 'install'], 'cmd.agents_install', 'post');
export const agentsRemoveCommand = jobCommand(['agents', 'remove'], 'cmd.agents_remove', 'delete');
