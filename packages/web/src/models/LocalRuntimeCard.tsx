/**
 * Local models (ADR 0032): Ollama on the computer the desktop app's hub runs on.
 *
 * The owner's words, 2026-10-30: if Ollama is already on the computer the hub manages it and
 * says it did not install it; if not, the hub downloads it and manages it fully — it stops
 * when the hub stops, models are added and deleted, and Ollama is updated, all from here.
 *
 * So the card has three shapes, one per `mode`:
 * - `none` — what a local model is, the graphics card found, the download's size, Install;
 * - `managed` — the hub's own Ollama: start, stop, update, remove;
 * - `external` — someone else's Ollama: its models only; a newer release is said, and the
 *   person updates it from Ollama itself.
 * Once Ollama runs, the models panel underneath lists what is installed, what is loaded now,
 * what this computer could take, and the downloads in flight.
 *
 * Shown to an owner or admin on the desktop app's hub only (`available`). Anywhere else the
 * card is not there at all — not a disabled card, not an error.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useCancelJob, useJob } from '../agents/skills.js';
import { useJobs } from '../agents/useJobs.js';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import type { Job, LocalModels, LocalRuntime } from '../types.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  Field,
  Input,
  Notice,
  Separator,
  Spinner,
  useConfirm,
  type BadgeTone,
} from '../ui/index.js';
import { IconDownload, IconPlay, IconRestart, IconStop, IconTrash } from '../ui/icons.js';
import { formatBytes } from '../workspace-files/paths.js';
import {
  useCheckLocalRuntime,
  useDeleteLocalModel,
  useLocalModels,
  useLocalModelsChanged,
  useLocalRuntime,
  useLocalRuntimeAction,
  usePullLocalModel,
  useRemoveLocalRuntime,
} from './queries.js';

const STATE_TONE: Record<LocalRuntime['state'], BadgeTone> = {
  running: 'success',
  starting: 'info',
  stopped: 'neutral',
  error: 'danger',
};

const STATE_KEY: Record<LocalRuntime['state'], string> = {
  running: 'models.local.state.running',
  starting: 'models.local.state.starting',
  stopped: 'models.local.state.stopped',
  error: 'models.local.state.error',
};

/** A card's maker by the name people know it by; the card's own name when Ollama gave one. */
const VENDOR: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  apple: 'Apple',
};

const ended = (job: Job | undefined) =>
  !!job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');

/**
 * One job, from whichever source said more recently: `/rt/jobs` as it happens, or the
 * two-second poll underneath it for a socket that dropped.
 */
function useTrackedJob(jobId: string | null, live: Record<string, Job>): Job | undefined {
  const polled = useJob(jobId).data;
  const pushed = jobId ? live[jobId] : undefined;
  if (!pushed || !polled) return pushed ?? polled;
  if (ended(pushed) !== ended(polled)) return ended(pushed) ? pushed : polled;
  return pushed.updated_at >= polled.updated_at ? pushed : polled;
}

export function LocalRuntimeCard() {
  const { user } = useAuth();
  const admin = user?.role === 'owner' || user?.role === 'admin';
  const runtime = useLocalRuntime(admin);
  // A member, a hub that is not the desktop app's, or a refusal: nothing at all.
  if (!admin || !runtime.data?.available) return null;
  return <LocalRuntimeBody runtime={runtime.data} />;
}

function LocalRuntimeBody({ runtime }: { runtime: LocalRuntime }) {
  const { t, language } = useI18n();
  const jobs = useJobs();
  const action = useLocalRuntimeAction();
  const check = useCheckLocalRuntime();
  const changed = useLocalModelsChanged();
  // The install or update this card started, else the one the hub says is running: a screen
  // opened again finds the job it left.
  const [jobId, setJobId] = useState<string | null>(null);
  const tracked = runtime.job_id ?? jobId;
  const job = useTrackedJob(tracked, jobs);
  const busy = !!job && !ended(job);
  const [removing, setRemoving] = useState(false);
  const [checked, setChecked] = useState(false);

  // When the install or update ends, Ollama is read again — and the providers, which now
  // hold (or still hold) the `ollama` row pointed at it.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!job || !ended(job) || settled.current === job.id) return;
    settled.current = job.id;
    changed();
  }, [job, changed]);

  const act = (kind: 'install' | 'update' | 'start' | 'stop') => {
    setChecked(false);
    action.mutate(kind, {
      onSuccess: (answer) => {
        if (!('available' in answer)) setJobId(answer.job_id);
      },
    });
  };

  const size = runtime.download_bytes ? formatBytes(runtime.download_bytes, language) : null;
  const running = runtime.state === 'running' && runtime.mode !== 'none';
  const managed = runtime.mode === 'managed';

  return (
    <Card
      tone="raised"
      className="mb-3"
      testId="local-runtime-card"
      data-mode={runtime.mode}
      data-state={runtime.state}
    >
      <CardHeader
        title={t('models.local.title')}
        subtitle={t(
          runtime.mode === 'managed'
            ? 'models.local.managed_hint'
            : runtime.mode === 'external'
              ? 'models.local.external_hint'
              : 'models.local.hint',
        )}
        actions={
          runtime.mode === 'none' ? undefined : (
            <Badge tone={managed ? 'accent' : 'info'} testId="local-mode-badge">
              {t(managed ? 'models.local.mode.managed' : 'models.local.mode.external')}
            </Badge>
          )
        }
      />

      {runtime.mode === 'none' ? (
        <div className="flex flex-col gap-2 text-sm">
          <p data-testid="local-gpu">
            {runtime.gpu && runtime.gpu.vendor !== 'none'
              ? t('models.local.gpu', {
                  name: `⁨${runtime.gpu.name ?? VENDOR[runtime.gpu.vendor] ?? runtime.gpu.vendor}⁩`,
                })
              : t('models.local.gpu_none')}
          </p>
          {runtime.platform === null ? (
            <Notice tone="warning" testId="local-unsupported">
              {t('models.local.unsupported')}
            </Notice>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<IconDownload size={16} />}
                loading={action.isPending && action.variables === 'install'}
                disabled={busy}
                onClick={() => act('install')}
                data-testid="local-install"
              >
                {t('models.local.install')}
              </Button>
              {size && (
                <span className="text-xs text-muted" data-testid="local-download-size">
                  {t('models.local.download_size', { size })}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {runtime.version && (
              <span className="font-medium" data-testid="local-version">
                {t('models.local.version', { version: `⁦${runtime.version}⁩` })}
              </span>
            )}
            <Badge
              tone={STATE_TONE[runtime.state]}
              dot={runtime.state === 'starting'}
              testId="local-state"
            >
              {t(STATE_KEY[runtime.state])}
            </Badge>
          </div>
          {runtime.state === 'error' && runtime.error && (
            <Notice tone="danger" className="wrap-anywhere" testId="local-error">
              <span dir="auto">{runtime.error}</span>
            </Notice>
          )}
          {runtime.update_available && runtime.latest_version && (
            <Notice tone="info" testId="local-update-notice">
              {t(managed ? 'models.local.update_available' : 'models.local.external_update', {
                version: `⁦${runtime.latest_version}⁩`,
              })}
              {managed && size && (
                <span className="ms-1 text-xs">{t('models.local.download_size', { size })}</span>
              )}
            </Notice>
          )}
          {checked && !check.isPending && !runtime.update_available && runtime.latest_version && (
            <p className="text-xs text-muted" role="status" data-testid="local-up-to-date">
              {t('models.local.up_to_date')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {managed && (runtime.state === 'stopped' || runtime.state === 'error') && (
              <Button
                variant={runtime.state === 'error' ? 'primary' : 'secondary'}
                icon={
                  runtime.state === 'error' ? <IconRestart size={16} /> : <IconPlay size={16} />
                }
                loading={action.isPending && action.variables === 'start'}
                disabled={busy}
                onClick={() => act('start')}
                data-testid="local-start"
              >
                {t(runtime.state === 'error' ? 'models.local.retry' : 'models.local.start')}
              </Button>
            )}
            {managed && (runtime.state === 'running' || runtime.state === 'starting') && (
              <Button
                icon={<IconStop size={16} />}
                loading={action.isPending && action.variables === 'stop'}
                disabled={busy}
                onClick={() => act('stop')}
                data-testid="local-stop"
              >
                {t('models.local.stop')}
              </Button>
            )}
            {managed && runtime.update_available && runtime.latest_version && (
              <Button
                variant="primary"
                icon={<IconDownload size={16} />}
                loading={action.isPending && action.variables === 'update'}
                disabled={busy}
                onClick={() => act('update')}
                data-testid="local-update"
              >
                {t('models.local.update_to', { version: `⁦${runtime.latest_version}⁩` })}
              </Button>
            )}
            {/* Someone else's Ollama that has stopped answering: there is nothing of it to
                start from here, only asking again. */}
            {!managed && runtime.state === 'error' && (
              <Button
                icon={<IconRestart size={16} />}
                loading={check.isPending}
                onClick={() => check.mutate()}
                data-testid="local-retry"
              >
                {t('models.local.retry')}
              </Button>
            )}
            <Button
              variant="ghost"
              loading={check.isPending}
              disabled={busy}
              onClick={() => check.mutate(undefined, { onSuccess: () => setChecked(true) })}
              data-testid="local-check-updates"
            >
              {t('models.local.check_updates')}
            </Button>
            {managed && (
              <Button
                variant="danger-quiet"
                icon={<IconTrash size={16} />}
                disabled={busy}
                onClick={() => setRemoving(true)}
                data-testid="local-remove"
              >
                {t('models.local.remove')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* A finished install leaves nothing behind; a failed one says why. */}
      {job && (busy || job.status === 'failed') && (
        <JobProgress job={job} testId="local-job-progress" />
      )}
      {action.isError && <Notice tone="danger">{describeError(action.error, t)}</Notice>}
      {check.isError && <Notice tone="danger">{describeError(check.error, t)}</Notice>}

      {running && (
        <>
          <Separator />
          <LocalModelsPanel jobs={jobs} />
        </>
      )}

      {removing && <RemoveDialog onClose={() => setRemoving(false)} />}
    </Card>
  );
}

/** A job's bar and its status, the way the Agents page shows an install. */
function JobProgress({ job, testId }: { job: Job; testId: string }) {
  const { t } = useI18n();
  const active = !ended(job);
  const percent = job.progress.percent ?? (active ? 30 : 100);
  return (
    <div aria-live="polite" data-testid={testId} data-status={job.status}>
      <div className="agent-progress">
        <div className="agent-progress-bar" style={{ inlineSize: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {t(`jobs.status.${job.status}`)}
        {active && job.progress.percent !== null ? ` · ${job.progress.percent}%` : ''}
        {job.error ? ` · ${job.error.error}` : ''}
      </p>
    </div>
  );
}

/** "Remove Ollama": the models are kept unless the person ticks the box. */
function RemoveDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const remove = useRemoveLocalRuntime();
  const [deleteModels, setDeleteModels] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="sm"
      title={t('models.local.remove_title')}
      description={t('models.local.remove_body')}
      closeLabel={t('ui.close')}
      testId="local-remove-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(!deleteModels, { onSuccess: onClose })}
            data-testid="local-remove-confirm"
          >
            {t('models.local.remove_confirm')}
          </Button>
        </>
      }
    >
      <Checkbox
        checked={deleteModels}
        onChange={setDeleteModels}
        label={t('models.local.remove_models')}
        hint={t('models.local.remove_models_hint')}
        testId="local-remove-models"
      />
      {remove.isError && (
        <Notice tone="danger" className="mt-2">
          {describeError(remove.error, t)}
        </Notice>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ the models

function LocalModelsPanel({ jobs }: { jobs: Record<string, Job> }) {
  const { t, language } = useI18n();
  const models = useLocalModels(true);
  const pull = usePullLocalModel();
  const remove = useDeleteLocalModel();
  const changed = useLocalModelsChanged();
  const { ask, dialog } = useConfirm();
  const [typed, setTyped] = useState('');
  // The downloads this screen started, by model; the hub's `pulls` adds the ones a screen
  // opened earlier started, so leaving and coming back keeps following them.
  const [started, setStarted] = useState<Record<string, string>>({});
  // Jobs already seen to end: a stale `pulls` row from before the refetch is not shown again.
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<{ name: string; error: string }[]>([]);

  const pulls: Record<string, string> = {};
  for (const each of models.data?.pulls ?? []) pulls[each.name] = each.job_id;
  Object.assign(pulls, started);
  const inFlight = Object.entries(pulls).filter(([, jobId]) => !finished.has(jobId));
  const pulling = new Set(inFlight.map(([name]) => name));

  const download = (name: string) => {
    const wanted = name.trim();
    if (!wanted || pulling.has(wanted)) return;
    setFailures((list) => list.filter((each) => each.name !== wanted));
    pull.mutate(wanted, {
      onSuccess: ({ job_id }) => {
        setStarted((current) => ({ ...current, [wanted]: job_id }));
        setTyped((current) => (current.trim() === wanted ? '' : current));
      },
    });
  };

  const onPullEnded = (name: string, job: Job) => {
    setFinished((current) => new Set(current).add(job.id));
    setStarted((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    if (job.status === 'failed') {
      setFailures((list) => [
        ...list.filter((each) => each.name !== name),
        { name, error: job.error?.error ?? t('jobs.status.failed') },
      ]);
    }
    changed();
  };

  const deleteModel = async (name: string) => {
    const isolated = `⁨${name}⁩`;
    const yes = await ask({
      title: t('models.local.delete_title', { name: isolated }),
      body: t('models.local.delete_body'),
    });
    if (yes) remove.mutate(name);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    download(typed);
  };

  if (models.isPending) return <Spinner label={t('common.loading')} />;
  if (models.isError) return <Notice tone="danger">{describeError(models.error, t)}</Notice>;
  const data: LocalModels = models.data;
  const loaded = new Set(data.loaded.map((model) => model.name));

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="local-models">
      <p className="text-xs text-muted" data-testid="local-resources">
        {t('models.local.memory', { size: formatBytes(data.memory_bytes, language) })}
        {data.disk_free_bytes !== null &&
          ` · ${t('models.local.disk_free', { size: formatBytes(data.disk_free_bytes, language) })}`}
      </p>

      <section className="flex flex-col gap-1" aria-label={t('models.local.installed_title')}>
        <h4 className="text-xs font-medium text-muted">{t('models.local.installed_title')}</h4>
        {data.installed.length === 0 ? (
          <p className="text-muted">{t('models.local.installed_none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.installed.map((model) => (
              <li
                key={model.name}
                className="flex flex-wrap items-center gap-2"
                data-testid="local-installed-model"
                data-model={model.name}
              >
                <span className="font-medium" dir="ltr">
                  {model.name}
                </span>
                <span className="text-xs text-muted">{formatBytes(model.size, language)}</span>
                {(model.parameter_size || model.quantization) && (
                  <span className="text-xs text-muted" dir="ltr">
                    {[model.parameter_size, model.quantization].filter(Boolean).join(' · ')}
                  </span>
                )}
                {loaded.has(model.name) && (
                  <Badge tone="success" dot testId="local-loaded">
                    {t('models.local.loaded')}
                  </Badge>
                )}
                <Button
                  className="ms-auto"
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<IconTrash size={16} />}
                  aria-label={t('models.local.delete_model', { name: `⁨${model.name}⁩` })}
                  disabled={remove.isPending && remove.variables === model.name}
                  onClick={() => void deleteModel(model.name)}
                  data-testid="local-delete-model"
                />
              </li>
            ))}
          </ul>
        )}
        {remove.isError && <Notice tone="danger">{describeError(remove.error, t)}</Notice>}
      </section>

      {inFlight.length > 0 && (
        <section className="flex flex-col gap-2" aria-label={t('models.local.downloading')}>
          <h4 className="text-xs font-medium text-muted">{t('models.local.downloading')}</h4>
          {inFlight.map(([name, jobId]) => (
            <PullRow key={jobId} name={name} jobId={jobId} jobs={jobs} onEnded={onPullEnded} />
          ))}
        </section>
      )}
      {failures.map((failure) => (
        <Notice
          key={failure.name}
          tone="danger"
          className="wrap-anywhere"
          testId="local-pull-failed"
        >
          {t('models.local.pull_failed', {
            name: `⁨${failure.name}⁩`,
            error: failure.error,
          })}
        </Notice>
      ))}

      {data.suggested.length > 0 && (
        <section className="flex flex-col gap-1" aria-label={t('models.local.suggested_title')}>
          <h4 className="text-xs font-medium text-muted">{t('models.local.suggested_title')}</h4>
          <ul className="flex flex-col gap-1">
            {data.suggested.map((model) => (
              <li
                key={model.name}
                className="flex flex-wrap items-center gap-2"
                data-testid="local-suggestion"
                data-model={model.name}
              >
                <span className="font-medium" dir="ltr">
                  {model.name}
                </span>
                <span className="text-xs text-muted">
                  {t('models.local.about_size', { size: formatBytes(model.size_bytes, language) })}
                </span>
                <Badge tone={model.fits ? 'success' : 'warning'}>
                  {model.fits
                    ? t('models.local.fits')
                    : t('models.local.needs_memory', {
                        size: formatBytes(model.memory_bytes, language),
                      })}
                </Badge>
                {model.tools && <Badge>{t('models.local.tools')}</Badge>}
                <span className="ms-auto">
                  {model.installed ? (
                    <Badge tone="neutral">{t('models.local.installed')}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      icon={<IconDownload size={16} />}
                      disabled={pulling.has(model.name)}
                      loading={pull.isPending && pull.variables === model.name}
                      onClick={() => download(model.name)}
                      data-testid="local-download"
                    >
                      {t('models.local.download')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <Field
          className="min-w-0 flex-1"
          label={t('models.local.download_any')}
          hint={t('models.local.download_any_hint')}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={200}
              placeholder="qwen3:8b"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              data-testid="local-pull-name"
            />
          )}
        </Field>
        <Button
          type="submit"
          icon={<IconDownload size={16} />}
          disabled={!typed.trim() || pulling.has(typed.trim())}
          loading={pull.isPending && pull.variables === typed.trim()}
          data-testid="local-pull-submit"
        >
          {t('models.local.download')}
        </Button>
      </form>
      {pull.isError && <Notice tone="danger">{describeError(pull.error, t)}</Notice>}
      {dialog}
    </div>
  );
}

/** One download: its bar, how much of how much, and Cancel. */
function PullRow({
  name,
  jobId,
  jobs,
  onEnded,
}: {
  name: string;
  jobId: string;
  jobs: Record<string, Job>;
  onEnded(name: string, job: Job): void;
}) {
  const { t, language } = useI18n();
  const job = useTrackedJob(jobId, jobs);
  const cancel = useCancelJob();
  // Said once: the panel drops this row on hearing it.
  const reported = useRef(false);
  useEffect(() => {
    if (!job || !ended(job) || reported.current) return;
    reported.current = true;
    onEnded(name, job);
  }, [job, name, onEnded]);

  const result = (job?.result ?? {}) as { completed?: number | null; total?: number | null };
  const total = typeof result.total === 'number' && result.total > 0 ? result.total : null;
  const done = typeof result.completed === 'number' ? result.completed : null;
  const percent = job?.progress.percent ?? null;
  return (
    <div data-testid="local-pull" data-model={name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium" dir="ltr">
          {name}
        </span>
        <span className="text-xs text-muted" data-testid="local-pull-progress">
          {total !== null && done !== null
            ? t('models.local.pull_progress', {
                percent: percent ?? Math.floor((done / total) * 100),
                done: formatBytes(done, language),
                total: formatBytes(total, language),
              })
            : t('models.local.pull_waiting')}
        </span>
        <Button
          className="ms-auto"
          size="sm"
          variant="ghost"
          loading={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
          data-testid="local-pull-cancel"
        >
          {t('common.cancel')}
        </Button>
      </div>
      <div className="agent-progress mt-1">
        <div className="agent-progress-bar" style={{ inlineSize: `${percent ?? 0}%` }} />
      </div>
    </div>
  );
}
