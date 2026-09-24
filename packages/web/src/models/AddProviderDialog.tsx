/**
 * "Add provider" — the one dialog where a provider comes into existence.
 *
 * Owner direction, 2026-09-22, in this order: provider type (Preset | Custom), the preset
 * dropdown, the base URL prefilled from the preset and editable, the API key (with a
 * show/hide eye, marked optional wherever it is), and a default-model select with a
 * Fetch button that asks the endpoint itself.
 *
 * First question (contract decision §38, owner 2026-09-24): who is it for — every profile
 * (shared, the default) or only the profile selected at the top, whose own key then wins
 * there over a shared one. A provider never changes scope afterwards.
 *
 * Three rules it exists to keep:
 * - the key field is **always** there. A preset whose key is optional is added without
 *   one, and a local proxy behind a master key still has somewhere to type it.
 * - Fetch asks the real endpoint (`models.probeProvider`) and shows what came back —
 *   never an empty list drawn as success.
 * - a loopback address on a containerized hub is called out, in both languages, with the
 *   address that would work. Nothing is rewritten silently.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { ProviderHost, ProviderPreset } from '../types.js';
import {
  Button,
  Combobox,
  Dialog,
  Field,
  Input,
  Label,
  Notice,
  Segmented,
  Select,
  Spinner,
} from '../ui/index.js';
import { needsLoopbackWarning, suggestedHostUrl } from './loopback.js';
import {
  useCreateProvider,
  useProbeProvider,
  useSaveDefaults,
  useSaveModel,
  type ProviderCreate,
} from './queries.js';

export function AddProviderDialog({
  presets,
  host,
  taken,
  profileName,
  onClose,
}: {
  presets: ProviderPreset[];
  host: ProviderHost | undefined;
  /**
   * Preset ids already added, per scope: a non-repeatable one is offered once in each
   * (409 otherwise) — once shared and once as this profile's own is allowed.
   */
  taken: { all: ReadonlySet<string>; profile: ReadonlySet<string> };
  /** The profile selected at the top: the one "this profile only" means. */
  profileName: string;
  onClose(): void;
}) {
  const { t } = useI18n();
  const create = useCreateProvider();
  const probe = useProbeProvider();
  const saveModel = useSaveModel();
  const saveDefaults = useSaveDefaults();
  const firstField = useRef<HTMLButtonElement>(null);

  const [scope, setScope] = useState<'all' | 'profile'>('all');
  const offered = useMemo(
    () => presets.filter((preset) => preset.repeatable || !taken[scope].has(preset.id)),
    [presets, taken, scope],
  );
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [presetId, setPresetId] = useState<string>(offered[0]?.id ?? '');
  const preset = offered.find((item) => item.id === presetId);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(preset?.base_url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [probeError, setProbeError] = useState<string | null>(null);

  // The preset decides what is prefilled; a person's own typing is never overwritten
  // afterwards, because this only runs when the chosen preset changes.
  useEffect(() => {
    setBaseUrl(preset?.base_url ?? '');
    setModels([]);
    setModel('');
    setProbeError(null);
  }, [preset?.id, preset?.base_url]);

  useEffect(() => firstField.current?.focus(), []);

  // A preset already added in the chosen scope is not offered; move off it when the scope
  // changes rather than submitting a 409.
  useEffect(() => {
    if (!offered.some((item) => item.id === presetId)) setPresetId(offered[0]?.id ?? '');
  }, [offered, presetId]);

  const usingPreset = mode === 'preset' && preset !== undefined;
  const keyOptional = usingPreset ? preset.key === 'optional' : true;
  const canSubmit =
    baseUrl.trim() !== '' &&
    (usingPreset || label.trim() !== '') &&
    (keyOptional || apiKey.trim() !== '');
  const warn = needsLoopbackWarning(baseUrl, host);

  const fetchModels = () => {
    setProbeError(null);
    setModels([]);
    probe.mutate(
      {
        ...(usingPreset ? { preset: preset.id } : {}),
        base_url: baseUrl.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          if (!result.ok) {
            // The endpoint's own words, exactly as they arrived.
            setProbeError(result.message ?? t('models.add.fetch_failed'));
            return;
          }
          setModels(result.models);
          if (result.models.length === 0) setProbeError(t('models.add.fetch_empty'));
          else setModel(result.models[0]?.id ?? '');
        },
        onError: (error) => setProbeError(describeError(error, t)),
      },
    );
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body: ProviderCreate = {
      ...(usingPreset ? { preset: preset.id } : {}),
      label: usingPreset ? label.trim() || preset.label : label.trim(),
      kind: usingPreset ? (preset.kind as 'llm' | 'stt' | 'tts') : 'llm',
      base_url: baseUrl.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      scope,
    };
    create.mutate(body, {
      onSuccess: async (provider) => {
        if (model) {
          // The catalogue refresh is a job; registering the chosen model makes the
          // default legal now instead of racing it (`models.putModel` §custom).
          await saveModel.mutateAsync({ provider_id: provider.id, model, custom: true });
          await saveDefaults.mutateAsync({ default: { provider_id: provider.id, model } });
        }
        onClose();
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={t('models.provider.add')}
      closeLabel={t('ui.close')}
      testId="add-provider-dialog"
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <fieldset className="flex flex-col gap-1">
          <legend className="mj-label">{t('models.add.scope')}</legend>
          <Segmented
            className="self-start"
            label={t('models.add.scope')}
            value={scope}
            onChange={(next) => setScope(next === 'profile' ? 'profile' : 'all')}
            wrap
            testId="add-scope"
            options={[
              {
                value: 'all',
                label: t('models.add.scope_all'),
                ref: firstField,
                itemProps: { 'data-testid': 'add-scope-all' },
              },
              {
                value: 'profile',
                label: t('models.add.scope_profile'),
                itemProps: { 'data-testid': 'add-scope-profile' },
              },
            ]}
          />
          <p className="text-xs text-muted" data-testid="add-scope-hint">
            {scope === 'all'
              ? t('models.add.scope_all_hint')
              : t('models.add.scope_profile_hint', { profile: profileName })}
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mj-label">{t('models.add.type')}</legend>
          <Segmented
            className="self-start"
            label={t('models.add.type')}
            value={mode}
            onChange={(next) => {
              if (next === 'preset') {
                setMode('preset');
                setBaseUrl(preset?.base_url ?? '');
                return;
              }
              setMode('custom');
              // A custom endpoint does not inherit a preset's address: it is a
              // different provider, and a leftover URL is the wrong one.
              setBaseUrl('');
              setModels([]);
              setModel('');
              setProbeError(null);
            }}
            options={[
              {
                value: 'preset',
                label: t('models.add.type_preset'),
                itemProps: { 'data-testid': 'add-mode-preset' },
              },
              {
                value: 'custom',
                label: t('models.add.type_custom'),
                itemProps: { 'data-testid': 'add-mode-custom' },
              },
            ]}
          />
        </fieldset>

        {mode === 'preset' ? (
          <div className="mj-field-row">
            <Label>{t('models.add.select_provider')}</Label>
            <Select
              value={presetId}
              onValueChange={(next) => next && setPresetId(next)}
              label={t('models.add.select_provider')}
              testId="add-preset"
              options={offered.map((item) => ({ value: item.id, label: item.label }))}
            />
            {preset?.keys_url && (
              <a
                className="link text-xs underline"
                href={preset.keys_url}
                target="_blank"
                rel="noreferrer"
              >
                {t('models.add.where_key')}
              </a>
            )}
          </div>
        ) : (
          <Field label={t('models.provider.label')}>
            {(props) => (
              <Input
                {...props}
                dir="auto"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                required
                data-testid="add-label"
              />
            )}
          </Field>
        )}

        <Field label={t('models.provider.base_url')}>
          {(props) => (
            <>
              <Input
                {...props}
                dir="ltr"
                inputMode="url"
                placeholder="http://host.docker.internal:1234/v1"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                data-testid="add-base-url"
              />
              {warn && host && (
                <Notice tone="warning" className="mt-1">
                  <span data-testid="loopback-warning">
                    {t('models.add.loopback', { url: suggestedHostUrl(baseUrl, host) })}
                  </span>
                </Notice>
              )}
            </>
          )}
        </Field>

        <Field label={keyOptional ? t('models.add.key_optional') : t('models.add.key_required')}>
          {(props) => (
            <span className="field-row-inline">
              <Input
                {...props}
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required={!keyOptional}
                data-testid="add-api-key"
              />
              <Button aria-pressed={showKey} onClick={() => setShowKey((shown) => !shown)}>
                {t(showKey ? 'models.add.hide_key' : 'models.add.show_key')}
              </Button>
            </span>
          )}
        </Field>

        <div className="mj-field-row">
          <Label>{t('models.add.default_model')}</Label>
          <div className="flex items-center gap-2">
            {/* The list is empty until the provider is asked, so the picker says so and
                keeps Fetch inside the popup, where the person already is. */}
            <Combobox
              value={model === '' ? null : model}
              onChange={(next) => setModel(next ?? '')}
              label={t('models.add.default_model')}
              placeholder={t('models.add.model_placeholder')}
              testId="add-default-model"
              status={
                probe.isPending
                  ? 'loading'
                  : probeError !== null
                    ? 'error'
                    : models.length === 0
                      ? 'unfetched'
                      : 'ready'
              }
              errorMessage={probeError}
              fetchAction={{
                label: t('models.add.fetch'),
                onSelect: fetchModels,
                disabled: probe.isPending || baseUrl.trim() === '',
              }}
              options={models.map((item) => ({
                value: item.id,
                label: item.label,
                detail: item.id,
              }))}
            />
            <Button
              disabled={probe.isPending || baseUrl.trim() === ''}
              onClick={fetchModels}
              data-testid="add-fetch-models"
            >
              {t('models.add.fetch')}
            </Button>
          </div>
          {probe.isPending && <Spinner label={t('models.add.fetching')} />}
          {probeError && (
            <Notice tone="danger">
              <span data-testid="add-fetch-error">{probeError}</span>
            </Notice>
          )}
          {models.length > 0 && !probeError && (
            <p className="mj-field-hint">{t('models.add.fetched', { count: models.length })}</p>
          )}
        </div>

        {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}

        <div className="mj-dialog-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!canSubmit || create.isPending}
            data-testid="add-submit"
          >
            {t('models.add.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
