/**
 * The chat model's fallback chain on the Defaults tab (contract decision §49): an ordered
 * list the person adds to, reorders and removes from. The order is the order the hub tries
 * them in when the chat model's provider fails, so it is shown numbered and moved one place
 * at a time with buttons that say which model they move — a list of three or four does not
 * need dragging, and buttons work from the keyboard and a screen reader alike.
 */
import { useI18n } from '../i18n/context.js';
import type { Model } from '../types.js';
import { Button, Combobox, Label } from '../ui/index.js';
import { IconChevron, IconTrash } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { addFallback, moveFallback, removeFallback } from './fallbacks.js';
import { parseRef, refValue, type ModelRef } from './queries.js';
import { modelOption } from './useModelPicker.js';

export function FallbackList({
  chain,
  primary,
  models,
  disabled,
  onChange,
}: {
  chain: readonly ModelRef[];
  /** The chat model the chain falls back from; `null` when none is chosen. */
  primary: ModelRef | null;
  models: readonly Model[];
  disabled: boolean;
  onChange(next: ModelRef[]): void;
}) {
  const { t } = useI18n();
  const chat = models.filter((model) => model.kind === 'chat');
  const nameOf = (ref: ModelRef) => {
    const model = chat.find((m) => m.provider_id === ref.provider_id && m.model === ref.model);
    return model ? (model.alias ?? model.key) : ref.model;
  };
  const taken = new Set([...chain.map(refValue), refValue(primary)]);
  const options = chat
    .filter((model) => !taken.has(refValue(model)))
    .map((model) => modelOption(model, refValue(model)));

  return (
    <section className="flex flex-col gap-2" data-testid="fallback-models">
      <Label className="text-sm font-medium">{t('models.defaults.fallbacks')}</Label>
      <p className="text-xs text-muted">{t('models.defaults.fallbacks_hint')}</p>
      {!primary ? (
        <Notice tone="info">{t('models.defaults.fallbacks_need_default')}</Notice>
      ) : chain.length === 0 ? (
        <p className="text-sm text-muted" data-testid="fallback-empty">
          {t('models.defaults.fallbacks_empty')}
        </p>
      ) : (
        <ol className="flex max-w-xl flex-col gap-1" data-testid="fallback-list">
          {chain.map((ref, index) => {
            const name = nameOf(ref);
            return (
              <li
                key={refValue(ref)}
                className="flex items-center gap-2"
                data-testid="fallback-item"
                data-model={ref.model}
              >
                <span className="w-5 text-xs text-muted">{index + 1}.</span>
                <span className="grow text-sm" dir="ltr">
                  {name}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<IconChevron size={14} className="rotate-180" />}
                  aria-label={t('models.defaults.fallback_up', { model: name })}
                  disabled={disabled || index === 0}
                  onClick={() => onChange(moveFallback(chain, index, -1))}
                  data-testid="fallback-up"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<IconChevron size={14} />}
                  aria-label={t('models.defaults.fallback_down', { model: name })}
                  disabled={disabled || index === chain.length - 1}
                  onClick={() => onChange(moveFallback(chain, index, 1))}
                  data-testid="fallback-down"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<IconTrash size={14} />}
                  aria-label={t('models.defaults.fallback_remove', { model: name })}
                  disabled={disabled}
                  onClick={() => onChange(removeFallback(chain, index))}
                  data-testid="fallback-remove"
                />
              </li>
            );
          })}
        </ol>
      )}
      {primary && (
        <div className="labelled-row">
          <span className="labelled-row-name text-xs text-muted">
            {t('models.defaults.fallback_add')}
          </span>
          <Combobox
            value={null}
            disabled={disabled || options.length === 0}
            onChange={(next) => {
              const ref = parseRef(next ?? '');
              if (ref) onChange(addFallback(chain, ref, primary));
            }}
            label={t('models.defaults.fallback_add')}
            placeholder={t('models.defaults.fallback_add')}
            testId="fallback-add"
            options={options}
          />
        </div>
      )}
    </section>
  );
}
