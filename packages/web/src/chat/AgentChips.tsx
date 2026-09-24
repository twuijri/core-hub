/**
 * The **installed** agents of this workspace, as one segmented control directly above the
 * composer of an empty chat (ADOPTION-BACKLOG 2.5, 2.9).
 *
 * Owner decision, 2026-09-22: an agent that is not installed does not belong above the
 * composer — it is not a choice, it is an errand. Discovery and installation live in the
 * Agent Manager, which the trailing "+" already opens, and the moment an agent is
 * installed the registry says so and a chip appears. The row is therefore
 * `agents.list` filtered, never a list the client keeps (NAVIGATION rule 5), so an agent
 * added to the hub needs no change here at all.
 *
 * It belongs to an *empty* chat. Once a session has messages the question "which agent?"
 * has been answered, and the answer is shown quietly in the chat header instead
 * (`SessionAgent.tsx`), where changing it is a fork rather than a new chat.
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
import { canOpen, routeOf } from '../navigation/manifest.js';
import type { Agent } from '../types.js';
import { agentMark } from '../ui/brand/marks.js';
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

/**
 * The three `AgentStatus` values that mean "the hub has this agent on this host and can
 * run a turn with it". Stated as a positive list on purpose: `not_installed`, `installing`
 * (not yet) and `error` (the install did not take) all mean the same thing to a person
 * about to type a message — there is nothing here to talk to.
 */
const INSTALLED: ReadonlySet<Agent['status']> = new Set(['available', 'updating', 'limited']);

/** Enabled for this workspace: in the registry and not switched off. */
export function enabledAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.enabled && agent.status !== 'disabled');
}

/** Enabled *and* on this host — the only agents a person may actually start a chat with. */
export function installedAgents(agents: readonly Agent[]): Agent[] {
  return enabledAgents(agents).filter((agent) => INSTALLED.has(agent.status));
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
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  // The Agents page is for owners and admins; a member is not offered a way to it.
  const canManage = canOpen('agent_manager', user?.role ?? 'member');
  const agents = useAgents();
  const [manual, setManual] = useState<string[]>(() => readAgentOrder(storage(), profile));

  const items = useMemo(
    () => arrangeAgents(installedAgents(agents.data ?? []), manual),
    [agents.data, manual],
  );
  /** Told apart so the empty row can say which of the two silences this is. */
  const anyEnabled = enabledAgents(agents.data ?? []).length > 0;

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
    // Never a silent empty row: say which silence this is — a hub with no agent enabled,
    // or one whose agents are all still in the catalog waiting to be installed.
    return agents.isPending ? null : (
      <p className="mb-2 px-1 text-xs text-muted" data-testid="agent-chips-empty">
        {anyEnabled ? t('new_chat.none_installed') : t('new_chat.no_agents')}
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
            {...(canManage
              ? {
                  action: {
                    label: t('composer.add_agent'),
                    icon: <IconPlus size={16} />,
                    onSelect: () => navigate(routeOf('agent_manager')),
                    testId: 'agent-add',
                  },
                }
              : {})}
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
  // Every option here is installed, so none of them is ever disabled: a chip a person
  // cannot press is exactly what this row no longer contains.
  const hint = selected
    ? t('composer.agent_current', { name: agent.name })
    : mode === 'current'
      ? t('composer.agent_new_chat', { name: agent.name })
      : t('composer.agent_pick', { name: agent.name });
  return (
    <SegmentedItem
      ref={setNodeRef}
      value={agent.id}
      title={hint}
      icon={
        // An agent we ship wears its own mark; one we do not know keeps its initial, so
        // compact mode never shows a blank either way (owner decision, 2026-09-22).
        <span className="mj-segment-mark" aria-hidden>
          {agentMark(agent.slug, 14) ?? agent.name.slice(0, 1)}
        </span>
      }
      label={<span dir="auto">{agent.name}</span>}
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
