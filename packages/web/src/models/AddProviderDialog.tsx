/**
 * "Add provider" — the one dialog where a provider comes into existence.
 *
 * Owner direction, 2026-09-22, in this order: provider type (Preset | Custom), the preset
 * dropdown, the base URL prefilled from the preset and editable, the API key (with a
 * show/hide eye, marked optional wherever it is), and a default-model select with a
 * Fetch button that asks the endpoint itself.
 *
 * Three rules it exists to keep:
 * - the key field is **always** there. A preset whose key is optional is added without
 *   one, and a local proxy behind a master key still has somewhere to type it.
 * - Fetch asks the real endpoint (`models.probeProvider`) and shows what came back —
 *   never an empty list drawn as success.
 * - a loopback address on a containerized hub is called out, in both languages, with the
 *   address that would work. Nothing is rewritten silently.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { ProviderHost, ProviderPreset } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';
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
  onClose,
}: {
  presets: ProviderPreset[];
  host: ProviderHost | undefined;
  /** Preset ids already added: a non-repeatable one is offered once (409 otherwise). */
  taken: ReadonlySet<string>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const create = useCreateProvider();
  const probe = useProbeProvider();
  const saveModel = useSaveModel();
  const saveDefaults = useSaveDefaults();
  const ids = useId();
  const firstField = useRef<HTMLButtonElement>(null);

  const offered = useMemo(
    () => presets.filter((preset) => preset.repeatable || !taken.has(preset.id)),
    [presets, taken],
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
    <div
      className="fixed inset-0 z-[var(--mj-z-overlay)] flex items-start justify-center overflow-y-auto bg-scrim p-4"
      // A click on the scrim is a cancel; the dialog itself stops the bubble.
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        data-testid="add-provider-dialog"
        // Glass belongs to floating chrome, and a dialog is exactly that (DESIGN.md).
        className="glass mt-10 flex w-full max-w-lg flex-col gap-3 rounded-lg p-4"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        onSubmit={submit}
      >
        <h2 id={`${ids}-title`} className="text-lg font-semibold">
          {t('models.provider.add')}
        </h2>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs text-muted">{t('models.add.type')}</legend>
          <div className="segmented self-start" role="group">
            <button
              type="button"
              ref={firstField}
              aria-pressed={mode === 'preset'}
              onClick={() => {
                setMode('preset');
                setBaseUrl(preset?.base_url ?? '');
              }}
              data-testid="add-mode-preset"
            >
              {t('models.add.type_preset')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'custom'}
              onClick={() => {
                setMode('custom');
                // A custom endpoint does not inherit a preset's address: it is a
                // different provider, and a leftover URL is the wrong one.
                setBaseUrl('');
                setModels([]);
                setModel('');
                setProbeError(null);
              }}
              data-testid="add-mode-custom"
            >
              {t('models.add.type_custom')}
            </button>
          </div>
        </fieldset>

        {mode === 'preset' ? (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor={`${ids}-preset`}>
              {t('models.add.select_provider')}
            </label>
            <select
              id={`${ids}-preset`}
              className="field"
              value={presetId}
              onChange={(event) => setPresetId(event.target.value)}
              data-testid="add-preset"
            >
              {offered.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
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
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor={`${ids}-label`}>
              {t('models.provider.label')}
            </label>
            <input
              id={`${ids}-label`}
              className="field"
              dir="auto"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              required
              data-testid="add-label"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`${ids}-url`}>
            {t('models.provider.base_url')}
          </label>
          <input
            id={`${ids}-url`}
            className="field"
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
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`${ids}-key`}>
            {keyOptional ? t('models.add.key_optional') : t('models.add.key_required')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${ids}-key`}
              className="field"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required={!keyOptional}
              data-testid="add-api-key"
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
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`${ids}-model`}>
            {t('models.add.default_model')}
          </label>
          <div className="flex items-center gap-2">
            <select
              id={`${ids}-model`}
              className="field"
              value={model}
              disabled={models.length === 0}
              onChange={(event) => setModel(event.target.value)}
              data-testid="add-default-model"
            >
              <option value="">{t('models.add.model_placeholder')}</option>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={probe.isPending || baseUrl.trim() === ''}
              onClick={fetchModels}
              data-testid="add-fetch-models"
            >
              {t('models.add.fetch')}
            </button>
          </div>
          {probe.isPending && <Spinner label={t('models.add.fetching')} />}
          {probeError && (
            <Notice tone="danger">
              <span data-testid="add-fetch-error">{probeError}</span>
            </Notice>
          )}
          {models.length > 0 && !probeError && (
            <p className="text-xs text-muted">
              {t('models.add.fetched', { count: models.length })}
            </p>
          )}
        </div>

        {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit || create.isPending}
            data-testid="add-submit"
          >
            {t('models.add.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
