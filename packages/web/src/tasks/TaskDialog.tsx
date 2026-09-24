/**
 * A task opened on its own: its words and priority to edit, and what was said on it.
 *
 * For a card on Hermes's board this is Hermes's card: the hub reads it from Hermes when it
 * opens, an edit is made on Hermes first and the dialog shows what Hermes kept, and a
 * comment is said on Hermes's card in the person's name. When Hermes says no, its sentence
 * is shown as Hermes wrote it (`describeTaskError`).
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import {
  Button,
  Dialog,
  Field,
  Input,
  Label,
  Notice,
  Select,
  Skeleton,
  Textarea,
} from '../ui/index.js';
import { useAddComment, useTaskDetail, useUpdateTask, type Task } from './queries.js';
import { describeTaskError } from './errors.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export function TaskDialog({ task, onClose }: { task: Task | null; onClose(): void }) {
  const { t } = useI18n();
  const ref = task ? { id: task.id, profile: task.profile } : null;
  const detail = useTaskDetail(ref);
  const update = useUpdateTask();
  const comment = useAddComment();
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
        <div className="mj-field-row">
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
    </Dialog>
  );
}
