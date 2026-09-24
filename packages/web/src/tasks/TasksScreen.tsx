/**
 * The Tasks section: an intake strip and four columns, as the board we built for Hermes
 * has (owner, 2026-09-22). The shape of the work, not the shape of the data — the hub's
 * nine statuses live inside four columns, and the card says which stage it is in.
 *
 * Three things this screen refuses to do:
 *
 * - **It never offers a drop the hub would refuse.** `board.ts` decides what a drop into
 *   a column means; a card that cannot go there is not a drop target at all.
 * - **It never guesses between two meanings.** Dropping into *waiting* is either "schedule
 *   it" or "it is blocked", so it asks which.
 * - **It never sends a request that is going to fail.** Blocking needs a reason, so it
 *   asks for one first; archiving is terminal, so it confirms.
 *
 * Every drag has a keyboard equivalent (dnd-kit's keyboard sensor), and the card's own
 * menu moves it with no dragging at all — which is what a phone uses.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { describeError } from '../auth/client.js';
import { agentMark } from '../ui/brand/marks.js';
import { Tooltip } from '../ui/Tooltip.js';
import { ProfileScope, useAuth } from '../auth/context.js';
import { chatHref } from '../chat/anchor.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles, useProfileInLink, useProfileName } from '../shell/profiles.js';
import {
  Badge,
  Button,
  Dialog,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  Select,
  Skeleton,
  SkeletonGroup,
  useConfirm,
  usePrompt,
} from '../ui/index.js';
import { IconGrip, IconMore, IconPlus, IconSchedules, IconStop, IconTrash } from '../ui/icons.js';
import { AssignDialog } from './AssignDialog.js';
import { describeTaskError } from './errors.js';
import { HandOverDialog } from './HandOverDialog.js';
import { TaskDialog } from './TaskDialog.js';
import {
  COLUMNS,
  INTAKE_STATUS,
  cardFrame,
  columnOf,
  dropOptions,
  isColumnCollapsed,
  isDropTarget,
  quickActionFor,
  quickActionTarget,
  showsStatusWord,
  transitionFor,
  type ColumnDef,
  type ColumnDrop,
  type TaskStatus,
} from './board.js';
import {
  useArchive,
  useBoard,
  useCreateTask,
  useDeleteTask,
  useMoveTask,
  useProjects,
  useStopTask,
  useTaskEvents,
  useUnassignTask,
  useUpdateTask,
  type Task,
} from './queries.js';

/** What a card can ask of the board beyond moving: the agent side of a task. */
export interface CardActions {
  onMove(status: TaskStatus): void;
  onRename(): void;
  /** Open the task on its own: its words, priority and comments. */
  onEdit(): void;
  onDelete(): void;
  onAssign(): void;
  /** A Hermes card: hand it to another workspace's Hermes profile. */
  onHandOver(): void;
  onStop(): void;
  onUnassign(): void;
}

export function TasksScreen() {
  const { t } = useI18n();
  const title = t(termKey('tasks'));
  const projects = useProjects();
  const projectItems = projects.data?.items ?? [];
  // Every profile, always, with no profile filter (ADR 0016, owner 2026-09-24: «الكرون جوب
  // والمهام المفروض تطلع كل البروفايلات بدون تصنيف»). The project filter narrows; it is not a
  // prerequisite (owner decision, 2026-09-23).
  const [projectId, setProjectId] = useState<string>('');
  const filter = projectId ? { projectId } : {};
  // Where a new task is made: the profile the person is in, named when there are several.
  const { homeProfile } = useAuth();
  const many = useManyProfiles();
  const profileName = useProfileName();
  const newTaskLabel = many
    ? t('tasks.new_task_in', { name: profileName(homeProfile) })
    : t('tasks.new_task');
  const board = useBoard(filter);
  // The archive behind Done, read-only: counted for its link, shown when asked for.
  const archive = useArchive(filter);
  const createTask = useCreateTask();
  const move = useMoveTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const stop = useStopTask();
  const unassign = useUnassignTask();
  useTaskEvents();
  /** The task whose "assign to an agent" dialog is open. */
  const [assigning, setAssigning] = useState<Task | null>(null);
  /** The task open on its own (details and comments). */
  const [editing, setEditing] = useState<Task | null>(null);
  /** The Hermes card being handed to another workspace. */
  const [handing, setHanding] = useState<Task | null>(null);
  const { ask, dialog } = useConfirm();
  const { ask: askText, dialog: textDialog } = usePrompt();
  const [draft, setDraft] = useState('');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [dragging, setDragging] = useState<TaskStatus | null>(null);
  /** A drop that could mean two things, waiting for the person to say which. */
  const [choice, setChoice] = useState<{ task: Task; options: ColumnDrop[] } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** The hub's nine columns, regrouped into the four the board shows. */
  const grouped = useMemo(() => {
    const byStatus = new Map<string, Task[]>();
    for (const column of board.data?.columns ?? []) byStatus.set(column.status, column.tasks);
    const intake = byStatus.get(INTAKE_STATUS) ?? [];
    const columns = new Map<string, Task[]>();
    for (const column of COLUMNS) {
      // The archive lives behind `done` (its own query and link), not among its cards.
      columns.set(
        column.id,
        column.statuses.flatMap((status) => byStatus.get(status) ?? []),
      );
    }
    return { intake, columns };
  }, [board.data]);

  const byId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of grouped.intake) map.set(task.id, task);
    for (const tasks of grouped.columns.values()) for (const task of tasks) map.set(task.id, task);
    return map;
  }, [grouped]);

  const apply = (task: Task, drop: ColumnDrop) => {
    if (drop.transition.requiresReason) {
      void askText({
        title: t('tasks.blocked_why'),
        label: t('tasks.reason'),
        confirmLabel: t('common.save'),
      }).then((reason) => {
        if (reason !== null)
          move.mutate({ id: task.id, profile: task.profile, status: drop.to, reason });
      });
      return;
    }
    if (drop.transition.confirm) {
      void ask({
        title: t(`tasks.confirm.${drop.transition.action}`, { title: task.title }),
        confirmLabel: t(`tasks.action.${drop.transition.action}`),
      }).then((sure) => {
        if (sure) move.mutate({ id: task.id, profile: task.profile, status: drop.to });
      });
      return;
    }
    move.mutate({ id: task.id, profile: task.profile, status: drop.to });
  };

  /**
   * A move from a card's own button or menu means what the same drop would: blocking asks
   * why and archiving asks first, whichever way the person got there.
   */
  const moveTo = (task: Task, status: TaskStatus) => {
    const found = transitionFor(task.status, status);
    if (found) apply(task, { to: status, transition: found });
    else move.mutate({ id: task.id, profile: task.profile, status });
  };

  const actionsFor = (task: Task): CardActions => ({
    onMove: (status) => moveTo(task, status),
    onRename: () =>
      void askText({
        title: t('tasks.rename'),
        label: t('tasks.title_label'),
        initialValue: task.title,
        confirmLabel: t('common.save'),
      }).then((value) => {
        if (value) update.mutate({ id: task.id, profile: task.profile, patch: { title: value } });
      }),
    onEdit: () => setEditing(task),
    onDelete: () =>
      void ask({
        title: t('tasks.confirm_delete', { title: task.title }),
        // A Hermes card goes from Hermes's board too: the person should know before.
        body: t(
          task.external?.source === 'hermes'
            ? 'tasks.hermes.confirm_delete_body'
            : 'tasks.confirm_delete_body',
        ),
        confirmLabel: t('common.delete'),
      }).then((sure) => {
        if (sure) remove.mutate({ id: task.id, profile: task.profile });
      }),
    onAssign: () => setAssigning(task),
    onHandOver: () => setHanding(task),
    onStop: () => stop.mutate({ id: task.id, profile: task.profile }),
    onUnassign: () => unassign.mutate({ id: task.id, profile: task.profile }),
  });

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;
    const task = byId.get(String(active.id));
    if (!task) return;
    const overId = String(over.id);
    const columnId = overId.startsWith('column:')
      ? overId.slice('column:'.length)
      : columnOf(byId.get(overId)?.status ?? task.status);
    const column = COLUMNS.find((candidate) => candidate.id === columnId);
    if (!column) return;
    const options = dropOptions(task.status, column);
    // Inside the same column a drop is a reorder, which the hub keeps by position.
    if (options.length === 0) {
      const target = byId.get(overId);
      if (target && target.id !== task.id && column.statuses.includes(task.status)) {
        move.mutate({
          id: task.id,
          profile: task.profile,
          status: task.status,
          after_task_id: target.id,
        });
      }
      return;
    }
    if (options.length === 1) {
      apply(task, options[0]!);
      return;
    }
    // Two meanings: the person says which, rather than the code picking one.
    setChoice({ task, options });
  };

  if (projects.isPending) {
    return (
      <AppShell title={title}>
        <SkeletonGroup label={t('common.loading')}>
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="12rem" radius="md" />
            ))}
          </div>
        </SkeletonGroup>
      </AppShell>
    );
  }

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        {/* A filter only when there is something to filter: a picker with one option is a
            control that costs a glance and answers nothing. Never a profile filter. */}
        {projectItems.length > 1 && (
          <Select
            value={projectId}
            placeholder={t('tasks.all_projects')}
            onValueChange={(value) => setProjectId(value ?? '')}
            options={projectItems.map((project) => ({ value: project.id, label: project.name }))}
            label={t('tasks.project')}
            testId="project-filter"
          />
        )}
        <Badge>{t('tasks.count', { count: board.data?.counts.total ?? 0 })}</Badge>
        <span className="ms-auto flex items-center gap-2">
          <Input
            inputSize="sm"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim()) {
                createTask.mutate({ title: draft.trim() });
                setDraft('');
              }
            }}
            placeholder={newTaskLabel}
            aria-label={newTaskLabel}
            data-testid="new-task-input"
            data-profile={homeProfile}
          />
          <Button
            size="sm"
            icon={<IconPlus size={14} />}
            disabled={draft.trim() === ''}
            loading={createTask.isPending}
            onClick={() => {
              createTask.mutate({ title: draft.trim() });
              setDraft('');
            }}
            data-testid="new-task"
          >
            {t('tasks.add')}
          </Button>
        </span>
      </header>

      {board.isError && <Notice tone="danger">{describeError(board.error, t)}</Notice>}
      {(move.isError ||
        createTask.isError ||
        update.isError ||
        remove.isError ||
        stop.isError ||
        unassign.isError) && (
        <Notice tone="danger">
          {describeTaskError(
            move.error ??
              createTask.error ??
              update.error ??
              remove.error ??
              stop.error ??
              unassign.error,
            t,
          )}
        </Notice>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event: DragStartEvent) =>
          setDragging(byId.get(String(event.active.id))?.status ?? null)
        }
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="task-board" data-testid="task-board">
          {/* Intake: a task arrives here and is specified before it joins the queue, so
              nothing is ever dropped in. It is a strip until somebody opens it. */}
          <aside
            className="task-intake"
            data-open={intakeOpen ? 'true' : undefined}
            data-testid="task-intake"
            aria-label={t('tasks.status.triage')}
          >
            <button
              type="button"
              className="task-intake-toggle"
              aria-expanded={intakeOpen}
              onClick={() => setIntakeOpen((open) => !open)}
              data-testid="task-intake-toggle"
            >
              <span className="task-strip-title">{t('tasks.status.triage')}</span>
              <span className="task-strip-count">{grouped.intake.length}</span>
            </button>
            {intakeOpen && (
              <div className="task-column-body">
                <p className="task-intake-hint">{t('tasks.intake_hint')}</p>
                {grouped.intake.map((task) => (
                  <TaskCard key={task.id} task={task} actions={actionsFor(task)} />
                ))}
                {grouped.intake.length === 0 && (
                  <p className="task-column-empty">{t('tasks.nothing')}</p>
                )}
              </div>
            )}
          </aside>

          {COLUMNS.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              tasks={grouped.columns.get(column.id) ?? []}
              dragging={dragging}
              actionsFor={actionsFor}
              {...(column.id === 'done' ? { archived: archive.data ?? [] } : {})}
            />
          ))}
        </div>
      </DndContext>

      <Dialog
        open={choice !== null}
        onOpenChange={(open) => !open && setChoice(null)}
        title={t('tasks.which_waiting')}
        closeLabel={t('common.cancel')}
        testId="task-drop-choice"
      >
        <div className="flex flex-col gap-2">
          {choice?.options.map((option) => (
            <Button
              key={option.to}
              variant="secondary"
              onClick={() => {
                const pending = choice;
                setChoice(null);
                if (pending) apply(pending.task, option);
              }}
              data-choice={option.transition.action}
            >
              {t(`tasks.action.${option.transition.action}`)}
            </Button>
          ))}
        </div>
      </Dialog>
      {/* Each dialog works in the card's own profile: its agents, its header — not the
          profile the person is in (ADR 0016). */}
      <InProfile profile={assigning?.profile}>
        <AssignDialog task={assigning} onClose={() => setAssigning(null)} />
      </InProfile>
      <InProfile profile={editing?.profile}>
        <TaskDialog task={editing} onClose={() => setEditing(null)} />
      </InProfile>
      <InProfile profile={handing?.profile}>
        <HandOverDialog task={handing} onClose={() => setHanding(null)} />
      </InProfile>
      {dialog}
      {textDialog}
    </AppShell>
  );
}

/** Everything inside speaks for `profile` when there is one (a card's), else for the person. */
function InProfile({ profile, children }: { profile: string | undefined; children: ReactNode }) {
  return profile ? <ProfileScope profile={profile}>{children}</ProfileScope> : <>{children}</>;
}

function BoardColumn({
  column,
  tasks,
  dragging,
  actionsFor,
  archived,
}: {
  column: ColumnDef;
  tasks: Task[];
  dragging: TaskStatus | null;
  actionsFor(task: Task): CardActions;
  /** Done only: the archive behind it, shown read-only when the person asks. */
  archived?: Task[];
}) {
  const { t } = useI18n();
  const [openedByHand, setOpenedByHand] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });
  // An empty column that keeps a full slot pushes the work off the screen, and one that
  // stays shut while a card is heading for it is worse (board.ts, `isColumnCollapsed`).
  const collapsed = isColumnCollapsed(column, {
    count: tasks.length,
    openedByHand,
    dragging,
  });
  const accepts = dragging === null || isDropTarget(dragging, column);

  return (
    <section
      ref={setNodeRef}
      className={`task-column column-${column.id}`}
      data-collapsed={collapsed ? 'true' : undefined}
      data-refuses={accepts ? undefined : 'true'}
      data-over={isOver && accepts ? 'true' : undefined}
      data-column={column.id}
      aria-label={t(`tasks.columns.${column.id}`)}
    >
      {column.collapsible ? (
        <button
          type="button"
          className="task-column-head task-strip-toggle"
          aria-expanded={!collapsed}
          onClick={() => setOpenedByHand((open) => !open)}
          data-testid={`column-toggle-${column.id}`}
        >
          <span className="task-strip-title">{t(`tasks.columns.${column.id}`)}</span>
          <span className="task-strip-count">{tasks.length}</span>
        </button>
      ) : (
        <header className="task-column-head">
          <span className="font-medium">{t(`tasks.columns.${column.id}`)}</span>
          <span className="text-xs text-muted">{tasks.length}</span>
        </header>
      )}
      {!collapsed && (
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="task-column-body" data-column-body={column.id}>
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} actions={actionsFor(task)} />
            ))}
            {tasks.length === 0 && <li className="task-column-empty">{t('tasks.nothing')}</li>}
            {archived && archived.length > 0 && (
              <li className="task-archive">
                <button
                  type="button"
                  className="task-archive-toggle"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((open) => !open)}
                  data-testid="task-archive-toggle"
                >
                  {t(showArchived ? 'tasks.hide_archived' : 'tasks.show_archived', {
                    count: archived.length,
                  })}
                </button>
                {showArchived && (
                  <ul className="task-archive-list" data-testid="task-archive">
                    {archived.map((task) => (
                      <ArchivedCard key={task.id} task={task} />
                    ))}
                  </ul>
                )}
              </li>
            )}
          </ul>
        </SortableContext>
      )}
    </section>
  );
}

export function TaskCard({ task, actions }: { task: Task; actions: CardActions }) {
  const { t } = useI18n();
  const many = useManyProfiles();
  const inLink = useProfileInLink();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const quick = quickActionFor(task.status);
  // The column groups several statuses, so the card is where the stage is readable: a
  // frame drawn for the stage (board.ts, `cardFrame`) and the word beside it, so neither
  // colour nor motion is the only thing that says it.
  const showsStatus = showsStatusWord(task.status);
  const frame = cardFrame(task.status);
  // A card on Hermes's own board: the hub mirrors it, and every change is made on Hermes
  // first (the hub answers with Hermes's refusal, in Hermes's words, when Hermes says no).
  const fromHermes = task.external?.source === 'hermes';
  const running = task.status === 'running';
  const open = task.status !== 'done' && task.status !== 'archived';
  // A task can be given to an agent until it is finished; a Hermes card is handed to
  // another workspace's Hermes profile instead, because Hermes's dispatcher runs it.
  const assignable = !fromHermes && open;
  const handable = fromHermes && open;
  const agent = task.assignee?.kind === 'agent' ? task.assignee : null;
  // The hub names the agent (DECISIONS §31): the card may be from a profile whose agents
  // this page never asked for, so the client does not guess.
  const agentName = agent?.name ?? null;
  // The conversation opens in the task's own profile, from the address (`?profile=`), the
  // way the chats list opens one — the top selector does not move (ADR 0016).
  const sessionHref = task.session_id
    ? chatHref(task.session_id, null, undefined, task.profile ? inLink(task.profile) : null)
    : null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-card status-${task.status} ${isDragging ? 'sortable-dragging' : ''}`}
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
      data-frame={frame ?? undefined}
      data-external={fromHermes ? 'hermes' : undefined}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="task-card-grip"
        aria-label={t('tasks.reorder', { title: task.title })}
        {...attributes}
        {...listeners}
      >
        <IconGrip size={14} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" dir="auto">
          {task.title}
        </p>
        <span className="task-card-meta">
          {fromHermes && (
            <Tooltip label={t('tasks.hermes.origin')}>
              <span
                className="task-card-origin"
                role="img"
                aria-label={t('tasks.hermes.origin')}
                data-testid="task-origin-hermes"
              >
                {agentMark('hermes', 14)}
              </span>
            </Tooltip>
          )}
          {showsStatus && <StatusBadge status={task.status} />}
          {/* Which profile the card is from, whenever the board can hold more than one. */}
          {many && task.profile && <ProfileBadge profile={task.profile} testId="task-profile" />}
          {agent && (
            <span className="truncate text-xs text-muted" dir="auto" data-testid="task-agent">
              {agentName}
            </span>
          )}
          {task.priority !== 'normal' && (
            <Badge tone={task.priority === 'urgent' ? 'danger' : 'warning'}>
              {t(`tasks.priority.${task.priority}`)}
            </Badge>
          )}
          {task.subtask_counts.total > 0 && (
            <span className="text-xs text-muted">
              {task.subtask_counts.done}/{task.subtask_counts.total}
            </span>
          )}
          {task.blocked_reason && (
            // A reason cut short on the card is read whole on hover or focus.
            <Tooltip label={task.blocked_reason}>
              <span
                className="truncate text-xs text-danger-soft-text"
                dir="auto"
                tabIndex={0}
                data-testid="task-blocked-reason"
              >
                {task.blocked_reason}
              </span>
            </Tooltip>
          )}
        </span>
        {/* What the agent said when it finished: the card says it, the conversation has the rest. */}
        {task.latest_summary && task.status === 'review' && (
          <p className="task-card-summary" dir="auto" data-testid="task-summary">
            {task.latest_summary}
          </p>
        )}
        {sessionHref && (
          <Link
            to={sessionHref}
            className="task-card-session"
            data-testid="task-session"
          >
            {t('tasks.open_session')}
          </Link>
        )}
      </div>
      {running ? (
        <Button
          variant="ghost"
          size="sm"
          className="task-card-quick"
          icon={<IconStop size={12} />}
          onClick={actions.onStop}
          data-testid="task-stop"
        >
          {t('tasks.stop')}
        </Button>
      ) : (
        quick && (
          <Button
            variant="ghost"
            size="sm"
            className="task-card-quick"
            onClick={() => actions.onMove(quickActionTarget(quick))}
            data-testid="task-quick"
            data-action={quick}
          >
            {t(`tasks.action.${quick}`)}
          </Button>
        )
      )}
      <Menu
        align="end"
        testId="task-menu"
        tooltip={t('common.more')}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('tasks.more', { title: task.title })}
            icon={<IconMore size={14} />}
            data-testid="task-more"
          />
        }
      >
        {assignable && (
          <MenuItem onSelect={actions.onAssign}>
            {t(agent ? 'tasks.assign.again' : 'tasks.assign.open')}
          </MenuItem>
        )}
        {handable && <MenuItem onSelect={actions.onHandOver}>{t('tasks.handover.open')}</MenuItem>}
        {running && (
          <MenuItem icon={<IconStop size={14} />} onSelect={actions.onStop}>
            {t('tasks.stop')}
          </MenuItem>
        )}
        {agent && !fromHermes && (
          <MenuItem onSelect={actions.onUnassign}>{t('tasks.unassign')}</MenuItem>
        )}
        {(assignable || handable) && <MenuSeparator />}
        <MenuItem onSelect={actions.onEdit}>{t('tasks.details.open')}</MenuItem>
        <MenuItem onSelect={actions.onRename}>{t('tasks.rename')}</MenuItem>
        <MenuSeparator />
        {/* Only the moves the hub would accept, so the menu never offers a dead end. */}
        {COLUMNS.flatMap((column) => dropOptions(task.status, column)).map((option) => (
          <MenuItem key={option.to} onSelect={() => actions.onMove(option.to)}>
            {t(`tasks.action.${option.transition.action}`)}
          </MenuItem>
        ))}
        {/* A Hermes card is deleted on Hermes first, so it does not come back on the next read. */}
        <MenuSeparator />
        <MenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={actions.onDelete}>
          {t('common.delete')}
        </MenuItem>
      </Menu>
    </li>
  );
}

/** The stage as a word, in the stage's own tone: what the frame says, said for everyone. */
function StatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useI18n();
  return (
    <Badge
      tone={STATUS_TONE[status] ?? 'neutral'}
      className={`task-status task-status-${status}`}
      testId="task-status"
    >
      {status === 'running' && <span className="task-card-live" aria-hidden="true" />}
      {status === 'scheduled' && (
        <IconSchedules size={12} className="task-status-icon" data-testid="task-clock" />
      )}
      {t(`tasks.status.${status}`)}
    </Badge>
  );
}

/** Review has a tone of its own (purple), painted by `.task-status-review`. */
const STATUS_TONE: Partial<Record<TaskStatus, 'success' | 'danger' | 'warning' | 'info'>> = {
  running: 'success',
  blocked: 'danger',
  scheduled: 'warning',
  ready: 'info',
};

/**
 * A card in the archive: read-only. It is there to be found again, not worked — no grip,
 * no menu, no quick action; the title, where it came from, and the word "archived".
 */
function ArchivedCard({ task }: { task: Task }) {
  const { t } = useI18n();
  const many = useManyProfiles();
  const fromHermes = task.external?.source === 'hermes';
  return (
    <li
      className="task-card task-card-archived"
      data-testid="task-card-archived"
      data-task-id={task.id}
      data-status={task.status}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" dir="auto">
          {task.title}
        </p>
        <span className="task-card-meta">
          {fromHermes && (
            <span className="task-card-origin" role="img" aria-label={t('tasks.hermes.origin')}>
              {agentMark('hermes', 14)}
            </span>
          )}
          <StatusBadge status={task.status} />
          {many && task.profile && <ProfileBadge profile={task.profile} testId="task-profile" />}
        </span>
      </div>
    </li>
  );
}
