import { useProfiles } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';

/** The workspace chip: switches `X-Hub-Profile` and refetches; never navigates (rule 4). */
export function WorkspaceSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { profile, setProfile } = useAuth();
  const profiles = useProfiles();
  const items = profiles.data ?? [];
  return (
    <label className="inline-flex items-center gap-1 text-xs">
      {!compact && <span className="text-muted">{t('shell.workspace')}</span>}
      <select
        className="field w-auto py-1 text-xs"
        value={profile}
        onChange={(event) => setProfile(event.target.value)}
        aria-label={t('shell.workspace')}
        data-testid="workspace-switcher"
      >
        {items.length === 0 && <option value={profile}>{profile}</option>}
        {items.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
