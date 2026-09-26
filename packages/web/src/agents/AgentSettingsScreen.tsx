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
import type { Translator } from '../i18n/index.js';
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
import { AgentSignInCard } from './AgentSignInCard.js';
import { CompressionSettingsCard } from './CompressionSettingsCard.js';
import { PendingWritesCard } from './PendingWritesCard.js';
import { PresetsCard } from './PresetsCard.js';
import { versionNotes } from './versionNotes.js';

/** The adapter's own words, in the reading language. */
function localised(text: { ar: string; en: string } | string, language: string): string {
  if (typeof text === 'string') return text;
  return language === 'ar' ? text.ar : text.en;
}

export function AgentSettingsScreen() {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const { agentId = null } = useParams();
  const agents = useAgents();
  const settings = useAgentSettings(agentId);
  const save = useSaveAgentSetting(agentId);
  // What the last save said, shown on its own section: when the values apply, or the restart.
  const [saved, setSaved] = useState<{ section: string; restartJobId: string | null } | null>(null);
  const agent = (agents.data ?? []).find((a) => a.id === agentId);
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
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
      {/* An agent that keeps its own vendor account, once installed (Kimi Code, Grok Build). */}
      {agent && isAdmin && agent.install.sign_in && agent.install.source === 'managed' && (
        <AgentSignInCard agent={agent} />
      )}
      {/* Saved bundles of these settings, to switch between (decision §100). */}
      {agent && settings.data && <PresetsCard agentId={agent.id} canWrite={isAdmin} />}
      {/* Hermes's own compression keys for this profile (decision §57). */}
      {agent?.capabilities.includes('compress') && <CompressionSettingsCard />}
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
            saved={saved?.section === section.key ? saved : null}
            onSave={(values) => {
              setSaved(null);
              save.mutate(
                { section: section.key, values },
                {
                  onSuccess: (result) =>
                    setSaved({
                      section: section.key,
                      restartJobId:
                        (result as { restart_job_id?: string | null } | undefined)
                          ?.restart_job_id ?? null,
                    }),
                },
              );
            }}
          />
        ))}
      </div>
      {agent?.kind === 'hermes' && settings.data && <PendingWritesCard agentId={agent.id} />}
    </AppShell>
  );
}

/**
 * Updates, for an agent the hub installed rather than one it ships.
 *
 * Three things and no more (owner, 2026-09-22): ask the registry whether there is a newer
 * version, take it, and decide whether to take it automatically. An agent whose adapter
 * says it cannot update itself does not get the switch — `auto_update_supported` is the
 * adapter's answer, not ours to guess. Since 2026-09-25 the card also names the tested
 * version and says when a version is past it (`versionNotes`).
 */
function UpdatesCard({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'check' | 'upgrade' | 'auto' | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A bundled agent has no registry behind it: it arrives with the image.
  if (agent.install.source === 'builtin' || agent.install.source === 'none') return null;
  const notes = versionNotes(agent.install);

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
      {notes.tested && (
        <p className="mb-2 text-xs text-muted" data-testid="agent-version-tested">
          {t('agents.version_tested', { version: notes.tested })}
        </p>
      )}
      {notes.newerThanTested && (
        <Notice tone="warning">
          <span data-testid="agent-newer-than-tested">
            {t('agents.newer_than_tested_hint', { version: notes.tested ?? '' })}
          </span>
        </Notice>
      )}
      {notes.update ? (
        <Notice tone="info">
          {t(
            notes.updateUntested ? 'agents.update_available_untested' : 'agents.update_available',
            {
              version: notes.update,
            },
          )}
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
  saved,
  onSave,
}: {
  section: SettingsSection;
  language: string;
  saving: boolean;
  saved: { restartJobId: string | null } | null;
  onSave(values: Record<string, unknown>): void;
}) {
  const { t } = useI18n();
  // A section is saved as a whole, so edits live here until "Save" — a field that restarts
  // the agent must not do it on every keystroke.
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const dirty = Object.keys(draft).length > 0;
  const valueOf = (field: SettingsField) =>
    field.key in draft ? draft[field.key] : (field.value as unknown);
  const note = section.note ? localised(section.note, language) : null;
  // The adapter's note says when and where; without one, the short line.
  const subtitle = note
    ? undefined
    : section.applies === 'next_message'
      ? t('agents.applies_next_message')
      : section.restart_required
        ? t('agents.restart_required')
        : undefined;
  return (
    <Card>
      <div data-testid={`settings-section-${section.key}`}>
        <CardHeader
          title={localised(section.title, language)}
          {...(subtitle === undefined ? {} : { subtitle })}
        />
        {note && (
          <p
            className="mb-3 text-xs text-muted"
            dir="auto"
            data-testid={`section-note-${section.key}`}
          >
            {note}
          </p>
        )}
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
        {saved && !dirty && (
          <Notice tone="success" role="status" className="mt-3">
            <span data-testid={`saved-${section.key}`}>
              {saved.restartJobId
                ? t('agents.saved_restarting')
                : section.applies === 'restart'
                  ? t('agents.saved_restart_needed')
                  : section.applies === 'next_message'
                    ? t('agents.saved_next_message')
                    : t('agents.saved')}
            </span>
          </Notice>
        )}
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
      </div>
    </Card>
  );
}

/** A choice's label in the reading language: the adapter's own when it gave both. */
function optionLabel(option: SettingsField['options'][number], language: string): string {
  const labels = (option as { labels?: { ar: string; en: string } }).labels;
  return labels ? localised(labels, language) : option.label;
}

/**
 * The agent's own default, in words: what the field is while nothing is written. `null` is a
 * feature with no default value of its own (off, none).
 */
export function defaultText(field: SettingsField, language: string, t: Translator): string | null {
  const extra = field as { default?: unknown; default_text?: { ar: string; en: string } | null };
  if (extra.default_text) return localised(extra.default_text, language);
  if (!('default' in extra) || extra.default === undefined) return null;
  const fallback = extra.default;
  if (fallback === null) return t('agents.default_none');
  if (typeof fallback === 'boolean')
    return fallback ? t('agents.default_on') : t('agents.default_off');
  if (field.kind === 'choice') {
    const option = field.options.find((candidate) => candidate.value === String(fallback));
    return option ? optionLabel(option, language) : String(fallback);
  }
  return String(fallback);
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
  const extra = field as { help?: { ar: string; en: string } | null; default?: unknown };
  const fallback = defaultText(field, language, t);
  // What it does, then the agent's default — both in the reading language.
  const words = [
    extra.help ? localised(extra.help, language) : (field.hint ?? null),
    fallback === null ? null : t('agents.default_is', { value: fallback }),
  ].filter((part): part is string => part !== null);
  const hint = words.length > 0 ? words.join(' · ') : undefined;

  if (field.kind === 'toggle') {
    // Nothing written is the agent's default, so that is what the switch shows.
    const checked = value === null || value === undefined ? extra.default === true : value === true;
    return (
      <Switch
        checked={checked}
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
              label: optionLabel(option, language),
            }))}
            // Nothing chosen is the agent's own default, and choosing it goes back to that.
            {...('default' in extra
              ? { placeholder: t('agents.use_default', { value: fallback ?? '' }) }
              : {})}
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
          // Empty is the agent's default; saying which keeps the empty box from reading as zero.
          {...(fallback === null ? {} : { placeholder: fallback })}
          dir={numeric ? 'ltr' : 'auto'}
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
