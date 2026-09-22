/**
 * The attachment data layer: the blocks a run is sent, the blocks a message renders, and
 * the one-shot upload with its progress, its cancel and its refusals.
 *
 * `XMLHttpRequest` is stubbed rather than mocked away: the test drives the same events a
 * browser fires (`upload.progress`, `load`, `abort`, `error`), so the hook's contract —
 * progress ratios, an `AbortError` on cancel, a `HubApiError` carrying the hub's envelope
 * — is exercised exactly as the composer will meet it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubApiError } from '@majlis/contracts';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { I18nProvider } from '../src/i18n/context.js';
import {
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
  attachmentsOf,
  blocksFor,
  useUploadAttachment,
} from '../src/attachments/queries.js';
import type { Attachment, ContentBlock } from '../src/types.js';

const ID = '01J8QK3ZR2W7M5N4P6T8V9X0AT';
const PRODUCED_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AW';
/** The contract's own URL shape; written from a variable so the path stays a template. */
const contentUrl = (id: string) => `/api/v1/attachments/${id}/content`;

const attachment = (over: Partial<Attachment> = {}): Attachment =>
  ({
    id: ID,
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-22T10:00:00Z',
    updated_at: '2026-09-22T10:00:00Z',
    name: 'shot.png',
    mime: 'image/png',
    size_bytes: 12,
    kind: 'image',
    url: contentUrl(ID),
    purpose: 'message',
    width: null,
    height: null,
    duration_ms: null,
    sha256: 'a'.repeat(64),
    ...over,
  }) as Attachment;

describe('the blocks a run carries', () => {
  it('puts the text first and one block per file, by kind', () => {
    const blocks = blocksFor('  اقرأ هذا  ', [
      attachment(),
      attachment({ id: '01J8QK3ZR2W7M5N4P6T8V9X0AU', kind: 'audio', name: 'note.m4a' }),
      attachment({ id: '01J8QK3ZR2W7M5N4P6T8V9X0AV', kind: 'file', name: 'a.pdf' }),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'audio', 'file']);
    expect(blocks[0]).toEqual({ type: 'text', text: 'اقرأ هذا' });
    expect(blocks[1]).toMatchObject({ attachment_id: ID, name: 'shot.png' });
  });

  it('sends no empty text block for a message that is only files', () => {
    expect(blocksFor('   ', [attachment()]).map((b) => b.type)).toEqual(['image']);
  });

  it('reads the attachments back off a message, with what the server filled in', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'تفضل.' },
      {
        type: 'file',
        attachment_id: PRODUCED_ID,
        name: 'summary.md',
        mime: 'text/markdown; charset=utf-8',
        size_bytes: 9,
        url: contentUrl(PRODUCED_ID),
      },
    ];
    expect(attachmentsOf(content)).toEqual([
      {
        attachment_id: PRODUCED_ID,
        name: 'summary.md',
        mime: 'text/markdown; charset=utf-8',
        size_bytes: 9,
        url: contentUrl(PRODUCED_ID),
      },
    ]);
  });
});

// ------------------------------------------------------------- the upload

interface FakeXhr {
  status: number;
  responseText: string;
  headers: Record<string, string>;
  fire(event: string): void;
  progress(loaded: number, total: number): void;
}

let latest: FakeXhr | undefined;

function stubXhr(): void {
  class Stub {
    status = 0;
    responseText = '';
    responseType = '';
    readonly headers: Record<string, string> = {};
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly upload = {
      listeners: new Map<string, Array<(event: unknown) => void>>(),
      addEventListener(name: string, fn: (event: unknown) => void) {
        const list = this.listeners.get(name) ?? [];
        list.push(fn);
        this.listeners.set(name, list);
      },
    };
    open(): void {}
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    addEventListener(name: string, fn: (event: unknown) => void): void {
      const list = this.listeners.get(name) ?? [];
      list.push(fn);
      this.listeners.set(name, list);
    }
    send(): void {
      latest = {
        status: 0,
        responseText: '',
        headers: this.headers,
        fire: (event: string) => {
          this.status = latest!.status;
          this.responseText = latest!.responseText;
          for (const fn of this.listeners.get(event) ?? []) fn({});
        },
        progress: (loaded: number, total: number) => {
          for (const fn of this.upload.listeners.get('progress') ?? [])
            fn({ lengthComputable: true, loaded, total });
        },
      };
    }
    abort(): void {
      for (const fn of this.listeners.get('abort') ?? []) fn({});
    }
  }
  vi.stubGlobal('XMLHttpRequest', Stub as unknown as typeof XMLHttpRequest);
}

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

function harness() {
  const storage = memoryStorage();
  const store = new SessionStore(storage);
  store.save({
    profile: 'default',
    token: 'test-token',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'owner', display_name: 'Owner', role: 'owner' },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useUploadAttachment(), {
    wrapper: ({ children }) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider language="en">
            <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={vi.fn()}>
              {children}
            </AuthProvider>
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });
}

describe('uploading one file', () => {
  beforeEach(() => {
    latest = undefined;
    stubXhr();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports progress and resolves with the stored attachment', async () => {
    const { result } = harness();
    const seen: number[] = [];
    const promise = result.current.upload({
      file: new File(['0123456789'], 'shot.png', { type: 'image/png' }),
      onProgress: ({ ratio }) => seen.push(ratio),
    });
    await waitFor(() => expect(latest).toBeDefined());
    // The same headers the generated client sends, so nothing about auth is special.
    expect(latest!.headers.Authorization).toBe('Bearer test-token');
    expect(latest!.headers['X-Hub-Profile']).toBe('default');

    latest!.progress(5, 10);
    latest!.progress(10, 10);
    latest!.status = 201;
    latest!.responseText = JSON.stringify(attachment());
    latest!.fire('load');

    await expect(promise).resolves.toMatchObject({ name: 'shot.png' });
    expect(seen).toEqual([0.5, 1]);
  });

  it('raises the hub envelope as a `HubApiError`', async () => {
    const { result } = harness();
    const promise = result.current.upload({
      file: new File(['x'], 'big.bin'),
    });
    await waitFor(() => expect(latest).toBeDefined());
    latest!.status = 413;
    latest!.responseText = JSON.stringify({
      error: 'حجم الملف يتجاوز الحد المسموح',
      code: 'payload_too_large',
      details: { max_bytes: 26214400 },
    });
    latest!.fire('load');
    await expect(promise).rejects.toBeInstanceOf(HubApiError);
    await promise.catch((error: HubApiError) => {
      expect(error.status).toBe(413);
      expect(error.code).toBe('payload_too_large');
    });
  });

  it('cancels', async () => {
    const { result } = harness();
    const controller = new AbortController();
    const promise = result.current.upload({
      file: new File(['x'], 'shot.png'),
      signal: controller.signal,
    });
    await waitFor(() => expect(latest).toBeDefined());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a file larger than the hub will ever take, before sending a byte', async () => {
    const { result } = harness();
    const huge = new File(['x'], 'huge.bin');
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    await expect(result.current.upload({ file: huge })).rejects.toBeInstanceOf(
      AttachmentTooLargeError,
    );
    expect(latest).toBeUndefined();
  });
});
