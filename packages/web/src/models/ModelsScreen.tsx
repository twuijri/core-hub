/**
 * The Models screen: the providers the hub **added** — one list, shared by every profile
 * (contract decision §34) — and one way to add another.
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
import { NavLink, useSearchParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { canOpen, navigation, routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { useProfileName } from '../shell/profiles.js';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Checkbox,
  Combobox,
  EmptyState,
  Field,
  Input,
  Label,
  Radio,
  ScrollArea,
  Segmented,
  Select,
  Separator,
  Skeleton,
  SkeletonGroup,
  Switch,
  Table,
  useToast,
} from '../ui/index.js';
import { IconModels } from '../ui/icons.js';
import { modelOption, useRecentModels } from './useModelPicker.js';
import type { Agent, Model, Provider, ProviderHost } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { AddProviderDialog } from './AddProviderDialog.js';
import { FallbackList } from './FallbackList.js';
import { SignInPanel } from './SignInPanel.js';
import { RuntimeCard } from './RuntimeChecks.js';
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
  useRuntimeReport,
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
  // `?tab=` lets another screen link at one of these tabs by name — the run-failed notice
  // sends the person to Defaults, and landing on Providers would make them hunt for it.
  // An unknown value is ignored rather than showing an empty screen.
  const [search] = useSearchParams();
  const asked = search.get('tab');
  const [tab, setTab] = useState<string>(
    asked && tabs.includes(asked) ? asked : (tabs[0] ?? 'general'),
  );
  const providers = useProviders();
  const presets = useProviderPresets();
  const refresh = useRefreshProvider();
  const runtime = useRuntimeReport();
  const [adding, setAdding] = useState(false);
  const { profile } = useAuth();
  const profileName = useProfileName();

  const configured = providers.data ?? [];
  const refreshAll = () => {
    for (const provider of configured) {
      if (provider.catalogue.refreshable && provider.enabled) refresh.mutate(provider.id);
    }
  };

  return (
    <AppShell title={title}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        {/* The two header actions NAVIGATION §3 puts on `General`, and only there. */}
        {tab === 'general' && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={configured.length === 0 || refresh.isPending}
              onClick={refreshAll}
              data-testid="refresh-all"
            >
              {t('models.refresh_all')}
            </Button>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              data-testid="open-add-provider"
            >
              {t('models.provider.add')}
            </Button>
          </div>
        )}
      </header>

      {/* Whether any of this reached the agent runtime. Shown on `General`, next to the
          providers it is about, and only once a provider exists to be propagated —
          before that there is nothing to have failed. */}
      {tab === 'general' && configured.length > 0 && runtime.data && (
        <RuntimeCard report={runtime.data} />
      )}

      <Segmented
        className="mb-4"
        label={title}
        value={tab}
        onChange={setTab}
        wrap
        testId="models-tabs"
        options={tabs.map((id) => ({
          value: id,
          label: t(`models.tab.${id}`),
          itemProps: { 'data-tab-id': id },
        }))}
      />

      {providers.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <div className="grid gap-3 lg:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} height="16rem" radius="md" />
            ))}
          </div>
        </SkeletonGroup>
      )}
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
          taken={{
            all: new Set(configured.filter((p) => p.scope === 'all').map((p) => p.slug)),
            profile: new Set(configured.filter((p) => p.scope === 'profile').map((p) => p.slug)),
          }}
          profileName={profileName(profile)}
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
          <span className="text-xs text-muted">{t('models.filter')}</span>
          <Select
            value={filter}
            onValueChange={(next) => setFilter((next ?? 'all') as typeof filter)}
            label={t('models.filter')}
            testId="provider-filter"
            options={[
              { value: 'all', label: t('models.filter_all') },
              { value: 'llm', label: t('models.tab.general') },
              { value: 'stt', label: t('models.tab.stt_providers') },
              { value: 'tts', label: t('models.tab.tts_providers') },
            ]}
          />
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
        <EmptyState
          icon={<IconModels size={20} />}
          title={t(providers.length === 0 ? 'models.providers.none' : 'models.providers.empty')}
          {...(providers.length === 0
            ? {
                action: (
                  <Button variant="primary" onClick={onAdd}>
                    {t('models.provider.add')}
                  </Button>
                ),
              }
            : {})}
        />
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
  const profileName = useProfileName();
  const save = useSaveProvider();
  const test = useTestProvider();
  const refresh = useRefreshProvider();
  const remove = useDeleteProvider();
  const saveDefaults = useSaveDefaults();
  const { recent, remember } = useRecentModels();
  const [outcome, setOutcome] = useState<TestResult | null>(null);
  const [panel, setPanel] = useState<'none' | 'edit' | 'models' | 'sign-in'>('none');
  // Removing a provider takes its key and its catalogue with it, so it asks first.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const stored = provider.api_key !== null;
  // `auth.kind: none` is "no key required" — never "no key accepted" (contract §26).
  const keyRequired = provider.auth.kind === 'api_key';
  // Used by signing in to an account, through Hermes (contract decision §50).
  const signIn = provider.auth.kind === 'oauth';
  const warn = needsLoopbackWarning(provider.base_url ?? '', host);

  return (
    <Card as="article" tone="raised" className="h-full" data-provider-slug={provider.slug}>
      <CardHeader
        title={provider.label}
        subtitle={provider.slug}
        actions={
          signIn ? (
            <Badge
              tone={provider.auth.signed_in ? 'success' : 'warning'}
              testId="provider-signed-in"
            >
              {t(provider.auth.signed_in ? 'models.signin.signed_in' : 'models.signin.signed_out')}
            </Badge>
          ) : (
            <Badge tone={stored ? 'success' : keyRequired ? 'warning' : 'neutral'}>
              {t(
                stored
                  ? 'models.provider.configured'
                  : keyRequired
                    ? 'models.provider.not_configured'
                    : 'models.provider.key_optional',
              )}
            </Badge>
          )
        }
      />
      <ul className="flex flex-wrap gap-1">
        <li data-scope={provider.scope}>
          {/* Who it is for (decision §37): every profile, or this one alone. */}
          <Badge tone={provider.scope === 'profile' ? 'accent' : 'neutral'} testId="provider-scope">
            {provider.scope === 'profile'
              ? t('models.provider.scope_only', { profile: profileName(provider.profile) })
              : t('models.provider.scope_shared')}
          </Badge>
        </li>
        <li>
          <Badge>{t(provider.builtin ? 'models.badge.builtin' : 'models.badge.custom')}</Badge>
        </li>
        {isDefault && (
          <li>
            <Badge tone="accent">{t('models.badge.default')}</Badge>
          </li>
        )}
        {!provider.enabled && (
          <li>
            <Badge tone="warning">{t('models.badge.disabled')}</Badge>
          </li>
        )}
      </ul>

      <dl className="provider-facts">
        <dt>{t('models.provider.base_url')}</dt>
        <dd dir="ltr">{provider.base_url ?? '—'}</dd>
        <dt>{t('models.row.models')}</dt>
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
            <li key={model.key} dir="ltr">
              <Badge>{model.alias ?? model.model}</Badge>
            </li>
          ))}
          {provider.models.length > MODEL_CHIPS && (
            <li>
              <Badge tone="info">
                {t('models.more_models', { count: provider.models.length - MODEL_CHIPS })}
              </Badge>
            </li>
          )}
        </ul>
      )}

      <div className="labelled-row">
        <span className="labelled-row-name text-xs text-muted">
          {t('models.add.default_model')}
        </span>
        <Combobox
          value={defaultModel ?? null}
          disabled={provider.models.length === 0 || saveDefaults.isPending}
          onChange={(model) => {
            remember(model);
            saveDefaults.mutate({
              default: model ? { provider_id: provider.id, model } : null,
            });
          }}
          label={t('models.add.default_model')}
          placeholder={t('models.defaults.none')}
          testId="card-default-model"
          recent={recent}
          options={provider.models.map((model) => modelOption(model, model.model))}
        />
      </div>

      <CardFooter>
        {signIn && (
          <Button
            variant={provider.auth.signed_in ? 'secondary' : 'primary'}
            aria-expanded={panel === 'sign-in'}
            onClick={() => setPanel(panel === 'sign-in' ? 'none' : 'sign-in')}
            data-testid="provider-sign-in"
          >
            {t(provider.auth.signed_in ? 'models.signin.again' : 'models.signin.action')}
          </Button>
        )}
        <Button
          disabled={provider.models.length === 0 || saveDefaults.isPending || isDefault}
          onClick={() => {
            const first = provider.models[0];
            if (first) {
              saveDefaults.mutate({ default: { provider_id: provider.id, model: first.model } });
            }
          }}
        >
          {t('models.action.set_default')}
        </Button>
        <Button onClick={() => setPanel('models')}>{t('models.action.display_names')}</Button>
        <Button onClick={() => setPanel('models')} data-testid="manage-visible">
          {t('models.action.visible_models')}
        </Button>
        {provider.catalogue.refreshable && (
          <Button
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(provider.id)}
            data-testid="provider-refresh"
          >
            {t('models.provider.refresh')}
          </Button>
        )}
        <Button
          loading={test.isPending}
          onClick={() => {
            setOutcome(null);
            test.mutate(provider.id, { onSuccess: setOutcome });
          }}
          data-testid="provider-test"
        >
          {t('models.provider.test')}
        </Button>
        <Button
          aria-expanded={panel === 'edit'}
          onClick={() => setPanel(panel === 'edit' ? 'none' : 'edit')}
          data-testid="provider-edit"
        >
          {t('models.action.edit')}
        </Button>
        {stored && (
          <Button
            disabled={save.isPending}
            onClick={() => void save.mutateAsync({ id: provider.id, api_key: '' })}
            data-testid="provider-clear-key"
          >
            {t('models.action.clear_credentials')}
          </Button>
        )}
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => setConfirmRemove(true)}
          data-testid="provider-remove"
        >
          {t('models.provider.remove')}
        </Button>
      </CardFooter>

      <AlertDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('models.provider.confirm_remove', { label: provider.label })}
        body={t('models.provider.confirm_remove_body')}
        confirmLabel={t('models.provider.remove')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          setConfirmRemove(false);
          remove.mutate(provider.id);
        }}
        testId="confirm-remove-provider"
      />

      {panel === 'edit' && <EditPanel provider={provider} onDone={() => setPanel('none')} />}
      {panel === 'models' && <ModelsPanel provider={provider} onDone={() => setPanel('none')} />}
      {panel === 'sign-in' && <SignInPanel provider={provider} onDone={() => setPanel('none')} />}

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
    </Card>
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

  return (
    <form
      className="provider-panel"
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
      <Field label={t('models.provider.label')}>
        {(props) => (
          <Input
            {...props}
            dir="auto"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('models.provider.base_url')}>
        {(props) => (
          <Input
            {...props}
            dir="ltr"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        )}
      </Field>
      {/* The key field is here for every provider: "optional" is not "refused". */}
      <Field
        label={t(
          provider.auth.kind === 'api_key' ? 'models.add.key_required' : 'models.add.key_optional',
        )}
      >
        {(props) => (
          <span className="field-row-inline">
            <Input
              {...props}
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
            <Button aria-pressed={showKey} onClick={() => setShowKey((shown) => !shown)}>
              {t(showKey ? 'models.add.hide_key' : 'models.add.show_key')}
            </Button>
          </span>
        )}
      </Field>
      {/* Enablement takes effect the moment it is flipped, which is what a switch is. */}
      <Switch
        checked={provider.enabled}
        onChange={(enabled) => void save.mutateAsync({ id: provider.id, enabled })}
        label={t('models.provider.enabled')}
        testId="provider-enabled"
      />
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={save.isPending}>
          {t('common.save')}
        </Button>
        <Button onClick={onDone}>{t('common.cancel')}</Button>
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
  const toast = useToast();
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const mode = provider.visibility.mode;
  const visible = new Set(
    mode === 'include' ? provider.visibility.models : provider.models.map((model) => model.model),
  );

  if (provider.models.length === 0) {
    return (
      <div className="provider-panel">
        <EmptyState size="sm" title={t('models.panel.no_models')} />
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
    <div className="provider-panel" data-testid="provider-models-panel">
      {/* The mode was only ever reachable by ticking every box; saying it out loud makes
          "show everything, including whatever the provider adds later" one click. */}
      <Radio
        label={t('models.panel.visibility')}
        value={mode}
        testId="visibility-mode"
        onChange={(next) =>
          saveProvider.mutate({
            id: provider.id,
            visibility:
              next === 'all'
                ? { mode: 'all', models: [] }
                : { mode: 'include', models: [...visible] },
          })
        }
        options={[
          {
            value: 'all',
            label: t('models.panel.visibility_all'),
            hint: t('models.panel.visibility_all_hint'),
          },
          {
            value: 'include',
            label: t('models.panel.visibility_include'),
            hint: t('models.panel.visibility_include_hint'),
          },
        ]}
      />
      <ScrollArea maxHeight="22rem">
        <Table
          caption={t('models.panel.caption', { provider: provider.label })}
          testId="provider-models-table"
          rows={provider.models}
          rowKey={(model) => model.key}
          columns={[
            {
              key: 'model',
              header: t('models.panel.model'),
              cell: (model) => (
                <span dir="ltr" className="font-mono text-xs">
                  {model.model}
                </span>
              ),
            },
            {
              key: 'alias',
              header: t('models.panel.alias'),
              cell: (model) => (
                <Input
                  inputSize="sm"
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
                    toast({ title: t('models.panel.alias_saved'), tone: 'success' });
                  }}
                />
              ),
            },
            {
              key: 'visible',
              header: t('models.panel.visible'),
              cell: (model) => (
                <Checkbox
                  label={t('models.panel.visible_for', { model: model.model })}
                  labelHidden
                  checked={visible.has(model.model)}
                  onChange={(next) => toggle(model.model, next)}
                />
              ),
            },
          ]}
        />
      </ScrollArea>
      {saveModel.isError && <Notice tone="danger">{describeError(saveModel.error, t)}</Notice>}
      {saveProvider.isError && (
        <Notice tone="danger">{describeError(saveProvider.error, t)}</Notice>
      )}
      <div>
        <Button onClick={onDone}>{t('models.panel.done')}</Button>
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
  const { user } = useAuth();
  // A member sees the names; only whoever may open the Agents page gets a link to it.
  const canManage = canOpen('agent_manager', user?.role ?? 'member');

  if (defaults.isPending || catalogue.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height="2.5rem" radius="md" />
        ))}
      </SkeletonGroup>
    );
  if (defaults.isError) return <Notice tone="danger">{describeError(defaults.error, t)}</Notice>;
  if (catalogue.isError) return <Notice tone="danger">{describeError(catalogue.error, t)}</Notice>;

  const models = catalogue.data ?? [];
  if (models.length === 0)
    return <EmptyState icon={<IconModels size={20} />} title={t('models.defaults.no_models')} />;

  const tasks = defaults.data.auxiliary.tasks;
  const assignments = defaults.data.auxiliary.assignments as Record<string, ModelRef | undefined>;
  // Roles this profile left alone show the default profile's choice, and say so (contract
  // decision §34). Choosing one here makes it this profile's own.
  const inherited = new Set(defaults.data.inherited ?? []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('models.defaults.hint')}</p>
      <ModelSelect
        id="default-chat"
        label={t('models.defaults.chat')}
        models={models}
        value={refValue(defaults.data.default)}
        inherited={inherited.has('default')}
        onChange={(ref) => save.mutate({ default: ref })}
      />
      <FallbackList
        chain={defaults.data.fallbacks}
        primary={defaults.data.default ?? null}
        models={models}
        disabled={save.isPending}
        onChange={(fallbacks) =>
          // A chain is the profile's own with its chat model: an inherited model is saved
          // with it, so the chain has a model of this profile's to fall back from (§37, §49).
          save.mutate(
            inherited.has('default') && defaults.data.default
              ? { default: defaults.data.default, fallbacks }
              : { fallbacks },
          )
        }
      />
      {tasks.map((task) => (
        <ModelSelect
          key={task.key}
          id={`default-${task.key}`}
          label={task.label[language === 'ar' ? 'ar' : 'en']}
          models={models}
          value={refValue(assignments[task.key])}
          inherited={inherited.has(task.key)}
          onChange={(ref) => save.mutate({ assignments: { [task.key]: ref } })}
        />
      ))}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}

      <Separator className="mt-2" decorative={false} />
      <section>
        <h3 className="mb-2 text-sm font-medium">{t('models.defaults.inheriting')}</h3>
        <p className="mb-2 text-xs text-muted">{t('models.defaults.inheriting_hint')}</p>
        {agents.isError && <Notice tone="danger">{describeError(agents.error, t)}</Notice>}
        <ul className="flex flex-col gap-1 text-sm" data-testid="inheriting-agents">
          {(agents.data ?? []).map((agent: Agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-2">
              {canManage ? (
                <NavLink to={routeOf('agent_manager')} className="link underline" dir="auto">
                  {agent.name}
                </NavLink>
              ) : (
                <span dir="auto">{agent.name}</span>
              )}
              <span dir="ltr">
                <Badge tone={agent.default_model ? 'accent' : 'neutral'}>
                  {agent.default_model
                    ? labelOf(models, agent.default_model, providers.data ?? [])
                    : t('models.defaults.none')}
                </Badge>
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
  inherited = false,
  onChange,
}: {
  id: string;
  label: string;
  models: Model[];
  value: string;
  /** The value is the default profile's, because this profile chose none. */
  inherited?: boolean;
  onChange(ref: ModelRef | null): void;
}) {
  const { t } = useI18n();
  const { recent, remember } = useRecentModels();
  // Grouped by provider, in the catalogue's order, so the headers do not interleave.
  const chat = models.filter((model) => model.kind === 'chat');
  const byProvider = new Map<string, Model[]>();
  for (const model of chat)
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  return (
    <div className="labelled-row">
      <Label className="labelled-row-name">{label}</Label>
      <Combobox
        value={value === '' ? null : value}
        onChange={(next) => {
          remember(next);
          onChange(parseRef(next ?? ''));
        }}
        label={label}
        placeholder={t('models.defaults.none')}
        testId={id}
        recent={recent}
        options={[...byProvider.values()].flatMap((list) =>
          list.map((model) => modelOption(model, refValue(model))),
        )}
      />
      {inherited && (
        <span className="text-xs text-muted" data-testid={`${id}-inherited`}>
          {t('models.defaults.inherited')}
        </span>
      )}
    </div>
  );
}
