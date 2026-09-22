import { useProfiles } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { Select } from '../ui/Select.js';

/** The workspace chip: switches `X-Hub-Profile` and refetches; never navigates (rule 4). */
export function WorkspaceSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { profile, setProfile } = useAuth();
  const profiles = useProfiles();
  const items = profiles.data ?? [];
  // Until the hub answers, the slug we are scoped to is the only workspace we can name.
  const options =
    items.length === 0
      ? [{ value: profile, label: profile }]
      : items.map((p) => ({ value: p.slug, label: p.name }));
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {!compact && <span className="text-muted">{t('shell.workspace')}</span>}
      <Select
        value={profile}
        onValueChange={(next) => next && setProfile(next)}
        options={options}
        label={t('shell.workspace')}
        testId="workspace-switcher"
      />
    </span>
  );
}
