/**
 * The Models screen: where a provider key is typed, once (ADR 0010).
 *
 * The tabs are the navigation manifest's (`general`, `auxiliary`, `ensembles`,
 * `stt_providers`, `tts_providers`). Two rules run through every control here:
 *
 * - a key is write-only. The field shows `[stored]` as a placeholder and is empty; the
 *   screen never receives the value, so it cannot echo it;
 * - nothing is silent. A test says what the provider answered, a provider with no key
 *   says so, and the agents list underneath says which agents inherit the defaults.
 */
import { useState } from 'react';
import { NavLink } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { navigation, routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import type { Agent, Model, Provider } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';
import {
  parseRef,
  refValue,
  useCatalogue,
  useCreateProvider,
  useDeleteProvider,
  useModelDefaults,
  useProviders,
  useRefreshProvider,
  useSaveDefaults,
  useSaveProvider,
  useSpeechSettings,
  useTestProvider,
  type ModelRef,
  type TestResult,
} from './queries.js';

/** Which provider kind each tab shows. `general` and `auxiliary` are the chat side. */
const KIND_OF_TAB: Record<string, 'llm' | 'stt' | 'tts'> = {
  general: 'llm',
  stt_providers: 'stt',
  tts_providers: 'tts',
};

export function ModelsScreen() {
  const { t } = useI18n();
  const title = t(termKey('models'));
  const tabs = navigation.destinations.find((d) => d.id === 'models')?.tabs ?? ['general'];
  const [tab, setTab] = useState<string>(tabs[0] ?? 'general');
  const providers = useProviders();

  return (
    <AppShell title={title} wide>
      <h1 className="sr-only">{title}</h1>
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
              providers={providers.data.filter((p) => p.kind === (KIND_OF_TAB[tab] ?? 'llm'))}
              kind={KIND_OF_TAB[tab] ?? 'llm'}
            />
          )}
        </section>
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------- providers

function ProvidersTab({ providers, kind }: { providers: Provider[]; kind: 'llm' | 'stt' | 'tts' }) {
  const { t } = useI18n();
  const speech = useSpeechSettings();
  const side = kind === 'stt' ? speech.data?.stt : kind === 'tts' ? speech.data?.tts : undefined;

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
      <ul className="grid gap-3 md:grid-cols-2" data-testid="provider-list">
        {providers.map((provider) => (
          <li key={provider.id}>
            <ProviderCard provider={provider} />
          </li>
        ))}
      </ul>
      {providers.length === 0 && <Notice>{t('models.providers.empty')}</Notice>}
      {kind === 'llm' && <AddProvider />}
    </>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  const { t } = useI18n();
  const save = useSaveProvider();
  const test = useTestProvider();
  const refresh = useRefreshProvider();
  const remove = useDeleteProvider();
  const [draft, setDraft] = useState('');
  const [outcome, setOutcome] = useState<TestResult | null>(null);
  const stored = provider.api_key !== null;
  const needsKey = provider.auth.kind === 'api_key';
  const fieldId = `provider-key-${provider.id}`;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setOutcome(null);
    await save.mutateAsync({ id: provider.id, api_key: draft.trim() });
    // The value leaves this component the moment it is saved; nothing keeps it.
    setDraft('');
  };

  return (
    <article className="card flex flex-col gap-2" data-provider-slug={provider.slug}>
      <header className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold" dir="auto">
            {provider.label}
          </h3>
          <p className="truncate text-xs text-muted" dir="ltr">
            {provider.base_url ?? provider.slug}
          </p>
        </div>
        <span className={`chip ${stored ? 'bg-success-soft text-success-soft-text' : ''}`}>
          {t(
            !needsKey
              ? 'models.provider.no_key_needed'
              : stored
                ? 'models.provider.configured'
                : 'models.provider.not_configured',
          )}
        </span>
      </header>

      {provider.catalogue.error && <Notice tone="danger">{provider.catalogue.error}</Notice>}

      {needsKey && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void submit(e)}>
          <div className="min-w-0 flex-1">
            <label className="block text-xs text-muted" htmlFor={fieldId}>
              {t('models.provider.key')}
            </label>
            <input
              id={fieldId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              // The stored value is never sent to a client, so the field starts empty
              // and says what is already there instead of pretending to hold it.
              placeholder={stored ? t('models.provider.key_stored') : t('models.provider.key_hint')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="field"
              data-testid="provider-key"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !draft}>
            {t('models.provider.save_key')}
          </button>
          {stored && (
            <button
              type="button"
              className="btn"
              disabled={save.isPending}
              onClick={() => void save.mutateAsync({ id: provider.id, api_key: '' })}
            >
              {t('models.provider.clear_key')}
            </button>
          )}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
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
        {provider.catalogue.refreshable && (
          <button
            type="button"
            className="btn"
            disabled={refresh.isPending || !stored}
            onClick={() => refresh.mutate(provider.id)}
          >
            {t('models.provider.refresh')}
          </button>
        )}
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
        {!provider.builtin && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate(provider.id)}
          >
            {t('models.provider.remove')}
          </button>
        )}
      </div>

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

      <p className="text-xs text-muted">
        {t('models.provider.model_count', { count: provider.models.length })}
      </p>
    </article>
  );
}

function AddProvider() {
  const { t } = useI18n();
  const create = useCreateProvider();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn mt-3" onClick={() => setOpen(true)}>
        {t('models.provider.add')}
      </button>
    );
  }
  return (
    <form
      className="card mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { label: label.trim(), kind: 'llm', base_url: baseUrl.trim() },
          {
            onSuccess: () => {
              setOpen(false);
              setLabel('');
              setBaseUrl('');
            },
          },
        );
      }}
    >
      <h3 className="font-semibold">{t('models.provider.add')}</h3>
      <label className="text-xs text-muted" htmlFor="new-provider-label">
        {t('models.provider.label')}
      </label>
      <input
        id="new-provider-label"
        className="field"
        dir="auto"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        required
      />
      <label className="text-xs text-muted" htmlFor="new-provider-url">
        {t('models.provider.base_url')}
      </label>
      <input
        id="new-provider-url"
        className="field"
        dir="ltr"
        placeholder="http://127.0.0.1:11434/v1"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        required
      />
      {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          {t('common.save')}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
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
