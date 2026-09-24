import { useI18n } from '../i18n/context.js';
import { Badge } from '../ui/index.js';
import { useProfileName } from './profileSelector.js';

/**
 * Which profile an item is from, on a list that gathers several (ADR 0016). The name is
 * shown; a screen reader hears "Profile: <name>", said once, outside the chip, so the chip's
 * own direction follows the name alone (an English name in an Arabic list stays whole).
 */
export function ProfileBadge({
  profile,
  testId,
  className = '',
}: {
  profile: string;
  testId?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const name = useProfileName()(profile);
  return (
    <span
      className={`inline-flex shrink-0 ${className}`}
      data-testid={testId}
      data-profile={profile}
    >
      <span className="sr-only">{t('shell.in_profile', { name })}</span>
      <span aria-hidden="true" className="inline-flex">
        <Badge>{name}</Badge>
      </span>
    </span>
  );
}
