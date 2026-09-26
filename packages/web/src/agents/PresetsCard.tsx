/**
 * «الإعدادات المحفوظة» / "Presets" on an agent's Settings page (contract decision §100).
 *
 * A preset is this agent's settings in this profile, saved under a name: the chat model and its
 * fallbacks, the agent's own model, which skills and MCP servers are on, and the settings
 * sections below. Save the current settings, see what a preset holds, activate it (the hub
 * applies it through the same saves as these pages, and says what it could not apply), or
 * delete it. Never a key or a password: the card says so, because a person will wonder.
 * Admins save, activate and delete; anyone who may read the settings may read the presets.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { keys } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Notice,
  Spinner,
  useConfirm,
} from '../ui/index.js';

type AgentPreset = components['schemas']['AgentPreset'];
type Activation = components['schemas']['AgentPresetActivation'];

const presetKeys = (profile: string, agentId: string) =>
  ['agents', profile, agentId, 'presets'] as const;

function usePresets(agentId: string) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: presetKeys(profile, agentId),
    queryFn: async () =>
      (await client.request('get', '/agents/{agent_id}/presets', { params: { agent_id: agentId } }))
        .data.items,
  });
}

/** What a preset holds, in a line: the parts it sets and how many things in each. */
function summary(preset: AgentPreset, t: (key: string, p?: Record<string, number>) => string) {
  const parts: string[] = [];
  const { model, skills, mcp_servers: mcp, settings } = preset.content;
  if (model) parts.push(t('presets.part.model'));
  if (skills) parts.push(t('presets.part.skills', { count: Object.keys(skills).length }));
  if (mcp) parts.push(t('presets.part.mcp_servers', { count: Object.keys(mcp).length }));
  if (settings) parts.push(t('presets.part.settings', { count: Object.keys(settings).length }));
  return parts.join(' · ');
}

export function PresetsCard({ agentId, canWrite }: { agentId: string; canWrite: boolean }) {
  const { t } = useI18n();
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  const presets = usePresets(agentId);
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [outcome, setOutcome] = useState<{ id: string; result: Activation } | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: presetKeys(profile, agentId) });
  };

  const save = useMutation({
    mutationFn: async (input: { name: string }) =>
      (
        await client.request('post', '/agents/{agent_id}/presets', {
          params: { agent_id: agentId },
          body: { name: input.name },
        })
      ).data,
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const activate = useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('post', '/agents/{agent_id}/presets/{preset_id}/activate', {
          params: { agent_id: agentId, preset_id: id },
        })
      ).data,
    onSuccess: (result, id) => {
      setOutcome({ id, result });
      refresh();
      // Everything the preset set is read again: the settings below, the agent, its skills.
      void queryClient.invalidateQueries({ queryKey: keys.agents(profile) });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/presets/{preset_id}', {
          params: { agent_id: agentId, preset_id: id },
        })
      ).data,
    onSuccess: refresh,
  });
  const failure = save.error ?? activate.error ?? remove.error;

  return (
    <Card testId="presets">
      <CardHeader title={t('presets.title')} subtitle={t('presets.subtitle')} />
      <div className="flex flex-col gap-3">
        {canWrite && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) save.mutate({ name: name.trim() });
            }}
          >
            <Field label={t('presets.name')} className="min-w-48 flex-1">
              {(props) => (
                <Input
                  {...props}
                  dir="auto"
                  maxLength={80}
                  value={name}
                  data-testid="preset-name"
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={!name.trim()}
              data-testid="preset-save"
            >
              {t('presets.save')}
            </Button>
          </form>
        )}
        {failure && <Notice tone="danger">{describeError(failure, t)}</Notice>}
        {presets.isPending && <Spinner label={t('common.loading')} />}
        {presets.isError && <Notice tone="danger">{describeError(presets.error, t)}</Notice>}
        {presets.data && presets.data.length === 0 && (
          <p className="text-sm text-muted">{t('presets.none')}</p>
        )}
        <ul className="flex flex-col divide-y divide-line">
          {presets.data?.map((preset) => (
            <li key={preset.id} className="flex flex-col gap-1 py-2" data-testid="preset-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium" dir="auto">
                    {preset.name}
                  </div>
                  <div className="text-xs text-muted">{summary(preset, t)}</div>
                </div>
                {canWrite && (
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={activate.isPending && activate.variables === preset.id}
                      data-testid="preset-activate"
                      onClick={async () => {
                        const yes = await confirm.ask({
                          title: t('presets.activate_title', { name: preset.name }),
                          body: t('presets.activate_body'),
                          confirmLabel: t('presets.activate'),
                          tone: 'default',
                        });
                        if (yes) activate.mutate(preset.id);
                      }}
                    >
                      {t('presets.activate')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="preset-delete"
                      onClick={async () => {
                        const yes = await confirm.ask({
                          title: t('presets.delete_title', { name: preset.name }),
                        });
                        if (yes) remove.mutate(preset.id);
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                )}
              </div>
              {outcome?.id === preset.id && (
                <Notice
                  tone={outcome.result.skipped.length > 0 ? 'warning' : 'success'}
                  testId="preset-outcome"
                >
                  {outcome.result.skipped.length > 0
                    ? t('presets.applied_partly', {
                        skipped: outcome.result.skipped
                          .map((s) => (s.key ? `${s.key}` : t(`presets.part_name.${s.part}`)))
                          .join(t('presets.separator')),
                      })
                    : t('presets.applied')}
                  {outcome.result.restart_job_ids.length > 0 && ` ${t('presets.restarting')}`}
                </Notice>
              )}
            </li>
          ))}
        </ul>
      </div>
      {confirm.dialog}
    </Card>
  );
}
