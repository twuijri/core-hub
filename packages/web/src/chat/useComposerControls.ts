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
import { useCatalogue } from '../models/queries.js';
import type { SettingsSection } from '../types.js';
import type { ComposerOption } from './Composer.js';

export const APPROVAL_FIELD = 'approval_mode';

/** Where `approval_mode` lives in a descriptor, and what it is set to. */
export function findApprovalMode(
  sections: readonly SettingsSection[] | undefined,
): { section: string; value: string } | null {
  for (const section of sections ?? []) {
    for (const field of section.fields) {
      if (field.key !== APPROVAL_FIELD) continue;
      return { section: section.key, value: typeof field.value === 'string' ? field.value : 'ask' };
    }
  }
  return null;
}

export function useComposerModels(): ComposerOption[] {
  const catalogue = useCatalogue();
  return useMemo(
    () =>
      (catalogue.data ?? [])
        .filter((model) => model.visible && !model.disabled && model.kind === 'chat')
        // `key` is `<provider>/<model>`, which is what a session stores.
        .map((model) => ({ value: model.key, label: model.alias ?? model.model })),
    [catalogue.data],
  );
}

export interface ApprovalControl {
  mode: string | null;
  disabledReason: string | null;
  set(value: string): void;
}

export function useApprovalMode(agentId: string | null): ApprovalControl {
  const { t } = useI18n();
  const settings = useAgentSettings(agentId);
  const save = useSaveAgentSetting(agentId);
  const found = findApprovalMode(settings.data?.sections as SettingsSection[] | undefined);
  if (!agentId)
    return { mode: null, disabledReason: t('composer.approval_no_agent'), set: () => {} };
  if (settings.isPending) return { mode: null, disabledReason: t('common.loading'), set: () => {} };
  if (!found)
    return { mode: null, disabledReason: t('composer.approval_unsupported'), set: () => {} };
  return {
    mode: found.value,
    disabledReason: null,
    set: (value: string) =>
      save.mutate({ section: found.section, values: { [APPROVAL_FIELD]: value } }),
  };
}
