/**
 * providers presets · list · add · test · remove, and models list · default.
 *
 * A key is never a command-line argument (`args.ts` §SECRET_OPTIONS refuses `--token` and
 * friends for the same reason): it would land in the shell history and in `ps`. `providers
 * add` reads it from the prompt, hidden, or from stdin when stdout is a pipe — so a script
 * can do `printf '%s' "$KEY" | corehub providers add anthropic`.
 *
 * Two rules the web client obeys too (contract decision §26):
 * - `providers list` shows the providers this workspace **added**; `providers presets`
 *   shows what can be added, local model servers included.
 * - a key is *never refused*. A provider whose preset says `key: optional` is added and
 *   used without one, and the prompt still lets a key be typed for it — a local proxy
 *   behind a master key is ordinary. Only the endpoint's own answer may say a key is
 *   missing.
 */
import type { CommandSpec } from '../args.js';
import type { CommandContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type {
  Model,
  ModelDefaults,
  ModelRef,
  Provider,
  ProviderHost,
  ProviderPreset,
} from '../types.js';
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

async function loadPresets(
  ctx: CommandContext,
): Promise<{ items: ProviderPreset[]; host: ProviderHost }> {
  const { data } = await requireSession(ctx).client.request('get', '/models/provider-presets');
  return data as { items: ProviderPreset[]; host: ProviderHost };
}

/** `127.0.0.1` inside a container is the container. Say so; never rewrite what was typed. */
function warnIfLoopback(ctx: CommandContext, url: string, host: ProviderHost): void {
  if (!host.containerized || !isLoopback(url)) return;
  ctx.out.notice(
    ctx.out.style.dim(
      ctx.t('models.loopback_warning', { alias: host.loopback_alias, url: suggestHost(url, host) }),
    ),
  );
}

export function isLoopback(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/** The same URL with the container-to-host alias in place of loopback, as a suggestion. */
export function suggestHost(url: string, host: ProviderHost): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = host.loopback_alias;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
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
        { key: 'base_url', label: t('models.base_url') },
        { key: 'key', label: t('models.key') },
        { key: 'models', label: t('models.count') },
      ],
      providers.map((provider) => ({
        slug: provider.slug,
        label: provider.label,
        kind: provider.kind,
        base_url: provider.base_url ?? '—',
        // Never the value, and never a length: only whether one is stored — and for a
        // provider that does not require one, that it is optional rather than missing.
        key:
          provider.api_key !== null
            ? t('models.key_stored')
            : t(provider.auth.kind === 'none' ? 'models.key_optional' : 'models.key_missing'),
        models: String(provider.models.length),
      })),
    );
    return 0;
  },
};

export const providersPresetsCommand: CommandSpec = {
  path: ['providers', 'presets'],
  description: 'cmd.providers_presets',
  options: { kind: { type: 'string', description: 'option.provider_kind', value: 'KIND' } },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const kind = optionString(ctx, 'kind');
    if (kind && !['llm', 'stt', 'tts'].includes(kind)) {
      throw new UsageError('usage.invalid_option', { option: '--kind', value: kind });
    }
    const { items, host } = await loadPresets(ctx);
    const presets = items.filter((preset) => !kind || preset.kind === kind);
    if (ctx.globals.json) {
      ctx.out.json({ items: presets, host });
      return 0;
    }
    ctx.out.table(
      [
        { key: 'id', label: t('models.preset') },
        { key: 'label', label: t('models.label') },
        { key: 'kind', label: t('models.kind') },
        { key: 'key', label: t('models.key') },
        { key: 'base_url', label: t('models.base_url') },
      ],
      presets.map((preset) => ({
        id: preset.id,
        label: preset.label,
        kind: preset.kind,
        key: t(preset.key === 'required' ? 'models.key_required' : 'models.key_optional'),
        base_url: preset.base_url ?? t('models.base_url_needed'),
      })),
    );
    if (host.containerized) ctx.out.notice(ctx.out.style.dim(t('models.container_note')));
    return 0;
  },
};

export const providersAddCommand: CommandSpec = {
  path: ['providers', 'add'],
  description: 'cmd.providers_add',
  positionals: [{ name: 'PROVIDER', description: 'arg.provider_or_preset', required: true }],
  options: {
    'base-url': { type: 'string', description: 'option.base_url', value: 'URL' },
    name: { type: 'string', description: 'option.provider_name', value: 'NAME' },
    'no-key': { type: 'boolean', description: 'option.no_key' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const needle = ctx.positionals[0] ?? '';
    const client = requireSession(ctx).client;
    const existing = (await loadProviders(ctx)).find((p) => p.slug === needle || p.id === needle);

    // Already added: this is "give it a key" — allowed for every provider, including the
    // ones that do not require one (the defect of 2026-09-22).
    if (existing) {
      const key = await askKey(ctx, existing.slug, existing.auth.kind === 'api_key');
      if (key === null) {
        ctx.out.line(t('models.key_unchanged', { provider: existing.slug }));
        return 0;
      }
      const { data } = await client.request('patch', '/models/providers/{provider_id}', {
        params: { provider_id: existing.id },
        body: { api_key: key },
      });
      const saved = data as Provider;
      if (ctx.globals.json) ctx.out.json(saved);
      else {
        ctx.out.line(t('models.key_saved', { provider: saved.slug }));
        ctx.out.notice(ctx.out.style.dim(t('models.shared_note')));
      }
      return 0;
    }

    const { items, host } = await loadPresets(ctx);
    const preset = items.find((item) => item.id === needle);
    if (!preset) {
      throw new CliError('models.unknown_preset', {
        provider: needle,
        known: items.map((item) => item.id).join(', '),
      });
    }

    const baseUrl = optionString(ctx, 'base-url') ?? preset.base_url ?? '';
    if (!baseUrl) throw new CliError('models.base_url_required', { provider: preset.id });
    warnIfLoopback(ctx, baseUrl, host);

    const key = await askKey(ctx, preset.id, preset.key === 'required');
    if (preset.key === 'required' && !key)
      throw new CliError('models.key_required_for', {
        provider: preset.id,
      });

    const { data } = await client.request('post', '/models/providers', {
      body: {
        preset: preset.id,
        label: optionString(ctx, 'name') ?? preset.label,
        kind: preset.kind,
        base_url: baseUrl,
        // The hub takes the mode from the preset; the generated type still wants the
        // field, and the OpenAI-shaped one is the only mode a client here would pick.
        api_mode:
          preset.api_mode === 'responses' ? ('responses' as const) : ('chat_completions' as const),
        ...(key ? { api_key: key } : {}),
      },
    });
    const added = data as Provider;
    if (ctx.globals.json) {
      ctx.out.json(added);
      return 0;
    }
    ctx.out.line(t('models.provider_added', { provider: added.slug, url: added.base_url ?? '' }));
    // The model list is fetched as a job; `providers list` shows the count once it lands.
    ctx.out.notice(ctx.out.style.dim(t('models.shared_note')));
    return 0;
  },
};

/**
 * The key, hidden on a terminal and piped in a script. `null` means "leave it alone":
 * an empty answer is a skip, never an error, unless the provider says it needs one.
 */
async function askKey(
  ctx: CommandContext,
  provider: string,
  required: boolean,
): Promise<string | null> {
  if (ctx.options['no-key'] === true) return null;
  const answer = await ctx.prompter.ask(
    ctx.t(required ? 'models.prompt_key' : 'models.prompt_key_optional', { provider }),
    { hidden: true },
  );
  if (answer === null) throw new CliError('errors.interrupted');
  const key = answer.trim();
  return key === '' ? null : key;
}

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
  options: { 'clear-key': { type: 'boolean', description: 'option.clear_key' } },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const provider = findProvider(await loadProviders(ctx), ctx.positionals[0] ?? '');
    const client = requireSession(ctx).client;
    if (ctx.options['clear-key'] === true) {
      // Keep the provider, forget its credentials — the "Clear credentials" of the UI.
      await client.request('patch', '/models/providers/{provider_id}', {
        params: { provider_id: provider.id },
        body: { api_key: '' },
      });
      ctx.out.line(t('models.key_cleared', { provider: provider.slug }));
      return 0;
    }
    // What a person added, a person removes — preset or custom alike.
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
