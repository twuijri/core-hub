/**
 * The agents of this workspace, as one segmented control directly above the composer
 * (ADOPTION-BACKLOG 2.5, 2.9): a fresh hub shows Hermes alone and every agent that is
 * installed adds an option. The list comes from the server registry — the client never
 * keeps one (NAVIGATION rule 5).
 *
 * It is the shared control (`src/ui/Segmented.tsx`), so it is the same object as the
 * sidebar's section row and the session filter, with two additions:
 *
 * - the options can be dragged into the order a person wants, remembered per workspace
 *   (`agentOrder.ts`). The track's arrows move between options; dnd-kit's keyboard sensor
 *   picks one up with Space and drops it with Space, so the drag keeps a keyboard
 *   equivalent as DESIGN requires;
 * - the trailing "+" is an action, not an agent: it goes to the Agent Manager, where an
 *   agent is installed from the catalog.
 *
 * With many agents installed the track gives up labels before it gives up options, and
 * only then moves the rest into its More menu — all of that is the control's own rule
 * (`src/ui/segmented-fit.ts`), not something the agent row decides.
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
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import type { Agent } from '../types.js';
import { IconPlus } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { SegmentedItem, SegmentedTrack } from '../ui/Segmented.js';
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
  /** In an open session the agent of that session is the current one; the others start a new chat. */
  mode = 'select',
}: {
  selectedId: string | null;
  onSelect(agent: Agent): void;
  mode?: 'select' | 'current';
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
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
        <div className="mb-2 flex min-w-0 px-1">
          <SegmentedTrack
            label={t('composer.agents')}
            value={selectedId}
            onChange={(id) => {
              const agent = items.find((a) => a.id === id);
              if (agent) onSelect(agent);
            }}
            overflow
            className="min-w-0 flex-1"
            testId="agent-chips"
            action={{
              label: t('composer.add_agent'),
              icon: <IconPlus size={16} />,
              onSelect: () => navigate(routeOf('agent_manager')),
              testId: 'agent-add',
            }}
          >
            {items.map((agent) => (
              <AgentOption
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedId}
                mode={mode}
              />
            ))}
          </SegmentedTrack>
        </div>
      </SortableContext>
    </DndContext>
  );
}

function AgentOption({
  agent,
  selected,
  mode,
}: {
  agent: Agent;
  selected: boolean;
  mode: 'select' | 'current';
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
    <SegmentedItem
      ref={setNodeRef}
      value={agent.id}
      disabled={!ready}
      title={hint}
      icon={
        // The generated initial is the agent's icon, so compact mode never shows a blank.
        <span className="mj-segment-mark" aria-hidden>
          {agent.name.slice(0, 1)}
        </span>
      }
      label={
        <span dir="auto">
          {agent.name}
          {!ready && ` · ${t(`agents.status.${agent.status}`)}`}
        </span>
      }
      itemProps={{
        ...attributes,
        ...listeners,
        style: { transform: CSS.Transform.toString(transform), transition },
        className: isDragging ? 'sortable-dragging' : '',
        'data-drag': 'true',
        'aria-label': hint,
        'data-testid': 'agent-chip',
        'data-agent-id': agent.id,
        'data-agent-slug': agent.slug,
      }}
    />
  );
}
