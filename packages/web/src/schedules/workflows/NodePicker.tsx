/**
 * The searchable list a step or a trigger is added from (owner, 2026-09-29: "like n8n"):
 * opened by a "+" on the canvas, by "Add step" / "Add trigger", or by dropping a
 * connection on empty canvas. Type to narrow it; the arrows move through what is left and
 * Enter adds the one marked.
 */
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { Dialog, Input } from '../../ui/index.js';
import {
  IconAgents,
  IconApproval,
  IconCondition,
  IconDelay,
  IconNotify,
  IconPlay,
  IconScheduleClock,
  IconSendMessage,
  IconWebhook,
} from '../../ui/icons.js';

/** What the picker offers. Steps are the drawing's kinds (plus "Send message"); triggers are records. */
export type PickedStep = 'agent' | 'condition' | 'delay' | 'approval' | 'send' | 'notify';
export type PickedTrigger = 'manual' | 'clickup' | 'github' | 'generic_hmac' | 'token' | 'schedule';
export type Picked =
  { group: 'step'; kind: PickedStep } | { group: 'trigger'; kind: PickedTrigger };

export const PICKER_STEPS: readonly PickedStep[] = [
  'agent',
  'condition',
  'delay',
  'approval',
  'send',
  'notify',
];
export const PICKER_TRIGGERS: readonly PickedTrigger[] = [
  'manual',
  'clickup',
  'github',
  'generic_hmac',
  'token',
  'schedule',
];

const STEP_ICON: Record<PickedStep, ReactNode> = {
  agent: <IconAgents size={18} />,
  condition: <IconCondition size={18} />,
  delay: <IconDelay size={18} />,
  approval: <IconApproval size={18} />,
  send: <IconSendMessage size={18} />,
  notify: <IconNotify size={18} />,
};

const TRIGGER_ICON: Record<PickedTrigger, ReactNode> = {
  manual: <IconPlay size={18} />,
  clickup: <IconWebhook size={18} />,
  github: <IconWebhook size={18} />,
  generic_hmac: <IconWebhook size={18} />,
  token: <IconWebhook size={18} />,
  schedule: <IconScheduleClock size={18} />,
};

interface Row {
  picked: Picked;
  label: string;
  hint: string;
  icon: ReactNode;
  words: string;
}

export function NodePicker({
  open,
  mode,
  onClose,
  onPick,
  manualShown = false,
}: {
  open: boolean;
  /** Which list: steps, or triggers. */
  mode: 'step' | 'trigger';
  onClose: () => void;
  onPick: (picked: Picked) => void;
  /** "Run by hand" is drawn already: offered only when it is not. */
  manualShown?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const rows: Row[] = useMemo(() => {
    if (mode === 'step') {
      return PICKER_STEPS.map((kind) => {
        const label = kind === 'send' ? t('workflows.send.title') : t(`workflows.kinds.${kind}`);
        const hint = kind === 'send' ? t('workflows.send.hint') : t(`workflows.kind_hints.${kind}`);
        return {
          picked: { group: 'step', kind },
          label,
          hint,
          icon: STEP_ICON[kind],
          words: `${kind} ${label} ${hint}`.toLowerCase(),
        };
      });
    }
    return PICKER_TRIGGERS.filter((kind) => kind !== 'manual' || !manualShown).map((kind) => {
      const label = t(`workflows.nodes.trigger_kinds.${kind}`);
      const hint = t(`workflows.nodes.trigger_hints.${kind}`);
      return {
        picked: { group: 'trigger', kind },
        label,
        hint,
        icon: TRIGGER_ICON[kind],
        words: `${kind} ${label} ${hint}`.toLowerCase(),
      };
    });
  }, [mode, manualShown, t]);

  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => row.words.includes(needle)) : rows;
  const marked = Math.min(active, Math.max(shown.length - 1, 0));

  const choose = (row: Row | undefined) => {
    if (!row) return;
    setQuery('');
    setActive(0);
    onPick(row.picked);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((marked + 1) % Math.max(shown.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((marked - 1 + shown.length) % Math.max(shown.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(shown[marked]);
    }
  };

  const idOf = (row: Row) => `${listId}-${row.picked.kind}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('');
          setActive(0);
          onClose();
        }
      }}
      title={mode === 'step' ? t('workflows.nodes.pick_step') : t('workflows.nodes.pick_trigger')}
      size="md"
      closeLabel={t('ui.close')}
      testId="workflow-node-picker"
    >
      <Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={t('workflows.nodes.search')}
        aria-label={t('workflows.nodes.search')}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={shown[marked] ? idOf(shown[marked]!) : undefined}
        autoFocus
        dir="auto"
        data-testid="workflow-picker-search"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={
          mode === 'step' ? t('workflows.nodes.pick_step') : t('workflows.nodes.pick_trigger')
        }
        className="flex max-h-[26rem] flex-col gap-1 overflow-y-auto"
      >
        {shown.length === 0 && (
          <li className="px-2 py-3 text-sm text-muted" data-testid="workflow-picker-empty">
            {t('workflows.nodes.none_found')}
          </li>
        )}
        {shown.map((row, index) => (
          <li
            key={row.picked.kind}
            id={idOf(row)}
            role="option"
            aria-selected={index === marked}
            className={`flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 ${
              index === marked ? 'bg-surface-2 ring-1 ring-accent' : 'hover:bg-surface-2'
            }`}
            onPointerEnter={() => setActive(index)}
            onClick={() => choose(row)}
            data-testid={`workflow-pick-${row.picked.group === 'trigger' ? 'trigger-' : ''}${row.picked.kind}`}
          >
            <span
              className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-md ${
                row.picked.group === 'trigger'
                  ? 'bg-warning-soft text-warning-soft-text'
                  : 'bg-accent-soft text-accent-soft-text'
              }`}
              aria-hidden
            >
              {row.icon}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{row.label}</span>
              <span className="text-xs text-muted">{row.hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
