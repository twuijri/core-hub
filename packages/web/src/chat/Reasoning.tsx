/**
 * What the thinking leaves behind.
 *
 * While the run is alive the reasoning is the status line above the composer
 * (`RunStatus.tsx`). When it ends, it collapses to one quiet sentence — «فكّر لمدة 12
 * ثانية» / "Thought for 12s" — with the text itself behind a disclosure, closed. It is
 * history: it must not be able to be mistaken for the reply.
 *
 * When no duration is known the sentence says only "Reasoning", because a made-up number
 * is worse than none.
 */
import { useI18n } from '../i18n/context.js';
import { IconChevron } from '../ui/icons.js';

export function Reasoning({ text, seconds }: { text: string; seconds: number | null }) {
  const { t } = useI18n();
  if (!text.trim()) return null;
  return (
    <details className="reason" data-testid="reasoning">
      <summary className="reason-summary" data-testid="reasoning-summary">
        <span dir="auto">
          {seconds === null ? t('chat.reasoning') : t('chat.thought_for', { seconds })}
        </span>
        <IconChevron size={12} className="reason-caret" />
      </summary>
      <p className="reason-text" dir="auto">
        {text}
      </p>
    </details>
  );
}
