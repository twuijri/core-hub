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
import { useMemo, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
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
import { IconGrip, IconMore, IconPlus, IconTasks, IconTrash } from '../ui/icons.js';
import {
  COLUMNS,
  INTAKE_STATUS,
  columnOf,
  dropOptions,
  isDropTarget,
  quickActionFor,
  quickActionTarget,
  type ColumnDef,
  type ColumnDrop,
  type TaskStatus,
} from './board.js';
import {
  useBoard,
  useCreateProject,
  useCreateTask,
  useDeleteTask,
  useMoveTask,
  useProjects,
  useUpdateTask,
  type Task,
} from './queries.js';

export function TasksScreen() {
  const { t } = useI18n();
  const title = t(termKey('tasks'));
  const projects = useProjects();
  const [chosen, setChosen] = useState<string | null>(null);
  const items = projects.data?.items ?? [];
  const projectId = chosen ?? items[0]?.id ?? null;
  const board = useBoard(projectId);
  const createProject = useCreateProject();
  const createTask = useCreateTask(projectId);
  const move = useMoveTask(projectId);
  const update = useUpdateTask(projectId);
  const remove = useDeleteTask(projectId);
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
      const tasks = column.statuses.flatMap((status) => byStatus.get(status) ?? []);
      // The archive lives behind `done` rather than in a column of its own.
      if (column.id === 'done') tasks.push(...(byStatus.get('archived') ?? []));
      columns.set(column.id, tasks);
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
        if (reason !== null) move.mutate({ id: task.id, status: drop.to, reason });
      });
      return;
    }
    if (drop.transition.confirm) {
      void ask({
        title: t(`tasks.confirm.${drop.transition.action}`, { title: task.title }),
        confirmLabel: t(`tasks.action.${drop.transition.action}`),
      }).then((sure) => {
        if (sure) move.mutate({ id: task.id, status: drop.to });
      });
      return;
    }
    move.mutate({ id: task.id, status: drop.to });
  };

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
        move.mutate({ id: task.id, status: task.status, after_task_id: target.id });
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
      <AppShell title={title} wide>
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

  if (items.length === 0) {
    return (
      <AppShell title={title} wide>
        <h1 className="sr-only">{title}</h1>
        <EmptyState
          icon={<IconTasks size={20} />}
          title={t('tasks.no_projects')}
          body={t('tasks.no_projects_body')}
          action={
            <Button
              loading={createProject.isPending}
              onClick={() => {
                void askText({
                  title: t('tasks.new_project'),
                  label: t('tasks.project_name'),
                  confirmLabel: t('common.save'),
                }).then((name) => {
                  if (name) createProject.mutate({ name });
                });
              }}
              data-testid="new-project"
            >
              {t('tasks.new_project')}
            </Button>
          }
          testId="tasks-empty"
        />
        {textDialog}
      </AppShell>
    );
  }

  return (
    <AppShell title={title} wide>
      <h1 className="sr-only">{title}</h1>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          value={projectId}
          onValueChange={(value) => setChosen(value)}
          options={items.map((project) => ({ value: project.id, label: project.name }))}
          label={t('tasks.project')}
          testId="project-picker"
        />
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
            placeholder={t('tasks.new_task')}
            aria-label={t('tasks.new_task')}
            data-testid="new-task-input"
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
      {(move.isError || createTask.isError) && (
        <Notice tone="danger">{describeError(move.error ?? createTask.error, t)}</Notice>
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
              <span className="task-strip-count">{grouped.intake.length}</span>
              <span className="task-strip-title">{t('tasks.status.triage')}</span>
            </button>
            {intakeOpen && (
              <div className="task-column-body">
                <p className="task-intake-hint">{t('tasks.intake_hint')}</p>
                {grouped.intake.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onMove={(status) => move.mutate({ id: task.id, status })}
                    onRename={() =>
                      void askText({
                        title: t('tasks.rename'),
                        label: t('tasks.title_label'),
                        initialValue: task.title,
                        confirmLabel: t('common.save'),
                      }).then((value) => {
                        if (value) update.mutate({ id: task.id, patch: { title: value } });
                      })
                    }
                    onDelete={() =>
                      void ask({
                        title: t('tasks.confirm_delete', { title: task.title }),
                        body: t('tasks.confirm_delete_body'),
                        confirmLabel: t('common.delete'),
                      }).then((sure) => {
                        if (sure) remove.mutate(task.id);
                      })
                    }
                  />
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
              onMove={(task, status) => {
                const target = COLUMNS.find((c) => c.statuses.includes(status));
                const option = target
                  ? dropOptions(task.status, target).find((drop) => drop.to === status)
                  : null;
                if (option) apply(task, option);
                else move.mutate({ id: task.id, status });
              }}
              onRename={(task) =>
                void askText({
                  title: t('tasks.rename'),
                  label: t('tasks.title_label'),
                  initialValue: task.title,
                  confirmLabel: t('common.save'),
                }).then((value) => {
                  if (value) update.mutate({ id: task.id, patch: { title: value } });
                })
              }
              onDelete={(task) =>
                void ask({
                  title: t('tasks.confirm_delete', { title: task.title }),
                  body: t('tasks.confirm_delete_body'),
                  confirmLabel: t('common.delete'),
                }).then((sure) => {
                  if (sure) remove.mutate(task.id);
                })
              }
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
      {dialog}
      {textDialog}
    </AppShell>
  );
}

function BoardColumn({
  column,
  tasks,
  dragging,
  onMove,
  onRename,
  onDelete,
}: {
  column: ColumnDef;
  tasks: Task[];
  dragging: TaskStatus | null;
  onMove(task: Task, status: TaskStatus): void;
  onRename(task: Task): void;
  onDelete(task: Task): void;
}) {
  const { t } = useI18n();
  const [openedByHand, setOpenedByHand] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });
  // A column that shrinks does so only while it is empty, nothing is being dragged over
  // it and nobody has opened it: an empty column that keeps a full slot pushes the work
  // off the screen, and one that hides while a card is heading for it is worse.
  const collapsed =
    column.collapsible && tasks.length === 0 && !isOver && !openedByHand && dragging === null;
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
          <span className="task-strip-count">{tasks.length}</span>
          <span className="task-strip-title">{t(`tasks.columns.${column.id}`)}</span>
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
              <TaskCard
                key={task.id}
                task={task}
                onMove={(status) => onMove(task, status)}
                onRename={() => onRename(task)}
                onDelete={() => onDelete(task)}
              />
            ))}
            {tasks.length === 0 && <li className="task-column-empty">{t('tasks.nothing')}</li>}
          </ul>
        </SortableContext>
      )}
    </section>
  );
}

function TaskCard({
  task,
  onMove,
  onRename,
  onDelete,
}: {
  task: Task;
  onMove(status: TaskStatus): void;
  onRename(): void;
  onDelete(): void;
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
  } = useSortable({ id: task.id });
  const quick = quickActionFor(task.status);
  // The column groups several statuses, so the card is where the stage is readable.
  const showsStatus = task.status !== 'todo' && task.status !== 'triage';

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-card status-${task.status} ${isDragging ? 'sortable-dragging' : ''}`}
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
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
          {showsStatus && (
            <Badge tone={task.status === 'blocked' ? 'danger' : 'neutral'}>
              {t(`tasks.status.${task.status}`)}
            </Badge>
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
            <span className="truncate text-xs text-danger-soft-text" dir="auto">
              {task.blocked_reason}
            </span>
          )}
        </span>
      </div>
      {quick && (
        <Button
          variant="ghost"
          size="sm"
          className="task-card-quick"
          onClick={() => onMove(quickActionTarget(quick))}
          data-testid="task-quick"
          data-action={quick}
        >
          {t(`tasks.action.${quick}`)}
        </Button>
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
        <MenuItem onSelect={onRename}>{t('tasks.rename')}</MenuItem>
        <MenuSeparator />
        {/* Only the moves the hub would accept, so the menu never offers a dead end. */}
        {COLUMNS.flatMap((column) => dropOptions(task.status, column)).map((option) => (
          <MenuItem key={option.to} onSelect={() => onMove(option.to)}>
            {t(`tasks.action.${option.transition.action}`)}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={onDelete}>
          {t('common.delete')}
        </MenuItem>
      </Menu>
    </li>
  );
}
