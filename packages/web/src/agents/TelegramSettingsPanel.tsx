/**
 * «إعدادات تيليجرام»: every user-facing option Hermes has for Telegram in this profile, in
 * sections — who may message the bot, replies, groups, media and voice, advanced.
 *
 * The owner, 2026-09-24: «التليجرام فيه خصائص كثيره … يطلع ثينكينج … في اكثر من شغله». The hub
 * says which options exist, their values and Hermes's defaults (`agents.getChannelSettings`); the
 * words are ours, keyed by the option. Each option says what it does and what applies while it is
 * left unset; an option kept for the whole profile (speech, voice replies) says it changes every
 * channel there, WhatsApp included.
 *
 * Changes are gathered and saved together: every save restarts the profile's gateway (in a named
 * profile at once, in the default one at Hermes's Restart), so one save for several changes is
 * one restart.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Field,
  Input,
  Notice,
  Select,
  Skeleton,
  SkeletonGroup,
  Switch,
} from '../ui/index.js';
import {
  useChannelSettings,
  useUpdateChannelSettings,
  type ChannelGateway,
  type ChannelSetting,
} from './skills.js';

const SECTIONS: ReadonlyArray<ChannelSetting['section']> = [
  'access',
  'replies',
  'groups',
  'media',
  'advanced',
];

/** Comma-, space- or Arabic-comma-separated ids, as a person types them. */
function listOf(text: string): string[] {
  return text
    .split(/[\s,،]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function TelegramSettingsPanel({
  agentId,
  gateway,
}: {
  agentId: string | undefined;
  gateway: ChannelGateway | null;
}) {
  const { t } = useI18n();
  const settings = useChannelSettings(agentId, 'telegram', true);
  const save = useUpdateChannelSettings(agentId, 'telegram');
  /** Option key → the value the person chose (null: back to the default). Lists stay text here. */
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const changed = Object.keys(draft).length > 0;

  const current = (option: ChannelSetting): unknown =>
    Object.prototype.hasOwnProperty.call(draft, option.key) ? draft[option.key] : option.value;
  const effective = (option: ChannelSetting): unknown => current(option) ?? option.default;
  const set = (key: string, value: unknown) => setDraft({ ...draft, [key]: value });

  const submit = () => {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      const option = settings.data?.options.find((entry) => entry.key === key);
      if (option?.kind === 'list' && typeof value === 'string') values[key] = listOf(value);
      else if (option?.kind === 'number' && typeof value === 'string')
        values[key] = value.trim() === '' ? null : Number(value);
      else values[key] = value;
    }
    save.mutate(values, { onSuccess: () => setDraft({}) });
  };

  const label = (key: string) => t(`channels.settings.option.${key}.label`);
  const help = (key: string) => t(`channels.settings.option.${key}.help`);
  const choice = (key: string, value: string) => t(`channels.settings.choice.${key}.${value}`);

  /** "Default: on" — in words for the person, not the file's. */
  const defaultText = (option: ChannelSetting): string => {
    const value = option.default;
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return t('channels.settings.default_none');
    }
    if (typeof value === 'boolean') {
      return t('channels.settings.default_is', {
        value: t(value ? 'channels.settings.on' : 'channels.settings.off'),
      });
    }
    if (option.kind === 'select') {
      return t('channels.settings.default_is', { value: choice(option.key, String(value)) });
    }
    return t('channels.settings.default_is', {
      value: Array.isArray(value) ? value.join(', ') : String(value),
    });
  };

  const fieldError = (key: string): string | undefined => {
    const details = (save.error as { body?: { details?: { field?: string } } } | null)?.body
      ?.details;
    return details?.field === `values.${key}` ? t('channels.settings.invalid') : undefined;
  };

  const control = (option: ChannelSetting) => {
    const testId = `telegram-setting-${option.key}`;
    const hint = (
      <span className="flex flex-col gap-0.5">
        <span>{help(option.key)}</span>
        <span className="text-xs text-muted">{defaultText(option)}</span>
      </span>
    );
    switch (option.kind) {
      case 'toggle':
        return (
          <Switch
            checked={effective(option) === true}
            label={label(option.key)}
            hint={hint}
            testId={testId}
            onChange={(next) => set(option.key, next)}
          />
        );
      case 'select':
        return (
          <Field label={label(option.key)} hint={hint}>
            {() => (
              <Select
                value={String(effective(option) ?? '')}
                label={label(option.key)}
                testId={testId}
                options={(option.choices ?? []).map((value) => ({
                  value,
                  label: choice(option.key, value),
                }))}
                onValueChange={(next) => set(option.key, next)}
              />
            )}
          </Field>
        );
      default: {
        const value = current(option);
        const shown = Array.isArray(value)
          ? value.join(', ')
          : value === null || value === undefined
            ? ''
            : String(value);
        const error = fieldError(option.key);
        return (
          <Field label={label(option.key)} hint={hint} {...(error ? { error } : {})}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                inputMode={option.kind === 'number' ? 'numeric' : undefined}
                type={option.kind === 'number' ? 'number' : 'text'}
                {...(option.min !== null ? { min: option.min } : {})}
                {...(option.max !== null ? { max: option.max } : {})}
                placeholder={
                  option.kind === 'list'
                    ? t('channels.settings.list_placeholder')
                    : option.default !== null
                      ? String(option.default)
                      : ''
                }
                value={shown}
                data-testid={testId}
                onChange={(event) =>
                  set(option.key, event.target.value === '' ? null : event.target.value)
                }
              />
            )}
          </Field>
        );
      }
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      data-testid="telegram-settings"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{t('channels.settings.title')}</h3>
        <span className="text-xs text-muted">
          {gateway?.applies === 'now'
            ? t('channels.settings.applies_now')
            : t('channels.settings.applies_restart')}
        </span>
      </div>
      {settings.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="8rem" radius="md" />
        </SkeletonGroup>
      )}
      {settings.isError && <Notice tone="danger">{describeError(settings.error, t)}</Notice>}
      {settings.data &&
        SECTIONS.map((section) => {
          const options = settings.data.options.filter((option) => option.section === section);
          if (options.length === 0) return null;
          return (
            <fieldset
              key={section}
              className="flex flex-col gap-3"
              data-testid={`telegram-settings-${section}`}
            >
              <legend className="mb-1 text-sm font-semibold">
                {t(`channels.settings.section.${section}`)}
              </legend>
              {section === 'media' && (
                <p className="text-xs text-muted">{t('channels.settings.media_note')}</p>
              )}
              {options.map((option) => (
                <div key={option.key} className="flex flex-col gap-1" data-key={option.key}>
                  {control(option)}
                  <span className="flex flex-wrap items-center gap-2">
                    {option.shared && (
                      <Badge tone="warning" testId={`telegram-setting-shared-${option.key}`}>
                        {t('channels.settings.shared')}
                      </Badge>
                    )}
                    {current(option) !== null && current(option) !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`telegram-setting-reset-${option.key}`}
                        onClick={() => set(option.key, null)}
                      >
                        {t('channels.settings.reset')}
                      </Button>
                    )}
                  </span>
                </div>
              ))}
            </fieldset>
          );
        })}
      {save.isError && !fieldError('') && (
        <Notice tone="danger">
          <span data-testid="telegram-settings-error">{describeError(save.error, t)}</span>
        </Notice>
      )}
      {save.isSuccess && !changed && (
        <Notice tone="success">
          <span data-testid="telegram-settings-saved">
            {gateway?.applies === 'now'
              ? t('channels.settings.saved_now')
              : t('channels.settings.saved_restart')}
          </span>
        </Notice>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={!changed} onClick={() => setDraft({})}>
          {t('channels.settings.discard')}
        </Button>
        <Button
          disabled={!changed || save.isPending}
          data-testid="telegram-settings-save"
          onClick={submit}
        >
          {t('common.save')}
        </Button>
      </div>
    </section>
  );
}
