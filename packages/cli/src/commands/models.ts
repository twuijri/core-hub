/**
 * providers list · add · test · remove, and models list · default.
 *
 * A key is never a command-line argument (`args.ts` §SECRET_OPTIONS refuses `--token` and
 * friends for the same reason): it would land in the shell history and in `ps`. `providers
 * add` reads it from the prompt, hidden, or from stdin when stdout is a pipe — so a script
 * can do `printf '%s' "$KEY" | majlis providers add anthropic`.
 */
import type { CommandSpec } from '../args.js';
import type { CommandContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { Model, ModelDefaults, ModelRef, Provider } from '../types.js';
import { optionString, requireSession } from './shared.js';

/** The provider a person named, by slug or by id. A miss lists what there is. */
function findProvider(providers: Provider[], needle: string): Provider {
  const found = providers.find((p) => p.slug === needle || p.id === needle);
  if (found) return found;
  throw new CliError('models.unknown_provider', {
    provider: needle,
    known: providers.map((p) => p.slug).join(', '),
  });
}

async function loadProviders(ctx: CommandContext): Promise<Provider[]> {
  const { data } = await requireSession(ctx).client.request('get', '/models/providers');
  return data.items as Provider[];
}

function configured(provider: Provider): boolean {
  return provider.auth.kind === 'none' || provider.api_key !== null;
}

export const providersListCommand: CommandSpec = {
  path: ['providers', 'list'],
  description: 'cmd.providers_list',
  options: { kind: { type: 'string', description: 'option.provider_kind', value: 'KIND' } },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const kind = optionString(ctx, 'kind');
    if (kind && !['llm', 'stt', 'tts'].includes(kind)) {
      throw new UsageError('usage.invalid_option', { option: '--kind', value: kind });
    }
    const providers = (await loadProviders(ctx)).filter((p) => !kind || p.kind === kind);
    if (ctx.globals.json) {
      ctx.out.json({ items: providers });
      return 0;
    }
    if (providers.length === 0) {
      ctx.out.line(t('models.providers_empty'));
      return 0;
    }
    ctx.out.table(
      [
        { key: 'slug', label: t('models.slug') },
        { key: 'label', label: t('models.label') },
        { key: 'kind', label: t('models.kind') },
        { key: 'key', label: t('models.key') },
        { key: 'models', label: t('models.count') },
      ],
      providers.map((provider) => ({
        slug: provider.slug,
        label: provider.label,
        kind: provider.kind,
        // Never the value, and never a length: only whether one is stored.
        key: t(
          provider.auth.kind === 'none'
            ? 'models.key_not_needed'
            : configured(provider)
              ? 'models.key_stored'
              : 'models.key_missing',
        ),
        models: String(provider.models.length),
      })),
    );
    return 0;
  },
};

export const providersAddCommand: CommandSpec = {
  path: ['providers', 'add'],
  description: 'cmd.providers_add',
  positionals: [{ name: 'PROVIDER', description: 'arg.provider', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const provider = findProvider(await loadProviders(ctx), ctx.positionals[0] ?? '');
    if (provider.auth.kind === 'none') {
      ctx.out.line(t('models.key_not_needed'));
      return 0;
    }
    // Hidden prompt on a terminal; a piped line when it is a script. Either way the key
    // never reaches argv (`args.ts` §SECRET_OPTIONS).
    const key = await ctx.prompter.ask(t('models.prompt_key', { provider: provider.slug }), {
      hidden: true,
    });
    if (key === null || key.trim() === '') throw new CliError('errors.interrupted');

    const { data } = await requireSession(ctx).client.request(
      'patch',
      '/models/providers/{provider_id}',
      { params: { provider_id: provider.id }, body: { api_key: key.trim() } },
    );
    const saved = data as Provider;
    if (ctx.globals.json) {
      ctx.out.json(saved);
      return 0;
    }
    ctx.out.line(t('models.key_saved', { provider: saved.slug }));
    // The point of the module, said once where the person just did the work.
    ctx.out.notice(ctx.out.style.dim(t('models.shared_note')));
    return 0;
  },
};

export const providersTestCommand: CommandSpec = {
  path: ['providers', 'test'],
  description: 'cmd.providers_test',
  positionals: [{ name: 'PROVIDER', description: 'arg.provider', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const provider = findProvider(await loadProviders(ctx), ctx.positionals[0] ?? '');
    const { data } = await requireSession(ctx).client.request(
      'post',
      '/models/providers/{provider_id}/test',
      { params: { provider_id: provider.id } },
    );
    const outcome = data as { ok: boolean; message: string | null; duration_ms: number };
    if (ctx.globals.json) {
      ctx.out.json(outcome);
    } else {
      const line = `${outcome.message ?? ''} (${String(outcome.duration_ms)} ms)`.trim();
      if (outcome.ok) ctx.out.line(line);
      else ctx.out.error(line);
    }
    // A provider that does not answer is a failed command, so `&&` in a script stops.
    return outcome.ok ? 0 : 1;
  },
};

export const providersRemoveCommand: CommandSpec = {
  path: ['providers', 'remove'],
  description: 'cmd.providers_remove',
  positionals: [{ name: 'PROVIDER', description: 'arg.provider', required: true }],
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const provider = findProvider(await loadProviders(ctx), ctx.positionals[0] ?? '');
    const client = requireSession(ctx).client;
    if (provider.builtin) {
      // A built-in provider is part of the catalogue: clearing its key is the removal.
      await client.request('patch', '/models/providers/{provider_id}', {
        params: { provider_id: provider.id },
        body: { api_key: '' },
      });
      ctx.out.line(t('models.key_cleared', { provider: provider.slug }));
      return 0;
    }
    await client.request('delete', '/models/providers/{provider_id}', {
      params: { provider_id: provider.id },
    });
    ctx.out.line(t('models.provider_removed', { provider: provider.slug }));
    return 0;
  },
};

export const modelsListCommand: CommandSpec = {
  path: ['models', 'list'],
  description: 'cmd.models_list',
  options: {
    provider: { type: 'string', description: 'option.provider', value: 'SLUG' },
    kind: { type: 'string', description: 'option.model_kind', value: 'KIND' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const client = requireSession(ctx).client;
    const query: Record<string, string | number> = { limit: 200 };
    const slug = optionString(ctx, 'provider');
    if (slug) query.provider_id = findProvider(await loadProviders(ctx), slug).id;
    const kind = optionString(ctx, 'kind');
    if (kind) query.kind = kind;

    const { data } = await client.request('get', '/models', { query });
    const items = (data as { items: Model[] }).items;
    if (ctx.globals.json) {
      ctx.out.json(data);
      return 0;
    }
    if (items.length === 0) {
      ctx.out.line(t('models.empty'));
      return 0;
    }
    ctx.out.table(
      [
        { key: 'key', label: t('models.model') },
        { key: 'kind', label: t('models.kind') },
        { key: 'context', label: t('models.context') },
      ],
      items.map((model) => ({
        key: model.alias ? `${model.key} (${model.alias})` : model.key,
        kind: model.kind,
        context: model.context_window === null ? '—' : String(model.context_window),
      })),
    );
    return 0;
  },
};

export const modelsDefaultCommand: CommandSpec = {
  path: ['models', 'default'],
  description: 'cmd.models_default',
  positionals: [{ name: 'MODEL', description: 'arg.model_key', required: false }],
  options: { role: { type: 'string', description: 'option.role', value: 'ROLE' } },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const client = requireSession(ctx).client;
    const target = ctx.positionals[0];
    const role = optionString(ctx, 'role') ?? 'chat';

    if (!target) {
      const { data } = await client.request('get', '/models/defaults');
      const defaults = data as ModelDefaults;
      if (ctx.globals.json) {
        ctx.out.json(defaults);
        return 0;
      }
      const providers = await loadProviders(ctx);
      const show = (ref: ModelRef | null | undefined): string =>
        ref ? `${providers.find((p) => p.id === ref.provider_id)?.slug ?? '?'}/${ref.model}` : '—';
      const rows: [string, string][] = [[t('models.role_chat'), show(defaults.default)]];
      for (const task of defaults.auxiliary.tasks) {
        rows.push([
          task.label[ctx.language === 'ar' ? 'ar' : 'en'],
          show(defaults.auxiliary.assignments[task.key]),
        ]);
      }
      ctx.out.kv(rows);
      return 0;
    }

    // `anthropic/claude-sonnet-4-5` — the contract's `Model.key`.
    const slash = target.indexOf('/');
    if (slash <= 0) throw new UsageError('usage.invalid_argument', { value: target });
    const providers = await loadProviders(ctx);
    const provider = findProvider(providers, target.slice(0, slash));
    const ref: ModelRef = { provider_id: provider.id, model: target.slice(slash + 1) };
    const body = role === 'chat' ? { default: ref } : { assignments: { [role]: ref } };
    const { data } = await client.request('put', '/models/defaults', { body });
    if (ctx.globals.json) ctx.out.json(data);
    else ctx.out.line(t('models.default_set', { role, model: target }));
    return 0;
  },
};
