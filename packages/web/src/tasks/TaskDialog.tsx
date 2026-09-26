/**
 * A task opened on its own: its words and priority to edit, and what was said on it.
 *
 * For a card on Hermes's board this is Hermes's card: the hub reads it from Hermes when it
 * opens, an edit is made on Hermes first and the dialog shows what Hermes kept, and a
 * comment is said on Hermes's card in the person's name. When Hermes says no, its sentence
 * is shown as Hermes wrote it (`describeTaskError`).
 *
 * For the hub's own task it also holds "Start automatically" (`auto_start`, a switch that
 * takes effect when flipped) and, when the task has one, its git worktree: where it is, its
 * branch, how it stands — git's own message when git refused — and Remove (the branch stays).
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Label,
  Notice,
  Select,
  Skeleton,
  Switch,
  Textarea,
  useConfirm,
  type BadgeTone,
} from '../ui/index.js';
import {
  useAddComment,
  useRemoveWorktree,
  useTaskDetail,
  useUpdateTask,
  type Task,
  type Worktree,
} from './queries.js';
import { describeTaskError } from './errors.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export function TaskDialog({ task, onClose }: { task: Task | null; onClose(): void }) {
  const { t } = useI18n();
  const ref = task ? { id: task.id, profile: task.profile } : null;
  const detail = useTaskDetail(ref);
  const update = useUpdateTask();
  const comment = useAddComment();
  const toggle = useUpdateTask();
  const removeWorktree = useRemoveWorktree();
  const { ask, dialog } = useConfirm();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<string>('normal');
  const [said, setSaid] = useState('');
  const fromHermes = task?.external?.source === 'hermes';

  // The fields start from the card as the board had it, and take the card as the hub read
  // it (from Hermes, for Hermes's card) once that answer arrives.
  const shown = detail.data ?? task;
  useEffect(() => {
    if (!shown) return;
    setTitle(shown.title);
    setDescription(shown.description ?? '');
    setPriority(shown.priority);
  }, [shown?.id, shown?.title, shown?.description, shown?.priority]);
  useEffect(() => {
    if (!task) return;
    setSaid('');
    update.reset();
    comment.reset();
    toggle.reset();
    removeWorktree.reset();
  }, [task?.id]);

  const patch: Record<string, unknown> = {};
  if (shown) {
    if (title.trim() !== shown.title) patch.title = title.trim();
    if (description !== (shown.description ?? '')) patch.description = description || null;
    if (priority !== shown.priority) patch.priority = priority;
  }
  const changed = Object.keys(patch).length > 0;

  const save = () => {
    if (!task || !changed || title.trim() === '') return;
    update.mutate(
      { id: task.id, profile: task.profile, patch },
      { onSuccess: () => void detail.refetch() },
    );
  };
  const post = () => {
    if (!task || said.trim() === '') return;
    comment.mutate(
      { id: task.id, profile: task.profile, content: said.trim() },
      { onSuccess: () => setSaid('') },
    );
  };

  const comments = detail.data?.comments ?? [];
  const worktree = shown?.worktree ?? null;
  const autoStart = shown?.auto_start === true;
  // What it still waits for (DECISIONS §92) — listed while the task has not run to the end.
  const waitingOn =
    shown && !['running', 'review', 'done', 'archived'].includes(shown.status)
      ? (shown.waiting_on ?? [])
      : [];
  const flipAutoStart = (next: boolean) => {
    if (!task) return;
    toggle.mutate(
      { id: task.id, profile: task.profile, patch: { auto_start: next } },
      { onSuccess: () => void detail.refetch() },
    );
  };
  const askRemove = () => {
    if (!task || !worktree) return;
    void ask({
      title: t('tasks.worktree.confirm_remove'),
      body: t('tasks.worktree.confirm_remove_body', { branch: worktree.branch }),
      confirmLabel: t('tasks.worktree.remove'),
    }).then((sure) => {
      if (sure) removeWorktree.mutate({ id: task.id, profile: task.profile });
    });
  };

  return (
    <Dialog
      open={task !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('tasks.details.title')}
      description={fromHermes ? t('tasks.hermes.writes_through') : undefined}
      closeLabel={t('common.cancel')}
      size="lg"
      testId="task-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!changed || title.trim() === ''}
            loading={update.isPending}
            onClick={save}
            data-testid="task-dialog-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('tasks.title_label')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              maxLength={300}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              data-testid="task-dialog-title"
            />
          )}
        </Field>
        <Field label={t('tasks.details.description')}>
          {(props) => (
            <Textarea
              {...props}
              dir="auto"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="task-dialog-description"
            />
          )}
        </Field>
        <div className="ch-field-row">
          <Label>{t('tasks.details.priority')}</Label>
          <span>
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value ?? 'normal')}
              options={PRIORITIES.map((value) => ({ value, label: t(`tasks.priority.${value}`) }))}
              label={t('tasks.details.priority')}
              testId="task-dialog-priority"
            />
          </span>
        </div>
        {update.isError && <Notice tone="danger">{describeTaskError(update.error, t)}</Notice>}

        {!fromHermes && (
          <Switch
            checked={autoStart}
            onChange={flipAutoStart}
            disabled={toggle.isPending || !shown}
            label={t('tasks.auto_start.label')}
            hint={t('tasks.auto_start.hint')}
            testId="task-auto-start"
          />
        )}
        {toggle.isError && <Notice tone="danger">{describeTaskError(toggle.error, t)}</Notice>}

        {waitingOn.length > 0 && (
          <section
            aria-label={t('tasks.details.waiting_on')}
            className="flex flex-col gap-1"
            data-testid="task-dialog-waiting-on"
          >
            <h3 className="text-sm font-medium">{t('tasks.details.waiting_on')}</h3>
            <ul className="flex flex-col gap-1">
              {waitingOn.map((one) => (
                <li key={one.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate" dir="auto">
                    {one.title}
                  </span>
                  <span className="text-xs text-muted">{t(`tasks.status.${one.status}`)}</span>
                </li>
              ))}
            </ul>
            {autoStart && <p className="text-xs text-muted">{t('tasks.details.waiting_hint')}</p>}
          </section>
        )}

        {worktree && (
          <WorktreeSection
            worktree={worktree}
            running={shown?.status === 'running'}
            removing={removeWorktree.isPending}
            onRemove={askRemove}
          />
        )}
        {removeWorktree.isError && (
          <Notice tone="danger">{describeTaskError(removeWorktree.error, t)}</Notice>
        )}

        <section aria-label={t('tasks.details.comments')} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('tasks.details.comments')}</h3>
          {detail.isPending ? (
            <Skeleton height="3rem" radius="md" />
          ) : comments.length === 0 ? (
            <p className="text-xs text-muted">{t('tasks.details.no_comments')}</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="task-comments">
              {comments.map((entry) => (
                <li key={entry.id} className="task-comment" data-testid="task-comment">
                  <span className="text-xs text-muted" dir="auto">
                    {entry.author.name}
                  </span>
                  <p className="text-sm whitespace-pre-wrap" dir="auto">
                    {entry.content}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Field label={t('tasks.details.add_comment')}>
            {(props) => (
              <Textarea
                {...props}
                dir="auto"
                rows={2}
                value={said}
                onChange={(event) => setSaid(event.target.value)}
                data-testid="task-comment-input"
              />
            )}
          </Field>
          <span>
            <Button
              size="sm"
              variant="secondary"
              disabled={said.trim() === ''}
              loading={comment.isPending}
              onClick={post}
              data-testid="task-comment-send"
            >
              {t('tasks.details.send_comment')}
            </Button>
          </span>
          {comment.isError && <Notice tone="danger">{describeTaskError(comment.error, t)}</Notice>}
        </section>
      </div>
      {dialog}
    </Dialog>
  );
}

const WORKTREE_TONE: Record<Worktree['status'], BadgeTone> = {
  creating: 'neutral',
  ready: 'success',
  dirty: 'warning',
  merged: 'neutral',
  removed: 'neutral',
  error: 'danger',
};

/** Where the task's work is on disk, on which branch, and how it stands. */
function WorktreeSection({
  worktree,
  running,
  removing,
  onRemove,
}: {
  worktree: Worktree;
  running: boolean;
  removing: boolean;
  onRemove(): void;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t('tasks.worktree.title')}
      className="task-worktree flex flex-col gap-1"
      data-testid="task-worktree"
      data-status={worktree.status}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('tasks.worktree.title')}</h3>
        <Badge tone={WORKTREE_TONE[worktree.status]} testId="task-worktree-status">
          {t(`tasks.worktree.status.${worktree.status}`)}
        </Badge>
      </div>
      <dl className="task-worktree-facts">
        <dt className="text-xs text-muted">{t('tasks.worktree.branch')}</dt>
        <dd className="text-sm" dir="ltr" data-testid="task-worktree-branch">
          {worktree.branch}
        </dd>
        <dt className="text-xs text-muted">{t('tasks.worktree.path')}</dt>
        <dd className="text-sm break-all" dir="ltr" data-testid="task-worktree-path">
          {worktree.path}
        </dd>
        {(worktree.status === 'ready' || worktree.status === 'dirty') && (
          <>
            <dt className="text-xs text-muted">{t('tasks.worktree.changes')}</dt>
            <dd className="text-sm">
              {t('tasks.worktree.counts', {
                files: worktree.changed_files,
                ahead: worktree.ahead,
                base: worktree.base_branch,
              })}
            </dd>
          </>
        )}
      </dl>
      {worktree.error && (
        <pre className="task-worktree-error" dir="ltr" data-testid="task-worktree-error">
          {worktree.error}
        </pre>
      )}
      <span>
        <Button
          size="sm"
          variant="secondary"
          disabled={running}
          loading={removing}
          onClick={onRemove}
          data-testid="task-worktree-remove"
          {...(running ? { title: t('tasks.worktree.running') } : {})}
        >
          {t('tasks.worktree.remove')}
        </Button>
      </span>
    </section>
  );
}
