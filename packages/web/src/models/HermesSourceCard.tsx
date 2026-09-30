/**
 * "Hermes uses Core Hub's models" (DECISIONS §143): one switch for the hub. On, Hermes reaches
 * every model the hub's gateway serves through it — the subscriptions signed in to through the
 * gateway included — and each switch back gives Hermes its own providers again. A hub without the
 * choice (older, 404) shows nothing; one whose gateway is off says why and cannot switch it on.
 */
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Card, Notice, Switch } from '../ui/index.js';
import { isUnsupported, useHermesSource, useSetHermesSource } from './queries.js';

export function HermesSourceCard() {
  const { t } = useI18n();
  const source = useHermesSource();
  const set = useSetHermesSource();
  if (source.isPending || (source.isError && isUnsupported(source.error))) return null;
  if (source.isError) return <Notice tone="danger">{describeError(source.error, t)}</Notice>;
  const data = source.data;
  return (
    <Card tone="flat" className="mb-4" testId="hermes-source">
      <Switch
        checked={data.source === 'hub'}
        disabled={set.isPending || (!data.available && data.source !== 'hub')}
        onChange={(on) => set.mutate(on ? 'hub' : 'native')}
        label={t('models.hermes_source.label')}
        hint={t(
          data.effective === 'hub'
            ? 'models.hermes_source.hint_hub'
            : data.source === 'hub'
              ? 'models.hermes_source.hint_pending'
              : 'models.hermes_source.hint_native',
        )}
        testId="hermes-source-switch"
      />
      {!data.available && (
        <p className="text-xs text-muted" data-testid="hermes-source-unavailable">
          {t('models.hermes_source.unavailable', { reason: data.reason ?? '—' })}
        </p>
      )}
      {set.isError && <Notice tone="danger">{describeError(set.error, t)}</Notice>}
    </Card>
  );
}
