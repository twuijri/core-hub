/**
 * A schedule's two run options (owner, 2026-09-24; DECISIONS §39), for the hub's own
 * schedules — Hermes decides both for its own jobs, so its schedules do not show them:
 *
 * - «شغّله لو فات وقته (خلال ٢٤ ساعة)», off by default: a time missed while the hub was
 *   down runs once when it is back within 24 hours; off, it never runs late. Up to two
 *   minutes late is still on time.
 * - «إذا كان التشغيل السابق لسا شغّال»: skip, wait then run (the default, one waiting at
 *   most), run alongside, or stop the previous.
 *
 * The same controls make a new schedule and edit one; the owner of the state decides when a
 * change is saved.
 */
import { useI18n } from '../i18n/context.js';
import { Checkbox, Radio } from '../ui/index.js';

export type Overlap = 'skip' | 'wait' | 'parallel' | 'replace';
export const OVERLAPS: readonly Overlap[] = ['skip', 'wait', 'parallel', 'replace'];

/** The owner's defaults for a new schedule. */
export const DEFAULT_RUN_OPTIONS = { run_if_missed: false, overlap: 'wait' as Overlap };

export interface RunOptionsValue {
  run_if_missed: boolean;
  overlap: Overlap;
}

export function RunOptions({
  value,
  onChange,
  disabled = false,
  testId,
}: {
  value: RunOptionsValue;
  onChange(patch: Partial<RunOptionsValue>): void;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <Checkbox
        checked={value.run_if_missed}
        onChange={(next) => onChange({ run_if_missed: next })}
        label={t('schedules.options.missed')}
        hint={t('schedules.options.missed_hint')}
        disabled={disabled}
        testId={`${testId}-missed`}
      />
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t('schedules.options.overlap')}</p>
        <Radio
          label={t('schedules.options.overlap')}
          value={value.overlap}
          onChange={(next) => onChange({ overlap: next as Overlap })}
          options={OVERLAPS.map((overlap) => ({
            value: overlap,
            label: t(`schedules.options.overlaps.${overlap}.label`),
            hint: t(`schedules.options.overlaps.${overlap}.hint`),
          }))}
          disabled={disabled}
          testId={`${testId}-overlap`}
        />
        <p className="text-xs text-muted">{t('schedules.options.overlap_hint')}</p>
      </div>
    </div>
  );
}
