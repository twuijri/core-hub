/**
 * The pickers of the speech tabs (DECISIONS §92). Every one of them is the same pair: a
 * searchable list of what the provider offers, and the id field it fills — which a person
 * may also type into, for a model, a voice or a language code the list does not show.
 *
 * - **Model**: the provider's own models of the tab's kind, from its catalogue.
 * - **Language**: "Detect automatically", then the popular languages, then every language.
 * - **Voice**: the provider's voices for the chosen model, each with its language, gender and
 *   the provider's own words about it; filtered to the popular languages until "All
 *   languages" (or one language) is chosen, and searchable by name, id or description. A list
 *   read from the provider's documentation — it has no list endpoint — says so.
 */
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Combobox, Field, Input, Select, type ComboboxOption } from '../ui/index.js';
import {
  ALL_LANGUAGES,
  POPULAR_LANGUAGES,
  baseLanguage,
  isPopular,
  languageName,
  sortLanguages,
} from '../voice/languages.js';
import { useSpeechModels, useVoices, type SpeechVoice } from './queries.js';

/** A picker plus the id it fills; the id is the source of truth and can be typed. */
function IdField({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  testId: string;
}) {
  return (
    <Input
      // An id reads left to right; the hint in the empty field is in the interface language.
      dir={value ? 'ltr' : undefined}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      data-testid={testId}
    />
  );
}

export function SpeechModelField({
  kind,
  providerId,
  value,
  onChange,
}: {
  kind: 'stt' | 'tts';
  providerId: string;
  value: string;
  onChange(next: string): void;
}) {
  const { t } = useI18n();
  const models = useSpeechModels(providerId, kind);
  const options: ComboboxOption[] = useMemo(() => {
    const listed = (models.data ?? []).map((model) => ({
      value: model.model,
      label: model.alias ?? model.model,
      detail: model.model,
    }));
    // A model typed by hand is still what is chosen: keep it in the list it is shown from.
    if (value && !listed.some((option) => option.value === value)) {
      listed.push({ value, label: value, detail: t('models.speech.custom_value') });
    }
    return listed;
  }, [models.data, value, t]);
  return (
    <Field label={t('models.speech.model')}>
      {() => (
        <div className="flex flex-col gap-1">
          {(models.data?.length ?? 0) > 0 && (
            <Combobox
              value={value || null}
              onChange={(next) => onChange(next ?? '')}
              options={options}
              label={t('models.speech.model')}
              placeholder={t('models.speech.model_pick')}
              testId={`speech-model-pick-${kind}`}
            />
          )}
          <IdField
            label={t('models.speech.model_id')}
            value={value}
            onChange={onChange}
            placeholder={t('models.speech.model_custom')}
            testId={`speech-model-${kind}`}
          />
        </div>
      )}
    </Field>
  );
}

export function SpeechLanguageField({
  kind,
  value,
  onChange,
}: {
  kind: 'stt' | 'tts';
  value: string;
  onChange(next: string): void;
}) {
  const { t, language: ui } = useI18n();
  const options: ComboboxOption[] = useMemo(() => {
    const popular = new Set<string>(POPULAR_LANGUAGES);
    const rest = sortLanguages(
      ALL_LANGUAGES.filter((code) => !popular.has(code)),
      ui,
    );
    return [
      {
        value: '__auto',
        label: t('models.speech.language_auto'),
        group: t('models.speech.lang_popular'),
      },
      ...POPULAR_LANGUAGES.map((code) => ({
        value: code,
        label: languageName(code, ui),
        detail: code,
        group: t('models.speech.lang_popular'),
      })),
      ...rest.map((code) => ({
        value: code,
        label: languageName(code, ui),
        detail: code,
        group: t('models.speech.lang_all'),
      })),
    ];
  }, [t, ui]);
  return (
    <Field label={t(kind === 'stt' ? 'models.speech.language_stt' : 'models.speech.language_tts')}>
      {() => (
        <div className="flex flex-col gap-1">
          <Combobox
            value={
              value ? (options.some((option) => option.value === value) ? value : null) : '__auto'
            }
            onChange={(next) => onChange(!next || next === '__auto' ? '' : next)}
            options={options}
            label={t('models.speech.language')}
            placeholder={value || t('models.speech.language_auto')}
            testId={`speech-language-pick-${kind}`}
          />
          <IdField
            label={t('models.speech.language_code')}
            value={value}
            onChange={onChange}
            placeholder={t('models.speech.language_custom')}
            testId={`speech-language-${kind}`}
          />
        </div>
      )}
    </Field>
  );
}

type Filter = 'popular' | 'all' | `lang:${string}`;

/** "Female · Arabic (Saudi Arabia) · Saudi dialect · noura" — what a voice row says under its name. */
function voiceDetail(voice: SpeechVoice, ui: string, t: (key: string) => string): string {
  return [
    voice.gender ? t(`models.speech.gender_${voice.gender}`) : null,
    voice.language ? languageName(voice.language, ui) : t('models.speech.any_language'),
    voice.description ?? null,
    voice.id !== voice.name ? voice.id : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SpeechVoiceField({
  providerId,
  model,
  value,
  onChange,
}: {
  providerId: string;
  model: string;
  value: string;
  /** The voice id, and the language of the listed voice when one was picked from the list. */
  onChange(next: string, language?: string | null): void;
}) {
  const { t, language: ui } = useI18n();
  const voices = useVoices(providerId, model);
  const items = useMemo(() => voices.data?.items ?? [], [voices.data]);
  const [filter, setFilter] = useState<Filter>('popular');

  // The languages the provider's voices speak, popular first.
  const languages = useMemo(() => {
    const bases = [
      ...new Set(items.map((voice) => baseLanguage(voice.language)).filter(Boolean)),
    ] as string[];
    return sortLanguages(bases, ui);
  }, [items, ui]);
  // With nothing popular to show, "popular" would be an empty list: show them all.
  const effective: Filter =
    filter === 'popular' && !items.some((voice) => !voice.language || isPopular(voice.language))
      ? 'all'
      : filter;

  const options: ComboboxOption[] = useMemo(() => {
    const shown = items.filter((voice) => {
      if (effective === 'all') return true;
      if (effective === 'popular') return !voice.language || isPopular(voice.language);
      return baseLanguage(voice.language) === effective.slice('lang:'.length);
    });
    const groupOf = (voice: SpeechVoice) => {
      const base = baseLanguage(voice.language);
      return base ? languageName(base, ui) : t('models.speech.any_language');
    };
    const ordered = [...shown].sort((a, b) => {
      const la = baseLanguage(a.language);
      const lb = baseLanguage(b.language);
      if (la === lb) return 0;
      if (!la) return -1;
      if (!lb) return 1;
      return sortLanguages([la, lb], ui)[0] === la ? -1 : 1;
    });
    const listed = ordered.map((voice) => ({
      value: voice.id,
      label: voice.name,
      detail: voiceDetail(voice, ui, t),
      group: groupOf(voice),
    }));
    if (value && !items.some((voice) => voice.id === value)) {
      listed.unshift({
        value,
        label: value,
        detail: t('models.speech.custom_value'),
        group: t('models.speech.custom_group'),
      });
    }
    return listed;
  }, [items, effective, ui, t, value]);

  const source = voices.data?.source;
  const listed = items.length > 0;
  return (
    <div className="ch-field-row sm:col-span-2" data-testid="speech-voice-field">
      <span className="ch-label">{t('models.speech.voice')}</span>
      {listed && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={effective}
            onValueChange={(next) => next && setFilter(next as Filter)}
            label={t('models.speech.voice_language')}
            testId="speech-voice-filter"
            options={[
              { value: 'popular', label: t('models.speech.lang_popular') },
              { value: 'all', label: t('models.speech.lang_all_count', { count: items.length }) },
              ...languages.map((base) => ({
                value: `lang:${base}`,
                label: languageName(base, ui),
                group: t('models.speech.voice_language'),
              })),
            ]}
          />
          <div className="min-w-0 flex-1">
            <Combobox
              value={value || null}
              onChange={(next) =>
                onChange(next ?? '', items.find((voice) => voice.id === next)?.language ?? null)
              }
              options={options}
              label={t('models.speech.voice')}
              placeholder={t('models.speech.voice_pick')}
              testId="speech-voice-pick"
            />
          </div>
        </div>
      )}
      <IdField
        label={t('models.speech.voice_id')}
        value={value}
        onChange={(next) => onChange(next)}
        placeholder={t('models.speech.voice_hint')}
        testId="speech-voice-tts"
      />
      {voices.isLoading && <p className="ch-field-hint">{t('models.speech.voices_loading')}</p>}
      {source === 'documented' && (
        <p className="ch-field-hint" data-testid="speech-voices-documented">
          {t('models.speech.voices_documented')}
        </p>
      )}
      {source === 'none' && !voices.isLoading && (
        <p className="ch-field-hint" data-testid="speech-voices-none">
          {t('models.speech.voices_none')}
        </p>
      )}
    </div>
  );
}
