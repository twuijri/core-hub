/**
 * A category's colour (contract `SessionCategory.color`, picked since decision §102): a dot
 * before its name in the chats list, chosen from eight swatches or none.
 *
 * A fixed set rather than a free picker: each swatch was chosen to read as itself on the light
 * and the dark surface alike, so a category that is "the red one" on the laptop is the red one
 * on the phone at night. What is stored is the `#rrggbb` the contract asks for, so every
 * client draws the same colour whichever set it offers.
 */
import { useI18n } from '../i18n/context.js';
import { Button, Dialog } from '../ui/index.js';
import { IconCheck } from '../ui/icons.js';

export const CATEGORY_COLOURS = [
  { id: 'blue', hex: '#3b82f6' },
  { id: 'green', hex: '#22a06b' },
  { id: 'amber', hex: '#d97706' },
  { id: 'red', hex: '#dc2626' },
  { id: 'purple', hex: '#8b5cf6' },
  { id: 'pink', hex: '#db2777' },
  { id: 'teal', hex: '#0d9488' },
  { id: 'slate', hex: '#64748b' },
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The dot before a category's name; nothing for a category with no colour. */
export function CategoryDot({ color }: { color: string | null | undefined }) {
  if (!color || !HEX.test(color)) return null;
  return (
    <span
      className="session-group-dot"
      style={{ backgroundColor: color }}
      aria-hidden
      data-testid="session-group-dot"
      data-color={color.toLowerCase()}
    />
  );
}

export function CategoryColourDialog({
  name,
  color,
  onChoose,
  onClose,
}: {
  name: string;
  color: string | null;
  onChoose(next: string | null): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const current = color?.toLowerCase() ?? null;
  const choose = (next: string | null) => {
    if (next !== current) onChoose(next);
    onClose();
  };
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(open) => !open && onClose()}
      title={t('sessions.categories.colour_title', { name })}
      closeLabel={t('common.cancel')}
      testId="category-colour"
      footer={
        <Button variant="ghost" onClick={() => choose(null)} data-testid="category-colour-none">
          {t('sessions.categories.colour_none')}
        </Button>
      }
    >
      <div className="category-swatches" role="group" aria-label={t('sessions.categories.colour')}>
        {CATEGORY_COLOURS.map((swatch) => {
          const on = current === swatch.hex;
          return (
            <button
              key={swatch.id}
              type="button"
              className="category-swatch"
              style={{ backgroundColor: swatch.hex }}
              aria-pressed={on}
              aria-label={t(`sessions.categories.colours.${swatch.id}`)}
              onClick={() => choose(swatch.hex)}
              data-testid="category-swatch"
              data-color={swatch.hex}
            >
              {on && <IconCheck size={14} />}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
