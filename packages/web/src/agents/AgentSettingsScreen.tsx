/**
 * One agent's own settings, as the agent itself declares them (ADR 0002).
 *
 * The hub does not know what a Hermes or a Codex can be configured to do; the adapter
 * answers `agents.getSettings` with sections of typed fields, and this screen draws
 * whatever comes back with the kit. A field kind the contract adds later and this screen
 * has not learned yet is shown read-only with its value, never dropped silently.
 *
 * Owner decision, 2026-09-22: this page is reachable from the agent's card, beside
 * Restart — «بجنب رستارت هرميز يكون فيه سيتنق» — because that is where a person is when
 * they want it, and because MCP, memory and tools are configured through these fields.
 */
import { useState } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { keys, useAgents, useAgentSettings, useSaveAgentSetting } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import type { Agent, SettingsField, SettingsSection } from '../types.js';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
  Switch,
  Textarea,
} from '../ui/index.js';
import { IconSettings } from '../ui/icons.js';

/** The adapter's own words, in the reading language. */
function localised(text: { ar: string; en: string } | string, language: string): string {
  if (typeof text === 'string') return text;
  return language === 'ar' ? text.ar : text.en;
}

export function AgentSettingsScreen() {
  const { t, language } = useI18n();
  const { agentId = null } = useParams();
  const agents = useAgents();
  const settings = useAgentSettings(agentId);
  const save = useSaveAgentSetting(agentId);
  const agent = (agents.data ?? []).find((a) => a.id === agentId);
  const title = agent ? t('agents.settings_of', { name: agent.name }) : t('nav.agent_settings');

  return (
    <AppShell title={title}>
      <h1 className="mb-3 text-xl font-semibold" dir="auto">
        {title}
      </h1>
      {settings.isPending && <Spinner label={t('common.loading')} />}
      {settings.isError && <Notice tone="danger">{describeError(settings.error, t)}</Notice>}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      {agent && <UpdatesCard agent={agent} />}
      {settings.data && settings.data.sections.length === 0 && (
        <EmptyState icon={<IconSettings size={20} />} title={t('agents.settings_none')} />
      )}
      <div className="flex flex-col gap-3">
        {(settings.data?.sections as SettingsSection[] | undefined)?.map((section) => (
          <SectionCard
            key={section.key}
            section={section}
            language={language}
            saving={save.isPending}
            onSave={(values) => save.mutate({ section: section.key, values })}
          />
        ))}
      </div>
    </AppShell>
  );
}

/**
 * Updates, for an agent the hub installed rather than one it ships.
 *
 * Three things and no more (owner, 2026-09-22): ask the registry whether there is a newer
 * version, take it, and decide whether to take it automatically. An agent whose adapter
 * says it cannot update itself does not get the switch — `auto_update_supported` is the
 * adapter's answer, not ours to guess.
 */
function UpdatesCard({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'check' | 'upgrade' | 'auto' | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A bundled agent has no registry behind it: it arrives with the image.
  if (agent.install.source === 'builtin' || agent.install.source === 'none') return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.agents(profile) });
  const run = async (kind: 'check' | 'upgrade') => {
    setBusy(kind);
    setError(null);
    try {
      const params = { agent_id: agent.id };
      if (kind === 'check')
        await client.request('post', '/agents/{agent_id}/check-update', { params });
      else await client.request('post', '/agents/{agent_id}/update', { params });
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };
  const setAuto = async (next: boolean) => {
    setBusy('auto');
    setError(null);
    try {
      await client.request('patch', '/agents/{agent_id}', {
        params: { agent_id: agent.id },
        body: { auto_update: next },
      });
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('agents.updates')}
        subtitle={t('agents.version_now', { version: agent.install.version ?? '—' })}
      />
      {agent.install.update_available ? (
        <Notice tone="info">
          {t('agents.update_available', { version: agent.install.latest_version ?? '' })}
        </Notice>
      ) : (
        <p className="text-xs text-muted">{t('agents.up_to_date')}</p>
      )}
      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={busy !== null}
          loading={busy === 'check'}
          onClick={() => void run('check')}
          data-testid="agent-check-update"
        >
          {t('agents.check_update')}
        </Button>
        <Button
          disabled={busy !== null || !agent.install.update_available}
          loading={busy === 'upgrade'}
          onClick={() => void run('upgrade')}
          data-testid="agent-upgrade"
        >
          {t('agents.update_now')}
        </Button>
      </div>
      {agent.install.auto_update_supported && (
        <div className="mt-3">
          <Switch
            checked={agent.install.auto_update}
            onChange={(next) => void setAuto(next)}
            disabled={busy !== null}
            label={t('agents.auto_update')}
            hint={t('agents.auto_update_hint')}
            testId="agent-auto-update"
          />
        </div>
      )}
    </Card>
  );
}

function SectionCard({
  section,
  language,
  saving,
  onSave,
}: {
  section: SettingsSection;
  language: string;
  saving: boolean;
  onSave(values: Record<string, unknown>): void;
}) {
  const { t } = useI18n();
  // A section is saved as a whole, so edits live here until "Save" — a field that restarts
  // the agent must not do it on every keystroke.
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const dirty = Object.keys(draft).length > 0;
  const valueOf = (field: SettingsField) =>
    field.key in draft ? draft[field.key] : (field.value as unknown);
  return (
    <Card>
      <CardHeader
        title={localised(section.title, language)}
        {...(section.restart_required ? { subtitle: t('agents.restart_required') } : {})}
      />
      <div className="flex flex-col gap-3">
        {section.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            language={language}
            value={valueOf(field)}
            onChange={(next) => setDraft((current) => ({ ...current, [field.key]: next }))}
          />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          disabled={!dirty || saving}
          loading={saving}
          onClick={() => {
            onSave(draft);
            setDraft({});
          }}
          data-testid={`save-${section.key}`}
        >
          {t('common.save')}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft({})}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function FieldRow({
  field,
  language,
  value,
  onChange,
}: {
  field: SettingsField;
  language: string;
  value: unknown;
  onChange(next: unknown): void;
}) {
  const { t } = useI18n();
  const label = localised(field.label, language);
  const hint = field.hint ?? undefined;

  if (field.kind === 'toggle') {
    return (
      <Switch
        checked={value === true}
        onChange={onChange}
        label={label}
        {...(hint === undefined ? {} : { hint })}
        testId={`field-${field.key}`}
      />
    );
  }
  if (field.kind === 'choice') {
    return (
      <Field label={label} {...(hint === undefined ? {} : { hint })}>
        {() => (
          <Select
            value={typeof value === 'string' ? value : null}
            onValueChange={(next) => onChange(next)}
            options={field.options.map((option) => ({
              value: String(option.value),
              label: option.label,
            }))}
            label={label}
            testId={`field-${field.key}`}
          />
        )}
      </Field>
    );
  }
  if (field.kind === 'list' || field.kind === 'json') {
    // A list is one item per line and JSON is JSON: both are text the person edits, and
    // both are sent back as text — the hub is what validates them, not this screen.
    return (
      <Field label={label} hint={hint ?? t(`agents.field_hint.${field.kind}`)}>
        {(props) => (
          <Textarea
            {...props}
            rows={4}
            value={
              typeof value === 'string'
                ? value
                : value === null || value === undefined
                  ? ''
                  : JSON.stringify(value, null, 2)
            }
            onChange={(event) => onChange(event.target.value)}
            data-testid={`field-${field.key}`}
          />
        )}
      </Field>
    );
  }
  const numeric = field.kind === 'integer' || field.kind === 'number';
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      {(props) => (
        <Input
          {...props}
          type={field.kind === 'secret' ? 'password' : numeric ? 'number' : 'text'}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(event) =>
            onChange(
              numeric
                ? event.target.value === ''
                  ? null
                  : Number(event.target.value)
                : event.target.value,
            )
          }
          {...(field.min === null ? {} : { min: field.min })}
          {...(field.max === null ? {} : { max: field.max })}
          data-testid={`field-${field.key}`}
        />
      )}
    </Field>
  );
}
