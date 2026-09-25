/**
 * Automatic context compression for the selected profile (decision §52), on the Hermes
 * agent's Settings page: that is where a person tunes how Hermes behaves, and these are
 * Hermes's own keys in the profile's `config.yaml` (`compression.*`, `model.context_length`),
 * which the hub reads and writes through `auth.getProfileSettings` / `updateProfileSettings`.
 *
 * Percentages on screen, ratios on the wire; Hermes applies a change from the next message.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useProfiles } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Button, Card, CardHeader, Field, Input, Notice, Spinner, Switch } from '../ui/index.js';

export interface CompressionSettings {
  enabled: boolean;
  threshold: number;
  target_ratio: number;
  protect_first: number;
  protect_last: number;
  context_length: number | null;
}

/** What the form edits: whole percentages and plain numbers, `''` for an empty field. */
interface Draft {
  enabled: boolean;
  threshold: string;
  target: string;
  protectFirst: string;
  protectLast: string;
  contextLength: string;
}

export function draftOf(settings: CompressionSettings): Draft {
  return {
    enabled: settings.enabled,
    threshold: String(Math.round(settings.threshold * 100)),
    target: String(Math.round(settings.target_ratio * 100)),
    protectFirst: String(settings.protect_first),
    protectLast: String(settings.protect_last),
    contextLength: settings.context_length === null ? '' : String(settings.context_length),
  };
}

/** The patch the draft means, or the name of the first field that is not a valid number. */
export function patchOf(draft: Draft): CompressionSettings | { invalid: keyof Draft } {
  const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
  const threshold = whole(draft.threshold);
  if (threshold === null || threshold < 1 || threshold > 100) return { invalid: 'threshold' };
  const target = whole(draft.target);
  if (target === null || target < 1 || target > 100) return { invalid: 'target' };
  const protectFirst = whole(draft.protectFirst);
  if (protectFirst === null) return { invalid: 'protectFirst' };
  const protectLast = whole(draft.protectLast);
  if (protectLast === null) return { invalid: 'protectLast' };
  const contextLength = draft.contextLength.trim() === '' ? null : whole(draft.contextLength);
  if (draft.contextLength.trim() !== '' && (contextLength === null || contextLength < 1024))
    return { invalid: 'contextLength' };
  return {
    enabled: draft.enabled,
    threshold: threshold / 100,
    target_ratio: target / 100,
    protect_first: protectFirst,
    protect_last: protectLast,
    context_length: contextLength,
  };
}

export function CompressionSettingsCard() {
  const { t } = useI18n();
  const { client, profile, session } = useAuth();
  const profiles = useProfiles();
  const queryClient = useQueryClient();
  const profileId = (profiles.data ?? []).find((row) => row.slug === profile)?.id ?? null;
  const key = ['profile-settings', profileId] as const;
  const settings = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await client.request('get', '/profiles/{profile_id}/settings', {
          params: { profile_id: profileId ?? '' },
        })
      ).data as unknown as { compression: CompressionSettings },
    enabled: !!session && !!profileId,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<keyof Draft | null>(null);
  const save = useMutation({
    mutationFn: async (compression: CompressionSettings) =>
      (
        await client.request('patch', '/profiles/{profile_id}/settings', {
          params: { profile_id: profileId ?? '' },
          body: { compression: { ...compression } as Record<string, unknown> },
        })
      ).data,
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const current = settings.data ? draftOf(settings.data.compression) : null;
  const shown = draft ?? current;
  const set = (patch: Partial<Draft>) => {
    if (!shown) return;
    setInvalid(null);
    save.reset();
    setDraft({ ...shown, ...patch });
  };
  const number = (field: keyof Omit<Draft, 'enabled'>, label: string, hint?: string) =>
    shown && (
      <Field
        label={label}
        {...(hint ? { hint } : {})}
        {...(invalid === field ? { error: t('compression_settings.invalid') } : {})}
      >
        {(props) => (
          <Input
            {...props}
            inputMode="numeric"
            dir="ltr"
            value={shown[field]}
            onChange={(event) => set({ [field]: event.target.value })}
            data-testid={`compression-${field}`}
          />
        )}
      </Field>
    );

  return (
    <Card>
      <CardHeader
        title={t('compression_settings.title')}
        subtitle={t('compression_settings.subtitle')}
      />
      {(settings.isPending || profiles.isPending) && <Spinner label={t('common.loading')} />}
      {settings.isError && <Notice tone="danger">{describeError(settings.error, t)}</Notice>}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      {save.isSuccess && <Notice tone="success">{t('compression_settings.saved')}</Notice>}
      {shown && (
        <div className="flex flex-col gap-3" data-testid="compression-settings">
          <Switch
            checked={shown.enabled}
            onChange={(enabled) => set({ enabled })}
            label={t('compression_settings.enabled')}
            hint={t('compression_settings.enabled_hint')}
            testId="compression-enabled"
          />
          {number(
            'threshold',
            t('compression_settings.threshold'),
            t('compression_settings.threshold_hint'),
          )}
          {number(
            'target',
            t('compression_settings.target'),
            t('compression_settings.target_hint'),
          )}
          {number('protectFirst', t('compression_settings.protect_first'))}
          {number('protectLast', t('compression_settings.protect_last'))}
          {number(
            'contextLength',
            t('compression_settings.context_length'),
            t('compression_settings.context_length_hint'),
          )}
          <div className="flex gap-2">
            <Button
              disabled={draft === null || save.isPending}
              loading={save.isPending}
              onClick={() => {
                if (!draft) return;
                const patch = patchOf(draft);
                if ('invalid' in patch) setInvalid(patch.invalid);
                else save.mutate(patch);
              }}
              data-testid="compression-save"
            >
              {t('common.save')}
            </Button>
            {draft && (
              <Button variant="ghost" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
