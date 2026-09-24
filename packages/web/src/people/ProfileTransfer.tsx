/**
 * Moving a profile in and out as Hermes's own archive (ADR 0014 stage 2).
 *
 * **Export** is one button and a job: Hermes writes the archive, the hub leaves out the
 * credential files and blanks every provider key it stores, and the browser saves the file
 * the moment the job is done. The dialog says what is in the archive and what is not
 * before anything starts, because "export" alone does not say whether a key goes with it.
 *
 * **Import** is a file, a slug and a name: the file is uploaded (with its progress), then a
 * job hands it to Hermes, which makes the profile; the list shows it when the job is done.
 * A slug already used is refused here, before the hub has to.
 *
 * Neither exists on a hub that does not run Hermes itself; the hub says so by name and the
 * dialog shows that sentence.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
  useDownloadAttachment,
  useUploadAttachment,
} from '../attachments/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, Field, Input, Notice, Segmented, useToast } from '../ui/index.js';
import {
  PROFILE_NAME_MAX,
  jobFinished,
  peopleKeys,
  useExportWorkspace,
  useFollowedJob,
  useImportWorkspace,
  type ProfileExportResult,
  type ProfileImportResult,
  type Workspace,
} from './queries.js';
import type { Job } from '../types.js';

/** The contract's `ProfileSlug`, checked here so the field says so before the hub does. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

function useSize(): (bytes: number) => string {
  const { language } = useI18n();
  const number = new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en', {
    maximumFractionDigits: 1,
  });
  return (bytes) =>
    bytes >= 1_048_576
      ? `${number.format(bytes / 1_048_576)} MB`
      : `${number.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/** The bar and the line under it, for a job that is running or has just ended. */
function JobProgress({
  job,
  testId,
  ratio,
}: {
  job?: Job | undefined;
  testId: string;
  ratio?: number;
}) {
  const { t } = useI18n();
  const running = !job || !jobFinished(job);
  const percent =
    ratio !== undefined ? Math.round(ratio * 100) : (job?.progress.percent ?? (running ? 5 : 100));
  return (
    <div aria-live="polite" data-testid={testId} data-status={job?.status ?? 'queued'}>
      <div
        className="agent-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="agent-progress-bar" style={{ inlineSize: `${percent}%` }} />
      </div>
      {job?.progress.message && !job.error && (
        <p className="mt-1 text-xs text-muted" dir="auto">
          {job.progress.message}
        </p>
      )}
      {!job && ratio !== undefined && (
        <p className="mt-1 text-xs text-muted">{t('workspaces.import_uploading')}</p>
      )}
    </div>
  );
}

export function ExportDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const list = (items: string[]) => items.join(language === 'ar' ? '، ' : ', ');
  const size = useSize();
  const start = useExportWorkspace();
  const { save } = useDownloadAttachment();
  const [jobId, setJobId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  // «مع المزوّدين / بدون المزوّدين» (decision §37): without, the default, holds no key.
  const [withProviders, setWithProviders] = useState(false);
  const job = useFollowedJob(jobId);
  const result =
    job?.status === 'succeeded' ? (job.result as unknown as ProfileExportResult) : null;
  const running = start.isPending || (jobId !== null && !jobFinished(job));

  const download = useCallback(
    (ready: ProfileExportResult) => {
      setSaveError(null);
      save({
        attachment_id: ready.attachment_id,
        name: ready.name,
        mime: 'application/gzip',
      }).catch(setSaveError);
    },
    [save],
  );
  // The file is saved the moment the job is done — once; the button saves it again.
  const saved = useRef<string | null>(null);
  useEffect(() => {
    if (!result || saved.current === result.attachment_id) return;
    saved.current = result.attachment_id;
    download(result);
  }, [result, download]);

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('workspaces.export_title', { name: workspace.name })}
      closeLabel={t('ui.close')}
      testId="export-workspace-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('ui.close')}
          </Button>
          {result ? (
            <Button data-testid="download-export" onClick={() => download(result)}>
              {t('workspaces.export_download')}
            </Button>
          ) : (
            <Button
              disabled={running}
              data-testid="start-export"
              onClick={() =>
                start.mutate(
                  { id: workspace.id, providers: withProviders },
                  { onSuccess: (id) => setJobId(id) },
                )
              }
            >
              {t('workspaces.export')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">{t('workspaces.export_what')}</p>
        <fieldset className="flex flex-col gap-1">
          <legend className="ch-label">{t('workspaces.export_providers')}</legend>
          <Segmented
            className="self-start"
            label={t('workspaces.export_providers')}
            value={withProviders ? 'with' : 'without'}
            onChange={(next) => setWithProviders(next === 'with')}
            wrap
            testId="export-providers"
            options={[
              {
                value: 'without',
                label: t('workspaces.export_without_providers'),
                itemProps: { 'data-testid': 'export-without-providers' },
              },
              {
                value: 'with',
                label: t('workspaces.export_with_providers'),
                itemProps: { 'data-testid': 'export-with-providers' },
              },
            ]}
          />
        </fieldset>
        {withProviders ? (
          <Notice tone="warning" role="alert">
            <span data-testid="export-keys-warning">{t('workspaces.export_keys_warning')}</span>
          </Notice>
        ) : (
          <Notice>{t('workspaces.export_secrets')}</Notice>
        )}
        {jobId !== null && <JobProgress job={job} testId="export-progress" />}
        {result && (
          <Notice tone="success" role="status">
            <span data-testid="export-ready">
              {t('workspaces.export_ready', {
                file: result.name,
                size: size(result.size_bytes),
              })}
            </span>
            {result.removed.length > 0 && (
              <span className="block text-xs" dir="auto">
                {t('workspaces.export_removed', { files: list(result.removed) })}
              </span>
            )}
            {result.masked.length > 0 && (
              <span className="block text-xs" dir="auto">
                {t('workspaces.export_masked', { files: list(result.masked) })}
              </span>
            )}
            {(result.providers ?? 0) > 0 && (
              <span className="block text-xs" data-testid="export-providers-carried">
                {t('workspaces.export_providers_carried', { count: result.providers ?? 0 })}
              </span>
            )}
          </Notice>
        )}
        {job?.error && (
          <Notice tone="danger" role="alert">
            <span dir="auto">{job.error.error}</span>
          </Notice>
        )}
        {start.isError && (
          <Notice tone="danger" role="alert">
            {describeError(start.error, t)}
          </Notice>
        )}
        {saveError !== null && (
          <Notice tone="danger" role="alert">
            {describeError(saveError, t)}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

/** `design-20260924-101500.tar.gz` → `design`: the slug an archive suggests. */
export function slugFromArchive(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/\.(tar\.gz|tgz)$/, '')
    .replace(/-\d{8}-\d{6}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * `الرئيسي-20260925-101500.tar.gz` → `الرئيسي`: an export is named after the profile's name
 * (contract decision §44), which the import offers back as the new profile's name.
 */
export function nameFromArchive(fileName: string): string {
  return fileName
    .replace(/\.(tar\.gz|tgz)$/i, '')
    .replace(/-\d{8}-\d{6}$/, '')
    .trim()
    .slice(0, PROFILE_NAME_MAX)
    .trim();
}

/** The suggestion, made free: `design`, else `design-2`, `design-3` … */
function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!base) return '';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, 37)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return '';
}

export function ImportDialog({
  existing,
  onClose,
}: {
  existing: Workspace[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { upload } = useUploadAttachment();
  const start = useImportWorkspace();
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useFollowedJob(jobId);

  const taken = new Set(existing.map((workspace) => workspace.slug));
  const slugTaken = taken.has(slug);
  const badSlug = slug.length > 0 && !SLUG.test(slug);
  const busy = uploading !== null || start.isPending || (jobId !== null && !jobFinished(job));
  const ready = file !== null && slug.length > 0 && !badSlug && !slugTaken && !busy;

  // Done: the list learns the new profile, the person hears it once, the dialog closes.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!job || !jobId || announced.current === jobId) return;
    if (job.status === 'succeeded') {
      announced.current = jobId;
      const made = job.result as unknown as ProfileImportResult;
      void queryClient.invalidateQueries({ queryKey: peopleKeys.workspaces() });
      void queryClient.invalidateQueries({ queryKey: ['profiles'] });
      toast({ tone: 'success', title: t('workspaces.import_done', { name: made.name }) });
      onClose();
    } else if (job.status === 'failed' || job.status === 'cancelled') {
      announced.current = jobId;
      setFailure(job.error?.error ?? t(`jobs.status.${job.status}`));
    }
  }, [job, jobId, onClose, queryClient, t, toast]);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!chosen) return;
    setFile(chosen);
    setFailure(null);
    if (!slug) {
      const base = slugFromArchive(chosen.name);
      const suggested = freeSlug(base, taken);
      setSlug(suggested);
      // A file named after a profile's name offers that name; one named by an id (older
      // exports) offers the id chosen here, as before.
      const named = nameFromArchive(chosen.name);
      if (!name) setName(named && named !== base ? named : suggested);
    }
  };

  const submit = async () => {
    if (!file) return;
    setFailure(null);
    setJobId(null);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setFailure(t('workspaces.import_too_large'));
      return;
    }
    let attachmentId: string;
    try {
      setUploading(0);
      const stored = await upload({
        file,
        purpose: 'import',
        onProgress: (progress) => setUploading(progress.ratio),
      });
      attachmentId = stored.id;
    } catch (error) {
      setFailure(
        error instanceof AttachmentTooLargeError
          ? t('workspaces.import_too_large')
          : describeError(error, t),
      );
      return;
    } finally {
      setUploading(null);
    }
    start.mutate(
      { attachment_id: attachmentId, slug, ...(name.trim() ? { name: name.trim() } : {}) },
      {
        onSuccess: (id) => setJobId(id),
        onError: (error) => setFailure(describeError(error, t)),
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('workspaces.import_title')}
      closeLabel={t('common.cancel')}
      testId="import-workspace-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!ready} data-testid="start-import" onClick={() => void submit()}>
            {t('workspaces.import')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">{t('workspaces.import_what')}</p>
        <div className="flex items-center gap-2">
          <input
            ref={picker}
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            hidden
            data-testid="import-file"
            onChange={choose}
          />
          <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
            {t(file ? 'workspaces.import_other_file' : 'workspaces.import_choose')}
          </Button>
          <span className="truncate text-sm text-muted" dir="ltr" data-testid="import-file-name">
            {file?.name ?? t('workspaces.import_no_file')}
          </span>
        </div>
        <Field
          label={t('workspaces.slug')}
          hint={t('workspaces.slug_hint')}
          {...(badSlug
            ? { error: t('workspaces.slug_bad') }
            : slugTaken
              ? { error: t('workspaces.slug_taken') }
              : {})}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={slug}
              invalid={badSlug || slugTaken}
              onChange={(event) => setSlug(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('workspaces.name')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              maxLength={PROFILE_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {uploading !== null && <JobProgress testId="import-progress" ratio={uploading} />}
        {jobId !== null && !failure && <JobProgress job={job} testId="import-progress" />}
        {failure && (
          <Notice tone="danger" role="alert">
            <span dir="auto" data-testid="import-failure">
              {failure}
            </span>
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
