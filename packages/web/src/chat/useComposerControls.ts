/**
 * What the composer's two selectors need, in one place, so the draft screen and an open
 * session offer exactly the same controls.
 *
 * - models: the workspace catalogue (`models.listCatalogue`). Empty until a provider is
 *   configured, and then the selector says so rather than pretending to choose.
 * - approvals: `approval_mode` inside the agent's own settings descriptor (ADR 0002), read
 *   with `agents.getSettings` and written with `agents.updateSettings`. An adapter that does
 *   not declare the field leaves the selector disabled with the reason on screen.
 */
import { useMemo } from 'react';
import { useAgentSettings, useSaveAgentSetting } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { chatModels, useCatalogue } from '../models/queries.js';
import { modelOption } from '../models/useModelPicker.js';
import type { Agent, Model, SettingsSection } from '../types.js';
import type { ComboboxOption } from '../ui/Combobox.js';
import type { SelectOption } from '../ui/Select.js';

/**
 * The approval field, whatever the adapter calls it. The ACP adapters declare
 * `approval_mode` (ask · auto_safe · auto_all — the one the `agent_settings.approval_mode`
 * column stores); Hermes declares `approvals_mode` with its own three (`manual`, `smart`, `off`
 * — Hermes's `approvals.mode` in the profile, contract decision §58). The client does not
 * decide which exist (NAVIGATION rule 5): it shows the options the descriptor declares.
 */
export const APPROVAL_FIELDS = ['approval_mode', 'approvals_mode'] as const;

/**
 * What each mode we know actually changes, and how much it gives away.
 *
 * "Ask", "always ask" and "no approvals" are three near-synonyms until each one says what
 * it does (owner, 2026-09-22: «الخيارات هذي وش فرقها عن بعض»). A mode an adapter declares
 * that is not here keeps its own label with no sentence under it — we do not invent one.
 */
const APPROVAL_TONES: Record<string, 'danger' | 'warning' | undefined> = {
  auto_all: 'danger',
  off: 'danger',
  auto_safe: 'warning',
  smart: 'warning',
};

export interface ApprovalField {
  section: string;
  key: string;
  value: string;
  options: SelectOption[];
}

export function findApprovalMode(
  sections: readonly SettingsSection[] | undefined,
  label: (value: string, fallback: string) => string = (_v, fallback) => fallback,
  describe: (value: string) => string | null = () => null,
): ApprovalField | null {
  for (const section of sections ?? []) {
    for (const field of section.fields) {
      if (!(APPROVAL_FIELDS as readonly string[]).includes(field.key)) continue;
      const options = (field.options ?? []).map((option) => {
        const value = String(option.value);
        const hint = describe(value);
        const tone = APPROVAL_TONES[value];
        return {
          value,
          label: label(value, option.label),
          ...(hint === null ? {} : { description: hint }),
          ...(tone === undefined ? {} : { tone }),
        } satisfies SelectOption;
      });
      return {
        section: section.key,
        key: field.key,
        // Nothing written is the agent's own default (Hermes: `smart`), not the first option.
        value:
          typeof field.value === 'string'
            ? field.value
            : typeof (field as { default?: unknown }).default === 'string'
              ? ((field as { default?: unknown }).default as string)
              : (options[0]?.value ?? 'ask'),
        options,
      };
    }
  }
  return null;
}

/**
 * The chat models this workspace can run, as the searchable picker shows them: the alias
 * reads, the id identifies and is searched too, and the provider becomes the group.
 */
/**
 * What the model picker says when no model is chosen (owner, 2026-09-29): which model that
 * default is. Hermes and the hub's own agent run on the profile's default the hub hands them
 * (`default_model`), named by the catalogue's label when it has one; a coding agent runs on the
 * model its own settings name (`agent_default_model`), and when they name none only the agent
 * knows — "Agent's own default". `null` keeps the plain "Default model".
 */
export function defaultModelLabel(
  agent: Pick<Agent, 'kind' | 'default_model' | 'agent_default_model' | 'model_source'> | undefined,
  models: readonly ComboboxOption[],
  t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (!agent) return null;
  // A coding agent on the hub's models (ADR 0029) runs on the hub's default, as Hermes does.
  if (agent.kind === 'acp' && agent.model_source !== 'hub') {
    const own = agent.agent_default_model;
    return own
      ? t('composer.model_default_named', { model: own })
      : t('composer.model_agent_default');
  }
  const ref = agent.default_model;
  if (!ref?.model) return null;
  const option = models.find(
    (candidate) => candidate.value === ref.model || candidate.value.endsWith(`/${ref.model}`),
  );
  return t('composer.model_default_named', { model: option?.label ?? ref.model });
}

/**
 * The chat models an agent's picker offers. A coding agent on the hub's models (ADR 0029) is
 * offered what the gateway can serve it — every hub provider's model, but not a subscription
 * signed in to through Hermes (`Model.agent_gateway`); every other agent, the whole catalogue.
 */
export function composerModelOptions(
  catalogue: readonly Model[],
  agent?: Pick<Agent, 'kind' | 'model_source'> | undefined,
): ComboboxOption[] {
  const gatewayOnly = agent?.kind === 'acp' && agent.model_source === 'hub';
  return (
    chatModels([...catalogue])
      .filter((model) => model.visible && !model.disabled)
      .filter((model) => !gatewayOnly || model.agent_gateway === true)
      // `key` is `<provider>/<model>`, which is what a session stores.
      .map((model) => modelOption(model, model.key))
  );
}

export function useComposerModels(
  agent?: Pick<Agent, 'kind' | 'model_source'> | undefined,
): ComboboxOption[] {
  const catalogue = useCatalogue();
  const gatewayOnly = agent?.kind === 'acp' && agent.model_source === 'hub';
  return useMemo(
    () =>
      composerModelOptions(
        catalogue.data ?? [],
        gatewayOnly ? { kind: 'acp', model_source: 'hub' } : undefined,
      ),
    [catalogue.data, gatewayOnly],
  );
}

export interface ApprovalControl {
  mode: string | null;
  /** The modes the adapter declares; empty when it declares none. */
  options: SelectOption[];
  disabledReason: string | null;
  set(value: string): void;
}

export function useApprovalMode(agentId: string | null): ApprovalControl {
  const { t } = useI18n();
  const settings = useAgentSettings(agentId);
  const save = useSaveAgentSetting(agentId);
  // Our own wording for the modes we know; the adapter's own label for anything else.
  const label = (value: string, fallback: string) => {
    const key = `composer.approval_mode.${value}`;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  // One line per mode, only for the modes we know; anything else keeps the adapter's word.
  const describe = (value: string) => {
    const key = `composer.approval_hint.${value}`;
    const translated = t(key);
    return translated === key ? null : translated;
  };
  const found = findApprovalMode(
    settings.data?.sections as SettingsSection[] | undefined,
    label,
    describe,
  );
  const off = (reason: string): ApprovalControl => ({
    mode: null,
    options: [],
    disabledReason: reason,
    set: () => {},
  });
  if (!agentId) return off(t('composer.approval_no_agent'));
  if (settings.isPending) return off(t('common.loading'));
  if (!found || found.options.length === 0) return off(t('composer.approval_unsupported'));
  return {
    mode: found.value,
    options: found.options,
    disabledReason: null,
    set: (value: string) => save.mutate({ section: found.section, values: { [found.key]: value } }),
  };
}
