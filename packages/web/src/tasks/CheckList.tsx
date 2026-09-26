/**
 * A task's definition of done or its constraints (contract decision §104): lines the person
 * writes, the agent is given with every run, and the reviewer ticks when the task is in review.
 *
 * The ticks are the reviewer's, so the boxes can be ticked only while the task is in review;
 * outside it they show what was ticked last. A new run clears them (the hub does that).
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Button, Checkbox, Input } from '../ui/index.js';
import { IconClose, IconPlus } from '../ui/icons.js';
import type { CheckItem } from './queries.js';

/** The hub's limits (contract `TaskCheckItemWrite`, `Task.definition_of_done`). */
export const CHECK_LINE_MAX = 500;
export const CHECK_LINES_MAX = 30;

export function CheckListEditor({
  kind,
  items,
  onChange,
  reviewing,
}: {
  kind: 'dod' | 'constraints';
  items: CheckItem[];
  onChange(next: CheckItem[]): void;
  /** The task is in review: the reviewer may tick. */
  reviewing: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const add = () => {
    const text = draft.trim();
    if (text === '' || items.length >= CHECK_LINES_MAX) return;
    onChange([...items, { text, checked: false }]);
    setDraft('');
  };
  const ticked = items.filter((item) => item.checked).length;
  return (
    <section
      aria-label={t(`tasks.${kind}.title`)}
      className="task-checklist flex flex-col gap-2"
      data-testid={`task-${kind}`}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t(`tasks.${kind}.title`)}</h3>
        {items.length > 0 && (
          <span className="text-xs text-muted" data-testid={`task-${kind}-count`}>
            {t('tasks.dod.ticked', { done: ticked, total: items.length })}
          </span>
        )}
      </div>
      <p className="text-xs text-muted">
        {t(reviewing ? 'tasks.dod.review_hint' : `tasks.${kind}.hint`)}
      </p>
      {items.length > 0 && (
        <ul className="flex flex-col gap-1">
          {items.map((item, index) => (
            <li
              key={index}
              className="task-checklist-line flex items-center gap-2"
              data-testid={`task-${kind}-line`}
              data-checked={item.checked ? 'true' : undefined}
            >
              <Checkbox
                checked={item.checked}
                disabled={!reviewing}
                onChange={(next) =>
                  onChange(items.map((one, at) => (at === index ? { ...one, checked: next } : one)))
                }
                label={t('tasks.dod.tick', { text: item.text })}
                labelHidden
                testId={`task-${kind}-tick`}
              />
              <Input
                inputSize="sm"
                dir="auto"
                maxLength={CHECK_LINE_MAX}
                value={item.text}
                onChange={(event) =>
                  onChange(
                    items.map((one, at) =>
                      at === index ? { ...one, text: event.target.value } : one,
                    ),
                  )
                }
                aria-label={t(`tasks.${kind}.line`, { number: index + 1 })}
                data-testid={`task-${kind}-text`}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<IconClose size={14} />}
                aria-label={t('tasks.dod.remove', { text: item.text })}
                tooltip={t('tasks.dod.remove', { text: item.text })}
                onClick={() => onChange(items.filter((_, at) => at !== index))}
                data-testid={`task-${kind}-remove`}
              />
            </li>
          ))}
        </ul>
      )}
      {items.length < CHECK_LINES_MAX && (
        <div className="flex items-center gap-2">
          <Input
            inputSize="sm"
            dir="auto"
            maxLength={CHECK_LINE_MAX}
            value={draft}
            placeholder={t(`tasks.${kind}.placeholder`)}
            aria-label={t(`tasks.${kind}.add`)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            data-testid={`task-${kind}-input`}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<IconPlus size={14} />}
            disabled={draft.trim() === ''}
            onClick={add}
            data-testid={`task-${kind}-add`}
          >
            {t(`tasks.${kind}.add`)}
          </Button>
        </div>
      )}
    </section>
  );
}

/** The list as the hub will keep it: trimmed, empty lines dropped. */
export function cleanLines(items: CheckItem[]): CheckItem[] {
  return items
    .map((item) => ({ text: item.text.trim(), checked: item.checked }))
    .filter((item) => item.text !== '');
}

export function sameLines(a: CheckItem[], b: CheckItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => item.text === b[index]?.text && item.checked === b[index]?.checked)
  );
}
