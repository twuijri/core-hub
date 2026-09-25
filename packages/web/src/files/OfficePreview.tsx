/**
 * Word, Excel and PowerPoint files, read in the browser from their XML (decision §47): a
 * workbook's sheets as tables, a document's text with its headings, lists and tables, a
 * deck as an outline of its slides. Loaded on first use (`lazy`), with the ZIP reader.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';
import { Notice, Spinner } from '../ui/index.js';
import { readDocx, type Block, type Run } from './office/docx.js';
import { readPptx, type Slide } from './office/pptx.js';
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, readXlsx, type Sheet } from './office/xlsx.js';
import { OfficeFileError } from './office/zip.js';

type Parsed =
  | { kind: 'xlsx'; sheets: Sheet[] }
  | { kind: 'docx'; blocks: Block[] }
  | { kind: 'pptx'; slides: Slide[] };

export function parseOffice(kind: 'xlsx' | 'docx' | 'pptx', bytes: Uint8Array): Parsed {
  if (kind === 'xlsx') return { kind, sheets: readXlsx(bytes) };
  if (kind === 'docx') return { kind, blocks: readDocx(bytes) };
  return { kind, slides: readPptx(bytes) };
}

export default function OfficePreview({
  kind,
  blob,
}: {
  kind: 'xlsx' | 'docx' | 'pptx';
  blob: Blob;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ parsed?: Parsed; error?: unknown }>({});
  useEffect(() => {
    let live = true;
    setState({});
    blob
      .arrayBuffer()
      .then((buffer) => parseOffice(kind, new Uint8Array(buffer)))
      .then((parsed) => live && setState({ parsed }))
      .catch((error: unknown) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [kind, blob]);

  if (state.error !== undefined) {
    const reason = state.error instanceof OfficeFileError ? state.error.reason : 'damaged';
    return <Notice tone="danger">{t(`files.office_error.${reason}`)}</Notice>;
  }
  if (!state.parsed) return <Spinner label={t('files.loading')} />;
  if (state.parsed.kind === 'xlsx') return <Workbook sheets={state.parsed.sheets} />;
  if (state.parsed.kind === 'docx') return <DocumentView blocks={state.parsed.blocks} />;
  return <Deck slides={state.parsed.slides} />;
}

function Workbook({ sheets }: { sheets: Sheet[] }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const sheet = sheets[index];
  return (
    <div data-testid="file-xlsx">
      {sheets.length > 1 && (
        <div className="file-sheets" role="tablist" aria-label={t('files.sheets_label')}>
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === index}
              className="file-sheet"
              dir="auto"
              onClick={() => setIndex(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet && (
        <div className="file-table-wrap">
          {sheet.totalRows > sheet.rows.length && (
            <p className="mb-2 text-xs text-muted">
              {t('files.rows_capped', { shown: SHEET_MAX_ROWS, total: sheet.totalRows })}
            </p>
          )}
          {sheet.clipped && (
            <p className="mb-2 text-xs text-muted">
              {t('files.columns_capped', { count: SHEET_MAX_COLUMNS })}
            </p>
          )}
          <table className="file-table">
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) =>
                    r === 0 ? (
                      <th key={c} dir="auto" scope="col">
                        {cell}
                      </th>
                    ) : (
                      <td key={c} dir="auto">
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Runs({ runs }: { runs: Run[] }) {
  return runs.map((run, i) => {
    let node: ReactNode = run.text;
    if (run.underline) node = <u>{node}</u>;
    if (run.italic) node = <em>{node}</em>;
    if (run.bold) node = <strong>{node}</strong>;
    return <span key={i}>{node}</span>;
  });
}

/** Consecutive list paragraphs become one list. */
function DocumentView({ blocks }: { blocks: Block[] }) {
  const { t } = useI18n();
  const out: ReactNode[] = [];
  let list: Array<Extract<Block, { type: 'paragraph' }>> = [];
  const flush = () => {
    if (list.length === 0) return;
    out.push(
      <ul key={`l${out.length}`}>
        {list.map((item, i) => (
          <li key={i} dir={item.rtl ? 'rtl' : 'auto'}>
            <Runs runs={item.runs} />
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  blocks.forEach((block, i) => {
    if (block.type === 'paragraph' && block.list) {
      list.push(block);
      return;
    }
    flush();
    if (block.type === 'heading') {
      const Tag = `h${Math.min(6, block.level + 1)}` as 'h2';
      out.push(
        <Tag key={i} dir={block.rtl ? 'rtl' : 'auto'}>
          <Runs runs={block.runs} />
        </Tag>,
      );
    } else if (block.type === 'paragraph') {
      if (block.runs.length === 0) return;
      out.push(
        <p key={i} dir={block.rtl ? 'rtl' : 'auto'}>
          <Runs runs={block.runs} />
        </p>,
      );
    } else {
      out.push(
        <div key={i} className="file-table-wrap">
          <table className="file-table">
            <tbody>
              {block.rows.map((row, r) => (
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
        </div>,
      );
    }
  });
  flush();
  return (
    <div data-testid="file-docx">
      <p className="mb-3 text-xs text-muted">{t('files.docx_note')}</p>
      <div className="prose-chat file-document">{out}</div>
    </div>
  );
}

function Deck({ slides }: { slides: Slide[] }) {
  const { t } = useI18n();
  return (
    <div data-testid="file-pptx">
      <Notice tone="info" className="mb-3">
        {t('files.pptx_outline')}
      </Notice>
      <ol className="file-slides">
        {slides.map((slide) => (
          <li key={slide.number} className="file-slide">
            <p className="text-xs text-muted">{t('files.slide', { number: slide.number })}</p>
            <h3 className="font-semibold" dir="auto">
              {slide.title ?? t('files.untitled_slide')}
            </h3>
            {slide.paragraphs.length > 0 && (
              <ul>
                {slide.paragraphs.map((text, i) => (
                  <li key={i} dir="auto">
                    {text}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
