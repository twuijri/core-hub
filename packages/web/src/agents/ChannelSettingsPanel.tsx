/**
 * «إعدادات <المنصة>»: every user-facing option Hermes has for a channel in this profile, in
 * sections — who may message it, replies, groups and channels, media and voice, advanced. Built
 * for Telegram (#97, the owner: «التليجرام فيه خصائص كثيره … يطلع ثينكينج … في اكثر من شغله»),
 * and the same panel for Discord, Slack, Matrix, Mattermost and Email.
 *
 * The hub says which options exist, their values and Hermes's defaults
 * (`agents.getChannelSettings`); the words are ours, keyed by the option — the same key means the
 * same thing on every platform, and a platform whose words differ (Discord's "channel" is
 * Telegram's "group") has its own under `channels.settings.platform.<platform>`. Each option says
 * what it does and what applies while it is left unset; an option kept for the whole profile
 * (speech, voice replies) says it changes every channel there, WhatsApp included.
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

export function ChannelSettingsPanel({
  agentId,
  platform,
  name,
  gateway,
}: {
  agentId: string | undefined;
  platform: string;
  /** The platform's name as the page says it. */
  name: string;
  gateway: ChannelGateway | null;
}) {
  const { t } = useI18n();
  const settings = useChannelSettings(agentId, platform, true);
  const save = useUpdateChannelSettings(agentId, platform);
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

  /** The platform's own words for a key where they differ, the shared ones otherwise. */
  const words = (key: string): string => {
    const own = `channels.settings.platform.${platform}.${key}`;
    const text = t(own);
    return text === own ? t(`channels.settings.${key}`) : text;
  };
  const label = (key: string) => words(`option.${key}.label`);
  const help = (key: string) => words(`option.${key}.help`);
  const choice = (key: string, value: string) => words(`choice.${key}.${value}`);
  const ids = (key: string) => `${platform}-${key}`;

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
    const testId = ids(`setting-${option.key}`);
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
                    ? words('list_placeholder')
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
      className="flex flex-col gap-4 rounded-md border border-line p-4"
      data-testid={ids('settings')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">
          {platform === 'telegram'
            ? t('channels.settings.title')
            : t('channels.settings.title_of', { name })}
        </h3>
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
              data-testid={ids(`settings-${section}`)}
            >
              <legend className="mb-1 text-sm font-semibold">{words(`section.${section}`)}</legend>
              {options.some((option) => option.shared) && (
                <p className="text-xs text-muted">{t('channels.settings.media_note')}</p>
              )}
              {options.map((option) => (
                <div key={option.key} className="flex flex-col gap-1" data-key={option.key}>
                  {control(option)}
                  <span className="flex flex-wrap items-center gap-2">
                    {option.shared && (
                      <Badge tone="warning" testId={ids(`setting-shared-${option.key}`)}>
                        {t('channels.settings.shared')}
                      </Badge>
                    )}
                    {current(option) !== null && current(option) !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={ids(`setting-reset-${option.key}`)}
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
          <span data-testid={ids('settings-error')}>{describeError(save.error, t)}</span>
        </Notice>
      )}
      {save.isSuccess && !changed && (
        <Notice tone="success">
          <span data-testid={ids('settings-saved')}>
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
          data-testid={ids('settings-save')}
          onClick={submit}
        >
          {t('common.save')}
        </Button>
      </div>
    </section>
  );
}
