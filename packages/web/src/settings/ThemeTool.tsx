import { useI18n } from '../i18n/context.js';
import { DisplayTab } from './DisplayTab.js';

/** The Theme tool: theme and glass only; the footer chip mirrors the same preference. */
export function ThemeTool() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('theme.intro')}</p>
      <DisplayTab only={['theme', 'glass']} />
      <p className="text-xs text-muted">{t('theme.reduced_note')}</p>
    </div>
  );
}
