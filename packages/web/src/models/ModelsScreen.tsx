/**
 * The Models screen: the providers this workspace **added**, and one way to add another.
 *
 * Owner direction, 2026-09-22: the old screen was a grid of every provider the hub knows,
 * each with its own key box, and he found it scattered. Now the list is what he
 * configured; everything the hub *can* talk to lives behind "Add provider" (contract
 * decision §26).
 *
 * The rules that run through every control here:
 * - a key is write-only. The field shows `[stored]` as a placeholder and is empty; the
 *   screen never receives the value, so it cannot echo it;
 * - a key is never refused. "Key optional" means the hub does not demand one, not that
 *   the field disappears — the 2026-09-22 defect was a card badged "No key needed" that
 *   also said "Missing API key", with nowhere to type one;
 * - nothing is silent. A test says what the provider answered, a loopback address on a
 *   containerized hub says so, and the agents list underneath says what each inherited.
 */
import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { navigation, routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import type { Agent, Model, Provider, ProviderHost } from '../types.js';
import { SettingsBack } from '../settings/SettingsBack.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { AddProviderDialog } from './AddProviderDialog.js';
import { needsLoopbackWarning, suggestedHostUrl } from './loopback.js';
import {
  parseRef,
  refValue,
  useCatalogue,
  useDeleteProvider,
  useModelDefaults,
  useProviderPresets,
  useProviders,
  useRefreshProvider,
  useSaveDefaults,
  useSaveModel,
  useSaveProvider,
  useSpeechSettings,
  useTestProvider,
  type ModelRef,
  type TestResult,
} from './queries.js';

/** Which provider kind each speech tab shows. `general` shows everything configured. */
const KIND_OF_TAB: Record<string, 'llm' | 'stt' | 'tts'> = {
  stt_providers: 'stt',
  tts_providers: 'tts',
};

export function ModelsScreen() {
  const { t } = useI18n();
  const title = t(termKey('models'));
  const tabs = navigation.destinations.find((d) => d.id === 'models')?.tabs ?? ['general'];
  const [tab, setTab] = useState<string>(tabs[0] ?? 'general');
  const providers = useProviders();
  const presets = useProviderPresets();
  const refresh = useRefreshProvider();
  const [adding, setAdding] = useState(false);

  const configured = providers.data ?? [];
  const refreshAll = () => {
    for (const provider of configured) {
      if (provider.catalogue.refreshable && provider.enabled) refresh.mutate(provider.id);
    }
  };

  return (
    <AppShell title={title} wide>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        {/* The two header actions NAVIGATION §3 puts on `General`, and only there. */}
        {tab === 'general' && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn"
              disabled={configured.length === 0 || refresh.isPending}
              onClick={refreshAll}
              data-testid="refresh-all"
            >
              {t('models.refresh_all')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAdding(true)}
              data-testid="open-add-provider"
            >
              {t('models.provider.add')}
            </button>
          </div>
        )}
      </header>

      <nav
        className="mb-4 flex flex-wrap gap-1 border-b border-line pb-2"
        aria-label={title}
        data-testid="models-tabs"
      >
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            data-tab-id={id}
            className={`rounded-md px-3 py-1 text-sm ${
              tab === id ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2'
            }`}
          >
            {t(`models.tab.${id}`)}
          </button>
        ))}
      </nav>

      {providers.isPending && <Spinner label={t('common.loading')} />}
      {providers.isError && <Notice tone="danger">{describeError(providers.error, t)}</Notice>}
      {providers.data && (
        <section aria-live="polite">
          {tab === 'auxiliary' ? (
            <DefaultsTab />
          ) : tab === 'ensembles' ? (
            <Notice>{t('models.ensembles.hint')}</Notice>
          ) : (
            <ProvidersTab
              providers={providers.data}
              tab={tab}
              host={presets.data?.host}
              onAdd={() => setAdding(true)}
            />
          )}
        </section>
      )}

      {adding && (
        <AddProviderDialog
          presets={presets.data?.items ?? []}
          host={presets.data?.host}
          taken={new Set(configured.map((provider) => provider.slug))}
          onClose={() => setAdding(false)}
        />
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------- providers

function ProvidersTab({
  providers,
  tab,
  host,
  onAdd,
}: {
  providers: Provider[];
  tab: string;
  host: ProviderHost | undefined;
  onAdd(): void;
}) {
  const { t } = useI18n();
  const speech = useSpeechSettings();
  const defaults = useModelDefaults();
  const kindOfTab = KIND_OF_TAB[tab];
  const side =
    kindOfTab === 'stt' ? speech.data?.stt : kindOfTab === 'tts' ? speech.data?.tts : undefined;
  const [filter, setFilter] = useState<'all' | 'llm' | 'stt' | 'tts'>('all');

  // The speech tabs are about one kind; the providers tab is the whole list, with the
  // filter the owner asked for.
  const shown = useMemo(() => {
    if (kindOfTab) return providers.filter((provider) => provider.kind === kindOfTab);
    return filter === 'all' ? providers : providers.filter((provider) => provider.kind === filter);
  }, [providers, kindOfTab, filter]);

  return (
    <>
      <p className="mb-3 text-sm text-muted">{t('models.providers.hint')}</p>
      {side && !side.ready && side.reason && (
        // The hub sends a sentence in the request's language (`models/index.ts`
        // §localiseSpeech), so it is shown as it arrived.
        <Notice tone="warning" className="mb-3">
          {side.reason}
        </Notice>
      )}
      {!kindOfTab && providers.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted" htmlFor="provider-filter">
            {t('models.filter')}
          </label>
          <select
            id="provider-filter"
            className="field max-w-60"
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            data-testid="provider-filter"
          >
            <option value="all">{t('models.filter_all')}</option>
            <option value="llm">{t('models.tab.general')}</option>
            <option value="stt">{t('models.tab.stt_providers')}</option>
            <option value="tts">{t('models.tab.tts_providers')}</option>
          </select>
        </div>
      )}
      <ul className="grid gap-3 lg:grid-cols-2" data-testid="provider-list">
        {shown.map((provider) => (
          <li key={provider.id}>
            <ProviderCard
              provider={provider}
              host={host}
              isDefault={defaults.data?.default?.provider_id === provider.id}
              defaultModel={
                defaults.data?.default?.provider_id === provider.id
                  ? defaults.data.default.model
                  : null
              }
            />
          </li>
        ))}
      </ul>
      {shown.length === 0 && (
        <div className="flex flex-col items-start gap-2">
          <Notice>
            {t(providers.length === 0 ? 'models.providers.none' : 'models.providers.empty')}
          </Notice>
          {providers.length === 0 && (
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              {t('models.provider.add')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

const MODEL_CHIPS = 6;

function ProviderCard({
  provider,
  host,
  isDefault,
  defaultModel,
}: {
  provider: Provider;
  host: ProviderHost | undefined;
  isDefault: boolean;
  defaultModel: string | null;
}) {
  const { t } = useI18n();
  const save = useSaveProvider();
  const test = useTestProvider();
  const refresh = useRefreshProvider();
  const remove = useDeleteProvider();
  const saveDefaults = useSaveDefaults();
  const [outcome, setOutcome] = useState<TestResult | null>(null);
  const [panel, setPanel] = useState<'none' | 'edit' | 'models'>('none');
  const stored = provider.api_key !== null;
  // `auth.kind: none` is "no key required" — never "no key accepted" (contract §26).
  const keyRequired = provider.auth.kind === 'api_key';
  const warn = needsLoopbackWarning(provider.base_url ?? '', host);

  return (
    <article className="card flex flex-col gap-2" data-provider-slug={provider.slug}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold" dir="auto">
            {provider.label}
          </h3>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="chip">
              {t(provider.builtin ? 'models.badge.builtin' : 'models.badge.custom')}
            </span>
            {isDefault && (
              <span className="chip bg-accent-soft text-accent-soft-text">
                {t('models.badge.default')}
              </span>
            )}
            <span className={`chip ${stored ? 'bg-success-soft text-success-soft-text' : ''}`}>
              {t(
                stored
                  ? 'models.provider.configured'
                  : keyRequired
                    ? 'models.provider.not_configured'
                    : 'models.provider.key_optional',
              )}
            </span>
            {!provider.enabled && <span className="chip">{t('models.badge.disabled')}</span>}
          </div>
        </div>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">{t('models.row.provider')}</dt>
        <dd className="truncate" dir="ltr">
          {provider.slug}
        </dd>
        <dt className="text-muted">{t('models.provider.base_url')}</dt>
        <dd className="truncate" dir="ltr">
          {provider.base_url ?? '—'}
        </dd>
        <dt className="text-muted">{t('models.row.models')}</dt>
        <dd>{provider.models.length}</dd>
      </dl>

      {warn && host && (
        <Notice tone="warning">
          <span data-testid="card-loopback-warning">
            {t('models.add.loopback', { url: suggestedHostUrl(provider.base_url ?? '', host) })}
          </span>
        </Notice>
      )}
      {provider.catalogue.error && <Notice tone="danger">{provider.catalogue.error}</Notice>}

      {provider.models.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid="model-chips">
          {provider.models.slice(0, MODEL_CHIPS).map((model) => (
            <li key={model.key} className="chip" dir="ltr">
              {model.alias ?? model.model}
            </li>
          ))}
          {provider.models.length > MODEL_CHIPS && (
            <li className="chip">
              {t('models.more_models', { count: provider.models.length - MODEL_CHIPS })}
            </li>
          )}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted" htmlFor={`default-model-${provider.id}`}>
          {t('models.add.default_model')}
        </label>
        <select
          id={`default-model-${provider.id}`}
          className="field max-w-72"
          value={defaultModel ?? ''}
          disabled={provider.models.length === 0 || saveDefaults.isPending}
          onChange={(event) => {
            const model = event.target.value;
            saveDefaults.mutate({
              default: model ? { provider_id: provider.id, model } : null,
            });
          }}
          data-testid="card-default-model"
        >
          <option value="">{t('models.defaults.none')}</option>
          {provider.models.map((model) => (
            <option key={model.key} value={model.model}>
              {model.alias ?? model.model}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={provider.models.length === 0 || saveDefaults.isPending || isDefault}
          onClick={() => {
            const first = provider.models[0];
            if (first) {
              saveDefaults.mutate({ default: { provider_id: provider.id, model: first.model } });
            }
          }}
        >
          {t('models.action.set_default')}
        </button>
        <button type="button" className="btn" onClick={() => setPanel('models')}>
          {t('models.action.display_names')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setPanel('models')}
          data-testid="manage-visible"
        >
          {t('models.action.visible_models')}
        </button>
        {provider.catalogue.refreshable && (
          <button
            type="button"
            className="btn"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(provider.id)}
            data-testid="provider-refresh"
          >
            {t('models.provider.refresh')}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={test.isPending}
          onClick={() => {
            setOutcome(null);
            test.mutate(provider.id, { onSuccess: setOutcome });
          }}
          data-testid="provider-test"
        >
          {t('models.provider.test')}
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={panel === 'edit'}
          onClick={() => setPanel(panel === 'edit' ? 'none' : 'edit')}
          data-testid="provider-edit"
        >
          {t('models.action.edit')}
        </button>
        {stored && (
          <button
            type="button"
            className="btn"
            disabled={save.isPending}
            onClick={() => void save.mutateAsync({ id: provider.id, api_key: '' })}
            data-testid="provider-clear-key"
          >
            {t('models.action.clear_credentials')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate(provider.id)}
          data-testid="provider-remove"
        >
          {t('models.provider.remove')}
        </button>
      </div>

      {panel === 'edit' && <EditPanel provider={provider} onDone={() => setPanel('none')} />}
      {panel === 'models' && <ModelsPanel provider={provider} onDone={() => setPanel('none')} />}

      {test.isPending && <Spinner label={t('models.provider.testing')} />}
      {outcome && (
        <div data-testid="provider-test-result">
          <Notice tone={outcome.ok ? 'success' : 'danger'}>
            {outcome.message ?? t(outcome.ok ? 'models.test.ok' : 'models.test.http_error')}
            {` (${String(outcome.duration_ms)} ms)`}
          </Notice>
        </div>
      )}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      {remove.isError && <Notice tone="danger">{describeError(remove.error, t)}</Notice>}
    </article>
  );
}

/** Name, address, key and enablement — everything about the provider row itself. */
function EditPanel({ provider, onDone }: { provider: Provider; onDone(): void }) {
  const { t } = useI18n();
  const save = useSaveProvider();
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? '');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const stored = provider.api_key !== null;
  const fieldId = `provider-key-${provider.id}`;

  return (
    <form
      className="flex flex-col gap-2 border-t border-line pt-2"
      data-testid="provider-edit-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void save
          .mutateAsync({
            id: provider.id,
            label: label.trim(),
            base_url: baseUrl.trim() || null,
            // Only sent when something was typed: an empty field means "leave it", and
            // clearing is the explicit button.
            ...(key.trim() ? { api_key: key.trim() } : {}),
          })
          .then(() => {
            setKey('');
            onDone();
          });
      }}
    >
      <label className="text-xs text-muted" htmlFor={`provider-label-${provider.id}`}>
        {t('models.provider.label')}
      </label>
      <input
        id={`provider-label-${provider.id}`}
        className="field"
        dir="auto"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <label className="text-xs text-muted" htmlFor={`provider-url-${provider.id}`}>
        {t('models.provider.base_url')}
      </label>
      <input
        id={`provider-url-${provider.id}`}
        className="field"
        dir="ltr"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
      />
      <label className="text-xs text-muted" htmlFor={fieldId}>
        {/* Always here, for every provider: "optional" is not "refused". */}
        {t(
          provider.auth.kind === 'api_key' ? 'models.add.key_required' : 'models.add.key_optional',
        )}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={fieldId}
          className="field"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          // The stored value is never sent to a client, so the field starts empty and
          // says what is already there instead of pretending to hold it.
          placeholder={stored ? t('models.provider.key_stored') : t('models.provider.key_hint')}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          data-testid="provider-key"
        />
        <button
          type="button"
          className="btn"
          aria-pressed={showKey}
          onClick={() => setShowKey((shown) => !shown)}
        >
          {t(showKey ? 'models.add.hide_key' : 'models.add.show_key')}
        </button>
      </div>
      <label className="flex items-center gap-1 text-sm">
        <input
          type="checkbox"
          checked={provider.enabled}
          onChange={(event) =>
            void save.mutateAsync({ id: provider.id, enabled: event.target.checked })
          }
        />
        {t('models.provider.enabled')}
      </label>
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {t('common.save')}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * Display names and visible models, which are the same two columns of one table:
 * `models.putModel` carries the alias, `models.updateProvider` carries the visibility.
 */
function ModelsPanel({ provider, onDone }: { provider: Provider; onDone(): void }) {
  const { t } = useI18n();
  const saveModel = useSaveModel();
  const saveProvider = useSaveProvider();
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const visible = new Set(
    provider.visibility.mode === 'include'
      ? provider.visibility.models
      : provider.models.map((model) => model.model),
  );

  if (provider.models.length === 0) {
    return (
      <div className="border-t border-line pt-2">
        <Notice>{t('models.panel.no_models')}</Notice>
      </div>
    );
  }

  const toggle = (model: string, on: boolean) => {
    const next = new Set(visible);
    if (on) next.add(model);
    else next.delete(model);
    saveProvider.mutate({
      id: provider.id,
      // Once anything is hidden the list is explicit; showing everything goes back to
      // `all`, so a model the provider adds later is visible by default.
      visibility:
        next.size === provider.models.length
          ? { mode: 'all', models: [] }
          : { mode: 'include', models: [...next] },
    });
  };

  return (
    <div
      className="flex flex-col gap-2 border-t border-line pt-2"
      data-testid="provider-models-panel"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th className="text-start font-normal">{t('models.panel.model')}</th>
            <th className="text-start font-normal">{t('models.panel.alias')}</th>
            <th className="text-start font-normal">{t('models.panel.visible')}</th>
          </tr>
        </thead>
        <tbody>
          {provider.models.map((model) => (
            <tr key={model.key}>
              <td className="truncate pe-2" dir="ltr">
                {model.model}
              </td>
              <td className="pe-2">
                <input
                  className="field"
                  dir="auto"
                  aria-label={t('models.panel.alias_for', { model: model.model })}
                  value={aliases[model.model] ?? model.alias ?? ''}
                  onChange={(event) =>
                    setAliases((current) => ({ ...current, [model.model]: event.target.value }))
                  }
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next === (model.alias ?? '')) return;
                    saveModel.mutate({
                      provider_id: provider.id,
                      model: model.model,
                      alias: next || null,
                    });
                  }}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={t('models.panel.visible_for', { model: model.model })}
                  checked={visible.has(model.model)}
                  onChange={(event) => toggle(model.model, event.target.checked)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {saveModel.isError && <Notice tone="danger">{describeError(saveModel.error, t)}</Notice>}
      {saveProvider.isError && (
        <Notice tone="danger">{describeError(saveProvider.error, t)}</Notice>
      )}
      <div>
        <button type="button" className="btn" onClick={onDone}>
          {t('models.panel.done')}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- defaults

function DefaultsTab() {
  const { t, language } = useI18n();
  const defaults = useModelDefaults();
  const catalogue = useCatalogue();
  const providers = useProviders();
  const agents = useAgents();
  const save = useSaveDefaults();

  if (defaults.isPending || catalogue.isPending) return <Spinner label={t('common.loading')} />;
  if (defaults.isError) return <Notice tone="danger">{describeError(defaults.error, t)}</Notice>;
  if (catalogue.isError) return <Notice tone="danger">{describeError(catalogue.error, t)}</Notice>;

  const models = catalogue.data ?? [];
  if (models.length === 0) return <Notice>{t('models.defaults.no_models')}</Notice>;

  const tasks = defaults.data.auxiliary.tasks;
  const assignments = defaults.data.auxiliary.assignments as Record<string, ModelRef | undefined>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('models.defaults.hint')}</p>
      <ModelSelect
        id="default-chat"
        label={t('models.defaults.chat')}
        models={models}
        value={refValue(defaults.data.default)}
        onChange={(ref) => save.mutate({ default: ref })}
      />
      {tasks.map((task) => (
        <ModelSelect
          key={task.key}
          id={`default-${task.key}`}
          label={task.label[language === 'ar' ? 'ar' : 'en']}
          models={models}
          value={refValue(assignments[task.key])}
          onChange={(ref) => save.mutate({ assignments: { [task.key]: ref } })}
        />
      ))}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}

      <section className="mt-2 border-t border-line pt-3">
        <h3 className="mb-2 text-sm font-medium">{t('models.defaults.inheriting')}</h3>
        <p className="mb-2 text-xs text-muted">{t('models.defaults.inheriting_hint')}</p>
        {agents.isError && <Notice tone="danger">{describeError(agents.error, t)}</Notice>}
        <ul className="flex flex-col gap-1 text-sm" data-testid="inheriting-agents">
          {(agents.data ?? []).map((agent: Agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-2">
              <NavLink to={routeOf('agent_manager')} className="link underline" dir="auto">
                {agent.name}
              </NavLink>
              <span className="chip" dir="ltr">
                {agent.default_model
                  ? labelOf(models, agent.default_model, providers.data ?? [])
                  : t('models.defaults.none')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function labelOf(models: Model[], ref: ModelRef, providers: Provider[]): string {
  const model = models.find((m) => m.provider_id === ref.provider_id && m.model === ref.model);
  if (model) return model.alias ?? model.key;
  const provider = providers.find((p) => p.id === ref.provider_id);
  return provider ? `${provider.slug}/${ref.model}` : ref.model;
}

function ModelSelect({
  id,
  label,
  models,
  value,
  onChange,
}: {
  id: string;
  label: string;
  models: Model[];
  value: string;
  onChange(ref: ModelRef | null): void;
}) {
  const { t } = useI18n();
  const groups = new Map<string, Model[]>();
  for (const model of models) {
    if (model.kind !== 'chat') continue;
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="min-w-40 text-sm" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={value}
        onChange={(event) => onChange(parseRef(event.target.value))}
        data-testid={id}
      >
        <option value="">{t('models.defaults.none')}</option>
        {[...groups.entries()].map(([provider, list]) => (
          <optgroup key={provider} label={provider}>
            {list.map((model) => (
              <option key={model.key} value={refValue(model)}>
                {model.alias ?? model.model}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
