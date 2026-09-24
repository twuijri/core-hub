import { useI18n } from '../i18n/context.js';
import { Select } from '../ui/Select.js';
import { useProfileSelector } from './profileSelector.js';

/**
 * The profile chip, in the top bar only (owner, 2026-09-24): switches `X-Hub-Profile` and
 * refetches; never navigates (rule 4).
 */
export function WorkspaceSwitcher() {
  const { t } = useI18n();
  // "All profiles" on a list, the profile being edited elsewhere (ADR 0016).
  const selector = useProfileSelector();
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="text-muted">{t('shell.workspace')}</span>
      <Select
        value={selector.value}
        onValueChange={selector.onValueChange}
        options={selector.options}
        label={t('shell.workspace')}
        testId="workspace-switcher"
      />
    </span>
  );
}
