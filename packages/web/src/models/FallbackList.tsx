/**
 * The chat model's fallback chain on the Defaults tab (contract decision §54): an ordered
 * list the person adds to, reorders and removes from. The order is the order the hub tries
 * them in when the chat model's provider fails, so it is shown numbered.
 *
 * Reordering is by dragging (owner, 2026-09-26: «الفيل باك خله سحب وترتيب مهب كذا أزرار»):
 * each row has a grip, and the numbers follow the row being dragged, so the new place is read
 * before it is dropped. dnd-kit's keyboard sensor makes the grip a keyboard control too —
 * Space picks the row up, the arrows move it, Space drops it, Escape puts it back — and every
 * step is announced in the reader's language. The row's ✕ removes it.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import type { Model } from '../types.js';
import { Button, Combobox, Label } from '../ui/index.js';
import { IconClose, IconGrip } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { addFallback, removeFallback, reorderFallback } from './fallbacks.js';
import { chatModels, parseRef, refValue, type ModelRef } from './queries.js';
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
  const chat = chatModels(models);
  const nameOf = (ref: ModelRef) => {
    const model = chat.find((m) => m.provider_id === ref.provider_id && m.model === ref.model);
    return model ? (model.alias ?? model.key) : ref.model;
  };
  const taken = new Set([...chain.map(refValue), refValue(primary)]);
  const options = chat
    .filter((model) => !taken.has(refValue(model)))
    .map((model) => modelOption(model, refValue(model)));

  // While a row is dragged the list is shown in the order it would have if dropped now, so
  // the numbers change as it moves; the chain itself changes once, on the drop.
  const [preview, setPreview] = useState<string[] | null>(null);
  const values = chain.map(refValue);
  const order = preview ?? values;
  const byValue = new Map(chain.map((ref) => [refValue(ref), ref]));
  const shown = order.map((value) => byValue.get(value)).filter((ref) => ref !== undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || active.id === over.id) return;
    const current = preview ?? values;
    const from = current.indexOf(String(active.id));
    const to = current.indexOf(String(over.id));
    if (from >= 0 && to >= 0) setPreview(arrayMove(current, from, to));
  };
  const onDragEnd = ({ active }: DragEndEvent) => {
    const final = preview;
    setPreview(null);
    if (!final) return;
    const next = reorderFallback(chain, String(active.id), final.indexOf(String(active.id)));
    if (next.some((ref, at) => refValue(ref) !== values[at])) onChange(next);
  };

  /** Where a row is, as a person counts: 1 to the length of the chain. */
  const place = (id: string | number, list: readonly string[] = order) => ({
    model: nameOf(byValue.get(String(id)) ?? { provider_id: '', model: String(id) }),
    position: String(list.indexOf(String(id)) + 1),
    total: String(chain.length),
  });
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('models.defaults.fallback_picked', place(active.id, values)),
    onDragOver: ({ active }) => t('models.defaults.fallback_moved', place(active.id)),
    onDragEnd: ({ active }) => t('models.defaults.fallback_dropped', place(active.id)),
    onDragCancel: ({ active }) =>
      t('models.defaults.fallback_cancelled', place(active.id, values)),
  };

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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => setPreview(null)}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('models.defaults.fallback_instructions') },
          }}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ol className="fallback-list" data-testid="fallback-list">
              {shown.map((ref, index) => (
                <FallbackRow
                  key={refValue(ref)}
                  value={refValue(ref)}
                  model={ref.model}
                  name={nameOf(ref)}
                  position={index + 1}
                  disabled={disabled}
                  onRemove={() =>
                    onChange(removeFallback(chain, chain.findIndex((c) => c === ref)))
                  }
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
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

/** One model of the chain: its grip, its place, its name and its ✕. */
function FallbackRow({
  value,
  model,
  name,
  position,
  disabled,
  onRemove,
}: {
  value: string;
  model: string;
  name: string;
  position: number;
  disabled: boolean;
  onRemove(): void;
}) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: value, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`fallback-row ${isDragging ? 'fallback-row-dragging' : ''}`}
      data-testid="fallback-item"
      data-model={model}
      data-position={position}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="fallback-grip"
        aria-label={t('models.defaults.fallback_reorder', { model: name })}
        disabled={disabled}
        data-testid="fallback-grip"
        {...attributes}
        {...listeners}
      >
        <IconGrip size={14} />
      </button>
      <span className="fallback-place" data-testid="fallback-place">
        {position}
      </span>
      <span className="min-w-0 grow truncate text-sm" dir="ltr">
        {name}
      </span>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon={<IconClose size={14} />}
        aria-label={t('models.defaults.fallback_remove', { model: name })}
        tooltip={t('models.defaults.fallback_remove', { model: name })}
        disabled={disabled}
        onClick={onRemove}
        data-testid="fallback-remove"
      />
    </li>
  );
}
