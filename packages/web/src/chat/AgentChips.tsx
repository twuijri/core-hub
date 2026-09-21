/**
 * The agents of this workspace, as chips directly above the composer (ADOPTION-BACKLOG 2.5,
 * 2.9): a fresh hub shows Hermes alone and every agent that is installed adds a chip. The
 * list itself comes from the server registry — the client never keeps one (NAVIGATION rule 5).
 *
 * The row is draggable and the order is remembered per workspace (`agentOrder.ts`). Every
 * drag has a keyboard equivalent, as DESIGN requires: focus the chip, Space to pick it up,
 * arrows to move, Space to drop — dnd-kit's keyboard sensor, the same one the session list
 * uses.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import type { Agent } from '../types.js';
import { Notice } from '../ui/Notice.js';
import {
  arrangeAgents,
  moveAgent,
  nextOrder,
  readAgentOrder,
  writeAgentOrder,
} from './agentOrder.js';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** The agents a person may actually start a chat with. */
export function selectableAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.enabled && agent.status !== 'disabled');
}

export function AgentChips({
  selectedId,
  onSelect,
  /** In an open session the chip of its agent is the current one; the others start a new chat. */
  mode = 'select',
}: {
  selectedId: string | null;
  onSelect(agent: Agent): void;
  mode?: 'select' | 'current';
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const agents = useAgents();
  const [manual, setManual] = useState<string[]>(() => readAgentOrder(storage(), profile));

  const items = useMemo(
    () => arrangeAgents(selectableAgents(agents.data ?? []), manual),
    [agents.data, manual],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((agent) => agent.id);
    const moved = moveAgent(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    const order = nextOrder(moved, manual);
    setManual(order);
    writeAgentOrder(storage(), profile, order);
  };

  if (agents.isError) {
    return (
      <Notice tone="danger" className="mb-2">
        {describeError(agents.error, t)}
      </Notice>
    );
  }
  if (items.length === 0) {
    // Never a silent empty row: say why there is nothing to pick.
    return agents.isPending ? null : (
      <p className="mb-2 px-1 text-xs text-muted" data-testid="agent-chips-empty">
        {t('new_chat.no_agents')}
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((a) => a.id)} strategy={horizontalListSortingStrategy}>
        <ul
          className="mb-2 flex flex-wrap items-center gap-1.5 px-1"
          aria-label={t('composer.agents')}
          data-testid="agent-chips"
        >
          {items.map((agent) => (
            <AgentChip
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedId}
              mode={mode}
              onSelect={() => onSelect(agent)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function AgentChip({
  agent,
  selected,
  mode,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  mode: 'select' | 'current';
  onSelect(): void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
  });
  const ready = agent.status !== 'not_installed' && agent.status !== 'error';
  const hint = !ready
    ? t('composer.agent_not_ready', { name: agent.name })
    : selected
      ? t('composer.agent_current', { name: agent.name })
      : mode === 'current'
        ? t('composer.agent_new_chat', { name: agent.name })
        : t('composer.agent_pick', { name: agent.name });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'sortable-dragging' : ''}
    >
      <button
        type="button"
        className="chip-agent"
        aria-current={selected && mode === 'current' ? 'true' : undefined}
        aria-label={hint}
        title={hint}
        disabled={!ready}
        data-testid="agent-chip"
        data-agent-id={agent.id}
        data-agent-slug={agent.slug}
        onClick={onSelect}
        {...attributes}
        {...listeners}
        // dnd-kit's sortable also sets aria-pressed; ours (is this the chosen agent?) wins.
        aria-pressed={selected}
      >
        <span className="chip-agent-mark" aria-hidden>
          {agent.name.slice(0, 1)}
        </span>
        <span className="truncate" dir="auto">
          {agent.name}
        </span>
        {!ready && <span className="text-xs text-muted">{t(`agents.status.${agent.status}`)}</span>}
      </button>
    </li>
  );
}
