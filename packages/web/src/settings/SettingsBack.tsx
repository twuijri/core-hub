// Every page that lives under Settings says so and offers the way back (NAVIGATION §2:
// one Settings screen, no settings inside settings — these are siblings reached from it).
import { NavLink } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { IconChevron } from '../ui/icons.js';

export function SettingsBack({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <NavLink
      to={routeOf('settings')}
      data-testid="settings-back"
      className={`link mb-3 inline-flex items-center gap-1 text-sm hover:underline ${className}`}
    >
      <IconChevron size={14} className="rotate-90 rtl:-rotate-90" />
      {t('settings.back')}
    </NavLink>
  );
}
