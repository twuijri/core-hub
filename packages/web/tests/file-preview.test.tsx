/**
 * The files of a conversation, beside the chat (decision §47; owner, 2026-09-25: «وبذات اني
 * اقدر استعرض الملفات بالمحادثه»).
 *
 * The pure rules first — CSV, which word names a file, when the list is read again, the
 * HTML sandbox, the bounded Office readers with small fixtures built here — then the panel
 * against a scripted hub, once per kind: each file drawn the way its kind is, nothing that
 * could run in the client's own origin, and Download for what cannot be shown.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Markdown } from '../src/chat/Markdown.js';
import { ToolCalls } from '../src/chat/ToolCallCard.js';
import { ThemeProvider } from '../src/design/theme.js';
import { SessionFilesProvider, useOpenFile } from '../src/files/context.js';
import { CSV_MAX_ROWS, parseCsv } from '../src/files/csv.js';
import { PREVIEW_CSP, PREVIEW_SANDBOX, sandboxedPage, withPolicy } from '../src/files/html.js';
import {
  fileForMention,
  filesOfToolCall,
  filesRevisionOf,
  formatBytes,
  previewable,
} from '../src/files/kinds.js';
import { readDocx } from '../src/files/office/docx.js';
import { readPptx } from '../src/files/office/pptx.js';
import { columnIndex, readXlsx } from '../src/files/office/xlsx.js';
import { OfficeFileError, ZIP_MAX_ENTRIES, readParts } from '../src/files/office/zip.js';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { SplitPane } from '../src/shell/SplitPane.js';
import type { SessionFile } from '../src/types.js';

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';

function file(over: Partial<SessionFile> & { name: string }): SessionFile {
  const path = over.path === undefined ? over.name : over.path;
  return {
    key: over.attachment_id ? `attachment:${over.attachment_id}` : `path:${path}`,
    path,
    attachment_id: null,
    message_id: null,
    mime: 'text/plain',
    preview: 'text',
    size_bytes: 10,
    preview_max_bytes: 2 * 1024 * 1024,
    modified_at: '2026-09-25T10:00:00.000Z',
    sources: ['working_dir'],
    tool_call_ids: [],
    ...over,
  };
}

// ---------------------------------------------------------------- Office fixtures

/** A ZIP as the body of a response. */
function zip(parts: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  return zipSync(parts) as Uint8Array<ArrayBuffer>;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

function xlsxFixture(): Uint8Array<ArrayBuffer> {
  return zip({
    'xl/workbook.xml': strToU8(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="الميزانية" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>البند</t></si><si><r><t>Am</t></r><r><t>ount</t></r></si><si><t>إيجار</t></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1200</v></c><c r="D2" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row></sheetData></worksheet>',
    ),
  });
}

function docxFixture(): Uint8Array<ArrayBuffer> {
  return zip({
    'word/document.xml': strToU8(
      `<w:document xmlns:w="${W}"><w:body>` +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:bidi/></w:pPr><w:r><w:t>تقرير الربع</w:t></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> and plain</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>first item</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    ),
  });
}

function pptxFixture(): Uint8Array<ArrayBuffer> {
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const slide = (title: string, body: string) =>
    strToU8(
      `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>` +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
        `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>` +
        '</p:spTree></p:cSld></p:sld>',
    );
  return zip({
    'ppt/presentation.xml': strToU8(
      `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      `<Relationships xmlns="${PKG}"><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`,
    ),
    'ppt/slides/slide1.xml': slide('الخاتمة', 'شكرًا'),
    'ppt/slides/slide2.xml': slide('Agenda', 'Three things'),
  });
}

// ---------------------------------------------------------------- pure rules

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, CRLF and a byte-order mark', () => {
    const table = parseCsv('\ufeffname,note\r\n"أحمد, الأول","قال ""نعم"""\r\nسارة,\n');
    expect(table.header).toEqual(['name', 'note']);
    expect(table.rows).toEqual([
      ['أحمد, الأول', 'قال "نعم"'],
      ['سارة', ''],
    ]);
    expect(table.totalRows).toBe(2);
  });

  it('keeps the first rows and counts all of them', () => {
    const lines = ['n', ...Array.from({ length: CSV_MAX_ROWS + 20 }, (_, i) => String(i))];
    const table = parseCsv(lines.join('\n'));
    expect(table.rows).toHaveLength(CSV_MAX_ROWS);
    expect(table.totalRows).toBe(CSV_MAX_ROWS + 20);
    expect(parseCsv('a\tb\n1\t2', '\t').rows).toEqual([['1', '2']]);
  });
});

describe('which file a word names', () => {
  const files = [
    file({ name: 'report.html', path: 'out/report.html', preview: 'html' }),
    file({ name: 'notes.md', preview: 'markdown' }),
    file({ name: 'notes.md', path: 'old/notes.md', preview: 'markdown' }),
    file({ name: 'data.csv', path: null, attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0AT' }),
  ];
  it('matches a path, a path the agent printed in full, or a unique bare name', () => {
    expect(fileForMention(files, 'out/report.html')?.key).toBe('path:out/report.html');
    expect(fileForMention(files, '/data/workspaces/default/s/out/report.html')?.key).toBe(
      'path:out/report.html',
    );
    expect(fileForMention(files, 'report.html')?.key).toBe('path:out/report.html');
    expect(fileForMention(files, './notes.md')?.key).toBe('path:notes.md');
    expect(fileForMention(files, 'data.csv')?.key).toBe('attachment:01J8QK3ZR2W7M5N4P6T8V9X0AT');
    expect(fileForMention(files, 'the report')).toBeNull();
    expect(fileForMention(files, 'report.htm')).toBeNull();
  });

  it('finds the files of a tool call, and what can be previewed', () => {
    const written = file({ name: 'a.md', tool_call_ids: ['T1'] });
    expect(filesOfToolCall([written, files[1]!], 'T1')).toEqual([written]);
    expect(previewable(file({ name: 'x.zip', preview: 'none' }))).toBe(false);
    expect(previewable(file({ name: 'big.md', size_bytes: 3e6, preview_max_bytes: 2e6 }))).toBe(
      false,
    );
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('filesRevisionOf', () => {
  it('changes when a tool call or a run ends, not while text streams', () => {
    const running = [{ id: 'm', tool_calls: [{ status: 'running' }] }];
    const done = [{ id: 'm', tool_calls: [{ status: 'succeeded' }] }];
    const runs = { r: { status: 'running' } };
    expect(filesRevisionOf(running, runs)).toBe(filesRevisionOf(running, runs));
    expect(filesRevisionOf(done, runs)).not.toBe(filesRevisionOf(running, runs));
    expect(filesRevisionOf(done, { r: { status: 'succeeded' } })).not.toBe(
      filesRevisionOf(done, runs),
    );
  });
});

describe('the HTML sandbox', () => {
  it('puts the policy first and never allows the client origin', () => {
    expect(PREVIEW_SANDBOX).toBe('allow-scripts');
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(withPolicy('<p>hi</p>')).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
  });

  it('wraps a page for a new tab so its markup cannot leave the frame', () => {
    const page = sandboxedPage('r"eport', '"><script>parent.x=1</script>');
    const doc = new DOMParser().parseFromString(page, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    const frame = doc.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('srcdoc')).toContain('"><script>parent.x=1</script>');
    expect(doc.title).toBe('r"eport');
  });
});

describe('the Office readers', () => {
  it('reads a workbook: sheets, shared and inline strings, gaps and booleans', () => {
    const sheets = readXlsx(xlsxFixture());
    expect(sheets.map((s) => s.name)).toEqual(['الميزانية', 'Notes']);
    expect(sheets[0]?.rows).toEqual([
      ['البند', 'Amount'],
      ['إيجار', '', '1200', 'TRUE'],
    ]);
    expect(sheets[1]?.rows).toEqual([['hello']]);
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('AB7')).toBe(27);
  });

  it('reads a document: a right-to-left heading, bold runs, a list item and a table', () => {
    const blocks = readDocx(docxFixture());
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, rtl: true });
    expect(blocks[1]).toMatchObject({
      type: 'paragraph',
      list: false,
      runs: [
        { text: 'Bold', bold: true },
        { text: ' and plain', bold: false },
      ],
    });
    expect(blocks[2]).toMatchObject({ type: 'paragraph', list: true });
    expect(blocks[3]).toEqual({ type: 'table', rows: [['a', 'b']] });
  });

  it("reads a deck's outline in the deck's own order", () => {
    expect(readPptx(pptxFixture())).toEqual([
      { number: 1, title: 'Agenda', paragraphs: ['Three things'] },
      { number: 2, title: 'الخاتمة', paragraphs: ['شكرًا'] },
    ]);
  });

  it('refuses a ZIP bomb before inflating it, and too many parts', () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(31 * 1024 * 1024) });
    expect(() => readParts(bomb, () => true)).toThrow(OfficeFileError);
    try {
      readParts(bomb, () => true);
    } catch (error) {
      expect((error as OfficeFileError).reason).toBe('too_large');
    }
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ZIP_MAX_ENTRIES; i += 1) many[`p${i}.xml`] = new Uint8Array(0);
    expect(() => readParts(zipSync(many), () => false)).toThrow('too_many_entries');
    expect(() => readDocx(strToU8('not a zip at all'))).toThrow(OfficeFileError);
  });
});

// ---------------------------------------------------------------- the panel

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

function Opener({ fileKey }: { fileKey: string }) {
  const open = useOpenFile();
  return (
    <>
      <button type="button" onClick={() => open?.(fileKey)}>
        open it
      </button>
      <SplitPane />
    </>
  );
}

const requests: string[] = [];

function renderPanel(
  files: SessionFile[],
  bodies: Record<string, BodyInit>,
  open: string,
  extra?: ReactNode,
) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/files')) {
      return Promise.resolve(
        new Response(JSON.stringify({ working_dir: '/w', truncated: false, items: files }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    const key = url.searchParams.get('path') ?? url.pathname.split('/').at(-2) ?? '';
    const body = bodies[key];
    if (body === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'too big', code: 'payload_too_large' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <SessionFilesProvider sessionId={SESSION} revision="r1">
              <PaneProvider>
                <Opener fileKey={open} />
                {extra}
              </PaneProvider>
            </SessionFilesProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  if (!extra) fireEvent.click(screen.getByText('open it'));
}

beforeAll(() => {
  // jsdom has no object URLs; the panel only needs a string to point an <img> or a frame at.
  URL.createObjectURL = vi.fn(() => 'blob:http://hub.test/preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  requests.length = 0;
});

describe('the preview panel', () => {
  it('renders HTML in a sandboxed frame with the policy first, and shows its source', async () => {
    renderPanel(
      [file({ name: 'report.html', preview: 'html', mime: 'text/html' })],
      { 'report.html': '<h1>تقرير</h1><script>alert(1)</script>' },
      'path:report.html',
    );
    const frame = await screen.findByTestId('file-html-frame');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    expect(frame.getAttribute('srcdoc')).toContain('<h1>تقرير</h1>');
    expect(requests).toContain(
      `/api/v1/sessions/${SESSION}/files/content?path=report.html&download=false`,
    );
    fireEvent.click(screen.getByTestId('file-source-toggle'));
    expect((await screen.findByTestId('file-code')).textContent).toContain('<h1>تقرير</h1>');
    expect(screen.queryByTestId('file-html-frame')).toBeNull();
  });

  it('shows a PDF in the browser viewer and a picture as an image', async () => {
    renderPanel(
      [file({ name: 'scan.pdf', preview: 'pdf', mime: 'application/pdf' })],
      { 'scan.pdf': '%PDF-1.4' },
      'path:scan.pdf',
    );
    expect((await screen.findByTestId('file-pdf')).getAttribute('src')).toMatch(/^blob:/);
    cleanup();
    renderPanel(
      [file({ name: 'chart.png', preview: 'image', mime: 'image/png' })],
      { 'chart.png': new Uint8Array([0x89, 0x50]) },
      'path:chart.png',
    );
    const img = await screen.findByTestId('file-image');
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(img.getAttribute('alt')).toBe('chart.png');
  });

  it('renders Markdown with the chat renderer and code highlighted', async () => {
    renderPanel(
      [file({ name: 'notes.md', preview: 'markdown', mime: 'text/markdown' })],
      { 'notes.md': '# ملاحظات\n\n- أولًا' },
      'path:notes.md',
    );
    const md = await screen.findByTestId('file-markdown');
    expect(md.querySelector('h1')?.textContent).toBe('ملاحظات');
    expect(md.querySelector('[dir="auto"]')).not.toBeNull();
    cleanup();
    renderPanel(
      [file({ name: 'app.ts', preview: 'code' })],
      { 'app.ts': 'const answer = 42; // ```' },
      'path:app.ts',
    );
    const code = await screen.findByTestId('file-code');
    expect(code.getAttribute('dir')).toBe('ltr');
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code.textContent).toContain('// ```');
  });

  it('draws a CSV as a table with its header', async () => {
    renderPanel(
      [file({ name: 'data.csv', preview: 'csv', mime: 'text/csv' })],
      { 'data.csv': 'name,count\nأ,1\nب,2\n' },
      'path:data.csv',
    );
    const table = await screen.findByTestId('file-csv');
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual([
      'name',
      'count',
    ]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('reads an attachment through its own operation, and draws Office files', async () => {
    renderPanel(
      [
        file({
          name: 'budget.xlsx',
          path: null,
          attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0AT',
          preview: 'xlsx',
          sources: ['attachment'],
        }),
      ],
      { '01J8QK3ZR2W7M5N4P6T8V9X0AT': xlsxFixture() },
      'attachment:01J8QK3ZR2W7M5N4P6T8V9X0AT',
    );
    const sheet = await screen.findByTestId('file-xlsx', {}, { timeout: 3000 });
    expect(sheet.textContent).toContain('الميزانية');
    expect(sheet.querySelector('th')?.textContent).toBe('البند');
    expect(requests.some((r) => r.endsWith('attachments/01J8QK3ZR2W7M5N4P6T8V9X0AT/content'))).toBe(
      true,
    );
    cleanup();
    renderPanel(
      [file({ name: 'letter.docx', preview: 'docx' })],
      { 'letter.docx': docxFixture() },
      'path:letter.docx',
    );
    const doc = await screen.findByTestId('file-docx', {}, { timeout: 3000 });
    expect(doc.querySelector('h2')?.getAttribute('dir')).toBe('rtl');
    expect(doc.querySelector('strong')?.textContent).toBe('Bold');
    expect(doc.querySelector('li')?.textContent).toBe('first item');
    cleanup();
    renderPanel(
      [file({ name: 'deck.pptx', preview: 'pptx' })],
      { 'deck.pptx': pptxFixture() },
      'path:deck.pptx',
    );
    const deck = await screen.findByTestId('file-pptx', {}, { timeout: 3000 });
    expect(deck.textContent).toContain('outline');
    expect([...deck.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Agenda',
      'الخاتمة',
    ]);
  });

  it('offers Download for what it cannot show, without reading it', async () => {
    renderPanel(
      [
        file({ name: 'archive.zip', preview: 'none', mime: 'application/octet-stream' }),
        file({ name: 'huge.md', preview: 'markdown', size_bytes: 3e6, preview_max_bytes: 2e6 }),
      ],
      {},
      'path:archive.zip',
    );
    expect(await screen.findByText(/cannot be shown here/)).toBeInTheDocument();
    expect(screen.getByTestId('file-download')).toBeInTheDocument();
    expect(screen.queryByTestId('file-new-tab')).toBeNull();
    expect(requests.some((r) => r.includes('/files/content'))).toBe(false);
  });

  it('says so when the hub refuses a file as too large', async () => {
    renderPanel([file({ name: 'grown.md', preview: 'markdown' })], {}, 'path:grown.md');
    expect(await screen.findByText(/too large to show here/)).toBeInTheDocument();
  });
});

describe('a reply that names a file', () => {
  it('links the name to the file, and leaves other words and code blocks alone', async () => {
    renderPanel(
      [file({ name: 'report.html', path: 'out/report.html', preview: 'html', mime: 'text/html' })],
      { 'out/report.html': '<p>hi</p>' },
      'path:out/report.html',
      <Markdown
        text={
          'Wrote out/report.html. Also see `report.html`, not myreport.html.\n\n```\nreport.html\n```'
        }
      />,
    );
    const links = await screen.findAllByTestId('file-mention');
    expect(links.map((link) => link.textContent)).toEqual(['out/report.html', 'report.html']);
    // The code block keeps the name as code.
    expect(document.querySelector('pre')?.textContent).toContain('report.html');
    fireEvent.click(links[0]!);
    expect(await screen.findByTestId('file-html-frame')).toBeInTheDocument();
  });
});

describe('a tool card that wrote a file', () => {
  it('links the file, and opening it does not fold the card', async () => {
    const call = {
      id: '01J8QK3ZR2W7M5N4P6T8V9X0TC',
      name: 'write_file',
      status: 'succeeded' as const,
      preview: 'report.html',
      arguments: { path: 'report.html' },
      output: 'wrote 14 bytes',
      output_truncated: false,
      duration_ms: 12,
      subagent_id: null,
      started_at: '2026-09-25T10:00:00.000Z',
      finished_at: '2026-09-25T10:00:00.012Z',
    };
    renderPanel(
      [file({ name: 'report.html', preview: 'html', tool_call_ids: [call.id] })],
      { 'report.html': '<p>hi</p>' },
      'path:report.html',
      <ToolCalls calls={[call]} live />,
    );
    const link = await screen.findByTestId('tool-file-link');
    expect(link.textContent).toBe('report.html');
    const row = link.closest('details');
    expect(row?.open).toBe(false);
    fireEvent.click(link);
    expect(await screen.findByTestId('file-html-frame')).toBeInTheDocument();
    expect(row?.open).toBe(false);
  });
});
