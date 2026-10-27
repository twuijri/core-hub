/**
 * "Jump to latest" (owner, 2026-10-27): a small round ↓ button floating above the composer
 * while the reader has scrolled up from the newest message, in a hub chat and in a Telegram or
 * WhatsApp conversation alike. One tap brings the newest message back and the transcript
 * follows the agent again (`useFollowBottom`). At the bottom it is not there at all.
 */
import { useI18n } from '../i18n/context.js';
import { IconArrowDown } from '../ui/icons.js';
import { Tooltip } from '../ui/Tooltip.js';

export function JumpToLatest({ shown, onJump }: { shown: boolean; onJump(): void }) {
  const { t } = useI18n();
  if (!shown) return null;
  const label = t('chat.jump_latest');
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="jump-latest glass"
        aria-label={label}
        onClick={onJump}
        data-testid="jump-latest"
      >
        <IconArrowDown size={18} />
      </button>
    </Tooltip>
  );
}
