/**
 * The files open beside the chat (owner, 2026-09-25: «وبذات اني اقدر استعرض الملفات
 * بالمحادثه»): one tab per file, the file drawn by its kind, and Download / Open in new tab.
 * Drawn in the frame's split pane — docked and resizable on a desktop, the whole screen on a
 * phone (SplitPane) — and kept current: when the agent changes an open file, the list says
 * so (`modified_at`) and the tab reads it again.
 *
 * A video or a sound plays in the panel (§97) from a one-hour stream address, a byte range at a
 * time, so a long file starts at once and seeks; Download saves it from the same address.
 */
import { HubApiError } from '@corehub/contracts';
import { lazy, Suspense, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { describeError } from '../auth/client.js';
import { Markdown } from '../chat/Markdown.js';
import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import type { SessionFile } from '../types.js';
import { Button, Notice, Spinner } from '../ui/index.js';
import { IconClose, IconDownload, IconExternal } from '../ui/icons.js';
import { parseDiffKey } from './changes.js';
import { useSessionFilesContext } from './context.js';
import { DiffView } from './DiffView.js';
import { CSV_MAX_ROWS, delimiterOf, parseCsv } from './csv.js';
import { PREVIEW_SANDBOX, sandboxedPage, withPolicy } from './html.js';
import { formatBytes, languageOf, previewable } from './kinds.js';
import { useFileBytes, useSaveFile, type FileBytes } from './queries.js';
import { MediaPlayer, useMediaStream, type MediaKind } from '../chat/InlineMedia.js';

// Office files need a ZIP reader; it is loaded the first time one is opened, not with the app.
const OfficePreview = lazy(() => import('./OfficePreview.js'));

export function FilePreviewPanel() {
  const { t } = useI18n();
  const files = useSessionFilesContext();
  const pane = usePane();
  const active = files.active ? files.fileOf(files.active) : undefined;
  // A run's diff of one file is a tab too (decision §49), keyed `diff:<run>:<path>`.
  const activeDiff = files.active ? parseDiffKey(files.active) : null;

  const close = (key: string) => {
    if (files.tabs.length === 1) pane.close();
    files.closeTab(key);
  };

  return (
    <div className="file-panel" data-testid="file-panel">
      <div className="file-tabs" role="tablist" aria-label={t('files.panel_label')}>
        {files.tabs.map((key) => {
          const file = files.fileOf(key);
          const diff = parseDiffKey(key);
          const name = diff
            ? t('changes.diff_tab', { name: diff.path.split('/').at(-1) ?? diff.path })
            : (file?.name ?? key.replace(/^(path|attachment):/, ''));
          const selected = key === files.active;
          return (
            <div key={key} className="file-tab" data-active={selected ? 'true' : 'false'}>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="file-tab-name"
                dir="auto"
                onClick={() => files.activate(key)}
                data-testid="file-tab"
              >
                {name}
              </button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('files.close_tab', { name })}
                icon={<IconClose size={12} />}
                onClick={() => close(key)}
              />
            </div>
          );
        })}
      </div>
      {activeDiff ? (
        <DiffView
          key={files.active}
          sessionId={files.sessionId}
          runId={activeDiff.runId}
          path={activeDiff.path}
        />
      ) : active ? (
        <FileView key={active.key} sessionId={files.sessionId} file={active} />
      ) : files.active && files.status === 'loading' ? (
        <Spinner label={t('files.loading')} />
      ) : files.active ? (
        <Notice tone="warning">{t('files.gone')}</Notice>
      ) : null}
    </div>
  );
}

/** Kinds a browser tab can show by itself (an SVG is not: it would run in our origin). */
function opensInNewTab(file: SessionFile): boolean {
  if (file.preview === 'image') return file.mime !== 'image/svg+xml';
  return ['html', 'pdf', 'markdown', 'code', 'text', 'csv'].includes(file.preview);
}

function openInNewTab(file: SessionFile, bytes: FileBytes): void {
  const blob =
    file.preview === 'html'
      ? new Blob([sandboxedPage(file.name, bytes.text ?? '')], { type: 'text/html' })
      : file.preview === 'pdf' || file.preview === 'image'
        ? bytes.blob
        : new Blob([bytes.text ?? ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function FileView({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const { t, language } = useI18n();
  const canPreview = previewable(file);
  // A video or a sound is played from a stream address, never read whole into the page (§97).
  const media: MediaKind | null =
    file.preview === 'video' || file.preview === 'audio' ? file.preview : null;
  const bytes = useFileBytes(sessionId, file, canPreview && media === null);
  const stream = useMediaStream(
    file.attachment_id !== null
      ? { kind: 'attachment', attachmentId: file.attachment_id }
      : { kind: 'path', sessionId, path: file.path ?? '' },
    media !== null,
  );
  const saveFile = useSaveFile(sessionId);
  // A long video is saved from its stream address too, so the page never holds all of it.
  const save = async (target: SessionFile) => {
    if (media === null || !stream.data) return saveFile(target);
    const anchor = document.createElement('a');
    anchor.href = stream.data.url;
    anchor.download = target.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };
  const [source, setSource] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  const when = file.modified_at
    ? new Date(file.modified_at).toLocaleString(language, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;
  const download = (
    <Button
      size="sm"
      icon={<IconDownload size={14} />}
      onClick={() => {
        setSaveError(null);
        save(file).catch(setSaveError);
      }}
      data-testid="file-download"
    >
      {t('files.download')}
    </Button>
  );

  return (
    <div className="file-view" data-testid="file-view" data-kind={file.preview}>
      <div className="file-bar">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" dir="auto" data-testid="file-name">
            {file.path ?? file.name}
          </p>
          <p className="text-xs text-muted">
            <span dir="ltr">{formatBytes(file.size_bytes)}</span>
            {when && <> · {t('files.modified', { time: when })}</>}
          </p>
        </div>
        {file.preview === 'html' && bytes.data && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={source}
            onClick={() => setSource((on) => !on)}
            data-testid="file-source-toggle"
          >
            {source ? t('files.view_rendered') : t('files.view_source')}
          </Button>
        )}
        {opensInNewTab(file) && bytes.data && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={t('files.open_new_tab')}
            tooltip={t('files.open_new_tab')}
            icon={<IconExternal size={14} />}
            onClick={() => bytes.data && openInNewTab(file, bytes.data)}
            data-testid="file-new-tab"
          />
        )}
        {download}
      </div>
      {saveError !== null && <Notice tone="danger">{describeError(saveError, t)}</Notice>}
      <div className="file-body">
        {media !== null && canPreview ? (
          stream.isError ? (
            <Notice tone="danger">{describeError(stream.error, t)}</Notice>
          ) : !stream.data ? (
            <Spinner label={t('files.loading')} />
          ) : (
            <div className="file-media" data-testid="file-media">
              <MediaPlayer
                key={stream.data.url}
                url={stream.data.url}
                name={file.name}
                kind={media}
                className={media === 'video' ? 'file-video' : 'file-audio'}
                testId={media === 'video' ? 'file-video' : 'file-audio'}
                fallback={<Notice tone="info">{t('files.cannot_play')}</Notice>}
              />
            </div>
          )
        ) : !canPreview ? (
          <Notice tone="info">
            {file.preview === 'none'
              ? t('files.no_preview')
              : t('files.too_large', { size: formatBytes(file.size_bytes) })}
          </Notice>
        ) : bytes.isPending ? (
          <Spinner label={t('files.loading')} />
        ) : bytes.isError ? (
          <Notice tone={tooLarge(bytes.error) ? 'info' : 'danger'}>
            {tooLarge(bytes.error)
              ? t('files.too_large', { size: formatBytes(file.size_bytes) })
              : describeError(bytes.error, t)}
          </Notice>
        ) : (
          <PreviewBody file={file} bytes={bytes.data} source={source} />
        )}
      </div>
    </div>
  );
}

function tooLarge(error: unknown): boolean {
  return error instanceof HubApiError && error.status === 413;
}

/** A blob as a URL for the page, revoked when the tab lets go of it. */
function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

export function PreviewBody({
  file,
  bytes,
  source = false,
}: {
  file: SessionFile;
  bytes: FileBytes;
  source?: boolean;
}) {
  const { t } = useI18n();
  const text = bytes.text ?? '';
  switch (file.preview) {
    case 'html':
      return source ? (
        <CodeView text={text} language="xml" />
      ) : (
        <div className="file-html">
          <iframe
            className="file-frame"
            sandbox={PREVIEW_SANDBOX}
            srcDoc={withPolicy(text)}
            aria-label={file.name}
            data-testid="file-html-frame"
          />
          <p className="text-xs text-muted">{t('files.html_note')}</p>
        </div>
      );
    case 'pdf':
      return <BlobFrame blob={bytes.blob} label={file.name} />;
    case 'image':
      return <BlobImage blob={bytes.blob} label={file.name} />;
    case 'markdown':
      return (
        <div className="file-markdown" data-testid="file-markdown">
          <Markdown text={text} />
        </div>
      );
    case 'code':
      return <CodeView text={text} language={languageOf(file.name)} />;
    case 'text':
      return (
        <pre className="file-text" dir="auto" data-testid="file-text">
          {text}
        </pre>
      );
    case 'csv':
      return <CsvTable text={text} name={file.name} />;
    case 'xlsx':
    case 'docx':
    case 'pptx':
      return (
        <Suspense fallback={<Spinner label={t('files.loading')} />}>
          <OfficePreview kind={file.preview} blob={bytes.blob} />
        </Suspense>
      );
    default:
      return <Notice tone="info">{t('files.no_preview')}</Notice>;
  }
}

function BlobFrame({ blob, label }: { blob: Blob; label: string }) {
  const url = useObjectUrl(blob);
  return url ? (
    <iframe className="file-frame" src={url} aria-label={label} data-testid="file-pdf" />
  ) : null;
}

function BlobImage({ blob, label }: { blob: Blob; label: string }) {
  const url = useObjectUrl(blob);
  return url ? <img className="file-image" src={url} alt={label} data-testid="file-image" /> : null;
}

/** Above this, code is shown plain: highlighting a very long file would stall the page. */
const HIGHLIGHT_MAX_CHARS = 200_000;

export function CodeView({ text, language }: { text: string; language: string }) {
  if (text.length > HIGHLIGHT_MAX_CHARS || !language) {
    return (
      <pre className="file-code" dir="ltr" data-testid="file-code">
        <code>{text}</code>
      </pre>
    );
  }
  // A fence longer than any run of backticks in the file, so the file cannot close it.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return (
    <div className="file-code-wrap" dir="ltr" data-testid="file-code">
      <ReactMarkdown
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{ pre: (props) => <pre {...props} className="file-code" /> }}
      >
        {`${fence}${language}\n${text}\n${fence}`}
      </ReactMarkdown>
    </div>
  );
}

function CsvTable({ text, name }: { text: string; name: string }) {
  const { t } = useI18n();
  const table = parseCsv(text, delimiterOf(name));
  return (
    <div className="file-table-wrap" data-testid="file-csv">
      {table.totalRows > table.rows.length && (
        <p className="mb-2 text-xs text-muted">
          {t('files.rows_capped', { shown: CSV_MAX_ROWS, total: table.totalRows })}
        </p>
      )}
      <table className="file-table">
        <thead>
          <tr>
            {table.header.map((cell, index) => (
              <th key={index} dir="auto" scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} dir="auto">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
