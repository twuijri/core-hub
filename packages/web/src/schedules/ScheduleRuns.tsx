/**
 * What a schedule has done, and a workflow run as it stands.
 *
 * The history is the hub's own record of every firing — by its time or by "Run now" — and
 * each line opens what it started: a prompt schedule's conversation (in the schedule's own
 * profile, without moving the top selector), or a workflow's run.
 *
 * A workflow run that waits for a person shows the question and two answers where the
 * run is shown. The answer is the same `respondApproval` every other approval uses; a
 * "no" carries its reason, which becomes the failed step's error.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { chatHref } from '../chat/anchor.js';
import { useI18n } from '../i18n/context.js';
import { useProfileInLink } from '../shell/profiles.js';
import { Badge, Button, Dialog, Input, Notice, Skeleton, type BadgeTone } from '../ui/index.js';

interface ScheduleRunRow {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  trigger: 'schedule' | 'manual';
  session_id: string | null;
  workflow_run_id: string | null;
  output_preview: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface WorkflowStepRow {
  node_id: string;
  attempt: number;
  status: string;
  approval_id: string | null;
  error: string | null;
}

interface WorkflowRunRow {
  id: string;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  steps: WorkflowStepRow[];
  error: string | null;
}

interface ApprovalRow {
  id: string;
  status: string;
  title: string;
  description: string | null;
}

/** Every call goes to the item's own profile, whichever one the top selector shows. */
const inProfile = (profile: string) => ({ headers: { 'X-Hub-Profile': profile } });

const RUN_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  waiting: 'warning',
  waiting_approval: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  rejected: 'danger',
};

function useWhen() {
  const { language } = useI18n();
  return (at: string | null) =>
    at
      ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(Date.parse(at))
      : '';
}

/** A schedule's recent runs, newest first. */
export function ScheduleHistory({
  scheduleId,
  profile,
  onOpenRun,
}: {
  scheduleId: string;
  profile: string;
  onOpenRun: (workflowRunId: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useAuth();
  const when = useWhen();
  const inLink = useProfileInLink();
  const runs = useQuery({
    queryKey: ['schedules', 'runs', scheduleId],
    queryFn: async () => {
      const { data } = await client.request('get', '/schedules/{schedule_id}/runs', {
        params: { schedule_id: scheduleId },
        query: { limit: 20 },
        ...inProfile(profile),
      });
      return (data as unknown as { items: ScheduleRunRow[] }).items;
    },
  });

  if (runs.isPending) return <Skeleton height="2.5rem" radius="md" />;
  if (runs.isError) return <Notice tone="danger">{describeError(runs.error, t)}</Notice>;
  if (runs.data.length === 0) {
    return (
      <p className="text-xs text-muted" data-testid="schedule-history-empty">
        {t('schedules.history.empty')}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="schedule-history">
      {runs.data.map((run) => (
        <li
          key={run.id}
          className="flex flex-col gap-1 rounded-md border border-border p-2"
          data-testid="schedule-run-line"
          data-status={run.status}
        >
          <span className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={RUN_TONE[run.status] ?? 'neutral'} dot>
              {t(`schedules.history.status.${run.status}`)}
            </Badge>
            <span className="text-muted">
              {t(`schedules.history.trigger.${run.trigger}`)}
              {run.started_at || run.finished_at
                ? ` · ${when(run.started_at ?? run.finished_at)}`
                : ''}
            </span>
            {run.session_id && (
              <Link
                to={chatHref(run.session_id, null, undefined, inLink(profile))}
                className="ms-auto text-accent"
                data-testid="schedule-run-session"
              >
                {t('schedules.history.open_session')}
              </Link>
            )}
            {run.workflow_run_id && (
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto"
                onClick={() => onOpenRun(run.workflow_run_id!)}
                data-testid="schedule-run-workflow"
              >
                {t('schedules.history.open_run')}
              </Button>
            )}
          </span>
          {run.output_preview && (
            <p className="line-clamp-2 text-xs" dir="auto">
              {run.output_preview}
            </p>
          )}
          {run.error && (
            <p className="text-xs text-danger-soft-text" dir="auto">
              {run.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One workflow run: its steps, and — when it waits for a person — the question and the
 * two answers. Opened from a schedule's history or from the inbox (`?workflow_run=`).
 */
export function WorkflowRunDialog({
  runId,
  profile,
  onClose,
}: {
  runId: string;
  profile: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ['schedules', 'workflow-run', runId],
    queryFn: async () =>
      (
        await client.request('get', '/workflow-runs/{workflow_run_id}', {
          params: { workflow_run_id: runId },
          ...inProfile(profile),
        })
      ).data as unknown as WorkflowRunRow,
  });
  const waiting = run.data?.steps.find(
    (step) => step.status === 'waiting_approval' && step.approval_id,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('schedules.run.title')}
      closeLabel={t('ui.close')}
      size="md"
      testId="workflow-run-dialog"
    >
      {run.isPending && <Skeleton height="4rem" radius="md" />}
      {run.isError && <Notice tone="danger">{describeError(run.error, t)}</Notice>}
      {run.data && (
        <div className="flex flex-col gap-3" data-testid="workflow-run" data-status={run.data.status}>
          <span>
            <Badge tone={RUN_TONE[run.data.status] ?? 'neutral'} dot testId="workflow-run-status">
              {t(`schedules.run.status.${run.data.status}`)}
            </Badge>
          </span>
          {waiting && (
            <ApprovalGate
              approvalId={waiting.approval_id!}
              profile={profile}
              onAnswered={() => void queryClient.invalidateQueries({ queryKey: ['schedules'] })}
            />
          )}
          <ol className="flex flex-col gap-1" data-testid="workflow-run-steps">
            {run.data.steps.map((step) => (
              <li
                key={`${step.node_id}-${step.attempt}`}
                className="flex flex-wrap items-center gap-2 text-sm"
                data-testid="workflow-run-step"
                data-status={step.status}
              >
                <span dir="auto">{step.node_id}</span>
                <Badge tone={RUN_TONE[step.status] ?? 'neutral'}>
                  {t(`schedules.run.step_status.${step.status}`)}
                </Badge>
                {step.error && (
                  <span className="basis-full text-xs text-danger-soft-text" dir="auto">
                    {step.error}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {run.data.error && (
            <p className="text-xs text-danger-soft-text" dir="auto">
              {run.data.error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The question a waiting step asks, and the two answers. */
function ApprovalGate({
  approvalId,
  profile,
  onAnswered,
}: {
  approvalId: string;
  profile: string;
  onAnswered: () => void;
}) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [reason, setReason] = useState('');
  const approval = useQuery({
    queryKey: ['schedules', 'approval', approvalId],
    queryFn: async () =>
      (
        await client.request('get', '/approvals/{approval_id}', {
          params: { approval_id: approvalId },
          ...inProfile(profile),
        })
      ).data as unknown as ApprovalRow,
  });
  const answer = useMutation({
    mutationFn: async (approve: boolean) =>
      (
        await client.request('post', '/approvals/{approval_id}/respond', {
          params: { approval_id: approvalId },
          body: {
            decision: approve ? 'approve_once' : 'deny',
            answer: reason.trim() || null,
          } as never,
          ...inProfile(profile),
        })
      ).data,
    onSuccess: onAnswered,
  });

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning-soft-border bg-warning-soft p-3"
      data-testid="workflow-approval"
    >
      <p className="text-sm font-medium">{t('schedules.run.waiting')}</p>
      {approval.data && (
        <p className="text-sm" dir="auto" data-testid="workflow-approval-question">
          {approval.data.description ?? approval.data.title}
        </p>
      )}
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('schedules.run.reason')}
        aria-label={t('schedules.run.reason')}
        dir="auto"
        data-testid="workflow-approval-reason"
      />
      {answer.isError && <Notice tone="danger">{describeError(answer.error, t)}</Notice>}
      <span className="flex gap-2">
        <Button
          size="sm"
          loading={answer.isPending && answer.variables === true}
          disabled={answer.isPending || answer.isSuccess}
          onClick={() => answer.mutate(true)}
          data-testid="workflow-approve"
        >
          {t('schedules.run.approve')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={answer.isPending && answer.variables === false}
          disabled={answer.isPending || answer.isSuccess}
          onClick={() => answer.mutate(false)}
          data-testid="workflow-deny"
        >
          {t('schedules.run.deny')}
        </Button>
      </span>
    </div>
  );
}
