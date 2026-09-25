/**
 * What one run did to one file (decision §49), in the file panel beside the chat: the unified
 * diff the hub recorded when the run ended, with the old and new line numbers — or, on a wide
 * screen, the two sides next to each other — and a button that opens the file itself.
 *
 * Code reads left to right in an Arabic page too: the whole diff is `dir="ltr"`; only the
 * words around it follow the page.
 */
import { useEffect, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { RunFileDiff } from '../types.js';
import { Button, Notice, Segmented, Spinner } from '../ui/index.js';
import { IconExternal } from '../ui/icons.js';
import { parseUnifiedDiff, splitRows, type DiffHunk, type DiffLine } from './changes.js';
import { useSessionFilesContext } from './context.js';
import { useRunDiff } from './queries.js';
import { Counts } from './RunChangesCard.js';

/** Side by side needs room for two columns of code. */
const SPLIT_MIN_WIDTH = 1024;

function useWide(): boolean {
  const query = `(min-width: ${SPLIT_MIN_WIDTH}px)`;
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const change = () => setWide(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, [query]);
  return wide;
}

export function DiffView({
  sessionId,
  runId,
  path,
}: {
  sessionId: string;
  runId: string;
  path: string;
}) {
  const { t } = useI18n();
  const files = useSessionFilesContext();
  const diff = useRunDiff(sessionId, runId, path);
  const wide = useWide();
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const split = wide && layout === 'split';
  const fileKey = `path:${path}`;
  const file = files.fileOf(fileKey);
  const name = path.split('/').at(-1) ?? path;

  return (
    <div className="file-view" data-testid="diff-view" data-layout={split ? 'split' : 'unified'}>
      <div className="file-bar">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="diff-path">
            <bdi dir="ltr">{path}</bdi>
          </p>
          {diff.data && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="run-change-kind" data-change={diff.data.change}>
                {t(`changes.kind.${diff.data.change}`)}
              </span>
              {diff.data.old_path && (
                <span>
                  {t('diff.renamed_from')} <bdi dir="ltr">{diff.data.old_path}</bdi>
                </span>
              )}
              <Counts additions={diff.data.additions} deletions={diff.data.deletions} />
            </p>
          )}
        </div>
        {wide && diff.data?.text && (
          <Segmented
            size="sm"
            label={t('diff.layout')}
            value={layout}
            onChange={(value) => setLayout(value as 'unified' | 'split')}
            options={[
              {
                value: 'unified',
                label: t('diff.unified'),
                itemProps: { 'data-testid': 'diff-unified' },
              },
              {
                value: 'split',
                label: t('diff.split'),
                itemProps: { 'data-testid': 'diff-split' },
              },
            ]}
          />
        )}
        {file && (
          <Button
            size="sm"
            variant="ghost"
            icon={<IconExternal size={14} />}
            onClick={() => files.openTab(fileKey)}
            aria-label={t('diff.open_file_named', { name })}
            data-testid="diff-open-file"
          >
            {t('diff.open_file')}
          </Button>
        )}
      </div>
      <div className="file-body">
        {diff.isPending ? (
          <Spinner label={t('diff.loading')} />
        ) : diff.isError ? (
          <Notice tone="danger">{describeError(diff.error, t)}</Notice>
        ) : (
          <DiffBody diff={diff.data} split={split} />
        )}
      </div>
    </div>
  );
}

function DiffBody({ diff, split }: { diff: RunFileDiff; split: boolean }) {
  const { t } = useI18n();
  if (diff.diff !== 'available' || diff.text === null) {
    return <Notice tone="info">{t(`diff.state.${diff.diff}`)}</Notice>;
  }
  const hunks = parseUnifiedDiff(diff.text);
  return (
    <div className="diff-wrap" dir="ltr">
      {diff.truncated && (
        <p className="diff-note" dir="auto">
          {t('diff.truncated')}
        </p>
      )}
      {hunks.length === 0 ? (
        <p className="diff-note" dir="auto">
          {t('diff.no_lines')}
        </p>
      ) : (
        <table
          className="diff-table"
          data-testid="diff-table"
          data-split={split ? 'true' : 'false'}
        >
          {hunks.map((hunk, index) =>
            split ? <SplitHunk key={index} hunk={hunk} /> : <UnifiedHunk key={index} hunk={hunk} />,
          )}
        </table>
      )}
    </div>
  );
}

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', context: ' ', note: '' };

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <tbody>
      <tr className="diff-hunk">
        <td colSpan={3}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, index) => (
        <tr key={index} className="diff-line" data-kind={line.kind} data-testid="diff-line">
          <td className="diff-num">{line.old ?? ''}</td>
          <td className="diff-num">{line.new ?? ''}</td>
          <td className="diff-code">
            <span className="diff-sign" aria-hidden>
              {SIGN[line.kind]}
            </span>
            {line.text}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

function SplitHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <tbody>
      <tr className="diff-hunk">
        <td colSpan={4}>{hunk.header}</td>
      </tr>
      {splitRows(hunk).map((row, index) => (
        <tr key={index} className="diff-line" data-testid="diff-line">
          <td className="diff-num">{row.left?.old ?? ''}</td>
          <td className="diff-code diff-half" data-kind={row.left?.kind ?? 'empty'}>
            {row.left?.text ?? ''}
          </td>
          <td className="diff-num">{row.right?.new ?? ''}</td>
          <td className="diff-code diff-half" data-kind={row.right?.kind ?? 'empty'}>
            {row.right?.text ?? ''}
          </td>
        </tr>
      ))}
    </tbody>
  );
}
