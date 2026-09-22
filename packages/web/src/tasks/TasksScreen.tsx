/**
 * The Tasks section: one project's nine columns, and what a person does to them.
 *
 * **Drag has a keyboard equivalent, as every drag in this client does** (DESIGN §UI
 * policy): dnd-kit's keyboard sensor picks a card up with Space, moves it with the arrows
 * and drops it with Space — and the card's own menu moves it between columns without any
 * dragging at all, which is what a phone uses.
 *
 * The board is one call and one cache key, so a move, a rename and a new task all reach
 * the screen the same way (`queries.ts`).
 *
 * A column that cannot be moved *to* by a person is not offered: `running` belongs to the
 * worker (`modules/tasks/service.ts`), and `blocked` needs a reason, which the menu asks
 * for rather than guessing.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
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
  TASK_STATUSES,
  useBoard,
  useCreateProject,
  useCreateTask,
  useDeleteTask,
  useMoveTask,
  useProjects,
  useUpdateTask,
  type Column,
  type Task,
  type TaskStatus,
} from './queries.js';

/** Columns a person may drop into. `running` is the worker's; nothing drops into it. */
const DROPPABLE: readonly TaskStatus[] = TASK_STATUSES.filter((status) => status !== 'running');

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = board.data?.columns ?? [];
  const byId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const column of columns) for (const task of column.tasks) map.set(task.id, task);
    return map;
  }, [columns]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const task = byId.get(String(active.id));
    if (!task) return;
    const overTask = byId.get(String(over.id));
    // Dropping on a card means "after that card"; dropping on the column means its end.
    const status = overTask?.status ?? (String(over.id).replace('column:', '') as TaskStatus);
    if (!DROPPABLE.includes(status)) return;
    if (status === 'blocked') {
      // A blocked task must say why, and the hub refuses without it — so ask here rather
      // than send a request that is going to fail.
      void askText({
        title: t('tasks.blocked_why'),
        label: t('tasks.reason'),
        confirmLabel: t('common.save'),
      }).then((reason) => {
        if (reason === null) return;
        move.mutate({ id: task.id, status, reason, after_task_id: overTask?.id ?? null });
      });
      return;
    }
    if (overTask?.id === task.id) return;
    move.mutate({ id: task.id, status, after_task_id: overTask?.id ?? null });
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

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div className="task-board" data-testid="task-board">
          {columns.map((column) => (
            <BoardColumn
              key={column.status}
              column={column}
              onMove={(task, status) => {
                if (status === 'blocked') {
                  void askText({
                    title: t('tasks.blocked_why'),
                    label: t('tasks.reason'),
                    confirmLabel: t('common.save'),
                  }).then((reason) => {
                    if (reason !== null) move.mutate({ id: task.id, status, reason });
                  });
                  return;
                }
                move.mutate({ id: task.id, status });
              }}
              onRename={(task) => {
                void askText({
                  title: t('tasks.rename'),
                  label: t('tasks.title_label'),
                  initialValue: task.title,
                  confirmLabel: t('common.save'),
                }).then((next) => {
                  if (next) update.mutate({ id: task.id, patch: { title: next } });
                });
              }}
              onDelete={(task) => {
                void ask({
                  title: t('tasks.confirm_delete', { title: task.title }),
                  body: t('tasks.confirm_delete_body'),
                  confirmLabel: t('common.delete'),
                }).then((sure) => {
                  if (sure) remove.mutate(task.id);
                });
              }}
            />
          ))}
        </div>
      </DndContext>
      {dialog}
      {textDialog}
    </AppShell>
  );
}

function BoardColumn({
  column,
  onMove,
  onRename,
  onDelete,
}: {
  column: Column;
  onMove(task: Task, status: TaskStatus): void;
  onRename(task: Task): void;
  onDelete(task: Task): void;
}) {
  const { t } = useI18n();
  return (
    <section className="task-column" aria-label={t(`tasks.status.${column.status}`)}>
      <header className="task-column-head">
        <span className="font-medium">{t(`tasks.status.${column.status}`)}</span>
        <span className="text-xs text-muted">{column.count}</span>
      </header>
      <SortableContext
        items={column.tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="task-column-body" data-column={column.status}>
          {column.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onMove={onMove}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
          {column.tasks.length === 0 && (
            <li className="task-column-empty" aria-hidden>
              —
            </li>
          )}
        </ul>
      </SortableContext>
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
  onMove(task: Task, status: TaskStatus): void;
  onRename(task: Task): void;
  onDelete(task: Task): void;
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
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-card ${isDragging ? 'sortable-dragging' : ''}`}
      data-testid="task-card"
      data-task-id={task.id}
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
          {task.assignee && (
            <span className="truncate text-xs text-muted" dir="auto">
              {task.assignee.name}
            </span>
          )}
          {task.blocked_reason && (
            <span className="truncate text-xs text-danger-soft-text" dir="auto">
              {task.blocked_reason}
            </span>
          )}
        </span>
      </div>
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
        <MenuItem onSelect={() => onRename(task)}>{t('tasks.rename')}</MenuItem>
        <MenuSeparator />
        {/* Moving from the menu is what a phone uses, and what a keyboard uses when the
            drag is more trouble than the move is worth. */}
        {DROPPABLE.filter((status) => status !== task.status).map((status) => (
          <MenuItem key={status} onSelect={() => onMove(task, status)}>
            {t('tasks.move_to', { column: t(`tasks.status.${status}`) })}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={() => onDelete(task)}>
          {t('common.delete')}
        </MenuItem>
      </Menu>
    </li>
  );
}
