/**
 * Attachments: the data layer the composer and the message view call.
 *
 * **This file draws nothing.** The chat surface is being rebuilt on a parallel branch
 * (`feat/chat-design-pass`); everything here is the plumbing under it, so the two can
 * land without touching each other's files.
 *
 * What a composer needs, and what to call:
 *
 * | the composer wants | call |
 * |---|---|
 * | a file the person dropped, with a progress bar and a cancel button | `useUploadAttachment()` -> `upload({ file, onProgress, signal })` |
 * | a file bigger than 25 MB, or a flaky connection | the same hook: it switches to the resumable flow on its own above `MAX_ONE_SHOT_BYTES`, and `resume()` continues after a drop |
 * | to remove one before sending | `useDeleteAttachment()` -> `remove(id)` |
 * | the content blocks for `sessions.createRun` | `blocksFor(text, uploaded)` |
 * | a file the agent produced, on a message | the `content` blocks already carry `attachment_id`, `name`, `mime`, `size_bytes` and `url` |
 * | to let the person save one | `useDownloadAttachment()` -> `save(block)` |
 * | metadata for an id it only has the id of | `useAttachment(id)` |
 *
 * Two things are deliberately not here. There is **no list-attachments query**: the
 * contract declares no such operation, and a message's own blocks already carry every
 * file it has, so a list would be a second source of truth. And a dictation is **not an
 * attachment**: the composer's mic sends its take to `models.transcribe` (`voice/`), which
 * keeps nothing (DECISIONS §55).
 *
 * Upload progress needs `XMLHttpRequest` — `fetch` cannot report how much of a body it
 * has sent — so the one-shot upload does not go through the generated client. It sends
 * the same headers the client does, and it refreshes once on a `401` the way the client
 * would, so nothing about auth is special-cased here.
 */
import { HubApiError } from '@corehub/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useAuth } from '../auth/context.js';
import type { Attachment, ContentBlock } from '../types.js';

/** The contract's `Upload.chunk_bytes`; the hub's answer always wins over it. */
const DEFAULT_CHUNK_BYTES = 256 * 1024;

/** Above this the hub refuses a one-shot upload (`sessions.uploadAttachment`). */
export const MAX_ONE_SHOT_BYTES = 25 * 1024 * 1024;
/** Above this the hub refuses the resumable flow too (`UploadStart.size_bytes`). */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const attachmentKeys = {
  one: (profile: string, id: string) => ['attachment', profile, id] as const,
};

/** One file's progress, as the composer renders it. */
export interface UploadProgress {
  /** Bytes the browser has handed to the socket. */
  loaded: number;
  total: number;
  /** 0…1; `total` is always known here because a `File` knows its size. */
  ratio: number;
}

export interface UploadRequest {
  file: File;
  /** The contract's `AttachmentPurpose`; `message` when omitted. */
  purpose?: string;
  onProgress?(progress: UploadProgress): void;
  /** Abort the upload; the promise rejects with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Resume a resumable upload that dropped: the `id` a previous attempt reported
   * through `onResumable`. Ignored for one-shot uploads.
   */
  resumeId?: string;
  /** Where the caller thinks the hub stopped; a wrong guess is corrected by the hub. */
  resumeOffset?: number;
  /** Called as soon as a resumable upload has an id worth remembering. */
  onResumable?(uploadId: string): void;
}

/** The contract's `Upload`. */
interface OpenUpload {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  chunk_bytes: number;
  next_offset: number;
  expires_at: string;
}

/** A `File` that is too big to send is refused here, before a byte leaves the browser. */
export class AttachmentTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`the file is larger than ${maxBytes} bytes`);
    this.name = 'AttachmentTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Upload one file.
 *
 * Under `MAX_ONE_SHOT_BYTES` it is one multipart request with progress; above it the
 * hook uses the resumable flow (`startUpload` / `uploadChunk` / `completeUpload`), which
 * reports progress per chunk and can be resumed with `resumeId` after a drop.
 */
export function useUploadAttachment(): {
  upload(request: UploadRequest): Promise<Attachment>;
} {
  const { baseUrl, profile, client } = useAuth();
  const auth = useAuth();
  const queryClient = useQueryClient();

  const bearer = useCallback(() => auth.session?.token, [auth]);

  const oneShot = useCallback(
    async (request: UploadRequest): Promise<Attachment> => {
      const send = (token: string | undefined) =>
        xhrUpload({
          url: `${baseUrl}/api/v1/attachments`,
          file: request.file,
          purpose: request.purpose ?? 'message',
          profile,
          token,
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      try {
        return await send(bearer());
      } catch (error) {
        if (!(error instanceof HubApiError) || error.status !== 401) throw error;
        // Same rule as the generated client: one refresh, then one retry.
        await client.request('get', '/auth/me');
        return send(bearer());
      }
    },
    [baseUrl, profile, bearer, client],
  );

  const resumable = useCallback(
    async (request: UploadRequest): Promise<Attachment> => {
      const { file } = request;
      let uploadId: string;
      let offset: number;
      let chunkBytes = DEFAULT_CHUNK_BYTES;

      if (request.resumeId) {
        // Resuming: the hub decides where it stopped. The first chunk at a guessed
        // offset comes back as `409` carrying `expected_offset`, which is adopted
        // below — no extra operation, and no chance of a corrupted file.
        uploadId = request.resumeId;
        offset = request.resumeOffset ?? 0;
      } else {
        const started = await client.request('post', '/attachment-uploads', {
          body: {
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size_bytes: file.size,
            ...(request.purpose ? { purpose: request.purpose as never } : {}),
          },
        });
        const open = started.data as unknown as OpenUpload;
        uploadId = open.id;
        offset = open.next_offset;
        chunkBytes = open.chunk_bytes;
        request.onResumable?.(uploadId);
      }

      while (offset < file.size) {
        request.signal?.throwIfAborted();
        const end = Math.min(offset + chunkBytes, file.size);
        const chunk = await file.slice(offset, end).arrayBuffer();
        try {
          const res = await client.request('put', '/attachment-uploads/{upload_id}', {
            params: { upload_id: uploadId },
            query: { offset },
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk,
            ...(request.signal ? { signal: request.signal } : {}),
          });
          const open = res.data as unknown as OpenUpload;
          offset = open.next_offset;
          chunkBytes = open.chunk_bytes;
        } catch (error) {
          const expected = expectedOffsetOf(error);
          if (expected === null || expected === offset) throw error;
          offset = expected;
          continue;
        }
        request.onProgress?.({
          loaded: offset,
          total: file.size,
          ratio: file.size === 0 ? 1 : offset / file.size,
        });
      }

      const done = await client.request('post', '/attachment-uploads/{upload_id}/complete', {
        params: { upload_id: uploadId },
      });
      return done.data as Attachment;
    },
    [client],
  );

  const upload = useCallback(
    async (request: UploadRequest): Promise<Attachment> => {
      if (request.file.size > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentTooLargeError(MAX_ATTACHMENT_BYTES);
      }
      const attachment =
        request.file.size > MAX_ONE_SHOT_BYTES || request.resumeId
          ? await resumable(request)
          : await oneShot(request);
      queryClient.setQueryData(attachmentKeys.one(profile, attachment.id), attachment);
      return attachment;
    },
    [oneShot, resumable, queryClient, profile],
  );

  return useMemo(() => ({ upload }), [upload]);
}

/** Metadata for one attachment (`sessions.getAttachment`). */
export function useAttachment(id: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: attachmentKeys.one(profile, id ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/attachments/{attachment_id}', {
          params: { attachment_id: id as string },
        })
      ).data,
    enabled: !!session && !!id,
    staleTime: 5 * 60_000,
  });
}

/**
 * Remove an attachment nobody has sent yet (`sessions.deleteAttachment`).
 * The hub answers `409 conflict` once a message points at it; that is not an error to
 * hide — the composer should say the file is already part of the conversation.
 */
export function useDeleteAttachment() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/attachments/{attachment_id}', {
        params: { attachment_id: id },
      });
      return id;
    },
    onSuccess: (id) => queryClient.removeQueries({ queryKey: attachmentKeys.one(profile, id) }),
  });
}

/** An attachment as a message block carries it (`AttachmentBlockFields`). */
export interface AttachmentRef {
  attachment_id: string;
  name?: string;
  mime?: string;
  size_bytes?: number;
  url?: string;
}

/**
 * Fetch the bytes.
 *
 * The bearer token goes in the header, never in the URL (the contract says so), which
 * is why a plain `<a href>` cannot download a private attachment: the blob is fetched
 * first and handed to the browser as an object URL.
 */
export function useDownloadAttachment(): {
  blob(ref: AttachmentRef, signal?: AbortSignal): Promise<Blob>;
  save(ref: AttachmentRef): Promise<void>;
} {
  const { client } = useAuth();

  const blob = useCallback(
    async (ref: AttachmentRef, signal?: AbortSignal): Promise<Blob> => {
      const res = await client.request('get', '/attachments/{attachment_id}/content', {
        params: { attachment_id: ref.attachment_id },
        responseKind: 'bytes',
        ...(signal ? { signal } : {}),
      });
      return new Blob([res.data as unknown as ArrayBuffer], {
        type: res.headers.get('content-type') ?? ref.mime ?? 'application/octet-stream',
      });
    },
    [client],
  );

  const save = useCallback(
    async (ref: AttachmentRef): Promise<void> => {
      const file = await blob(ref);
      const href = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = ref.name ?? ref.attachment_id;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    },
    [blob],
  );

  return useMemo(() => ({ blob, save }), [blob, save]);
}

/** The `content` array `sessions.createRun` takes, from the text and what was uploaded. */
export function blocksFor(text: string, uploaded: readonly Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: 'text', text: trimmed });
  for (const attachment of uploaded) {
    const fields = {
      attachment_id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size_bytes: attachment.size_bytes,
    };
    if (attachment.kind === 'image') blocks.push({ type: 'image', ...fields });
    else if (attachment.kind === 'audio') blocks.push({ type: 'audio', ...fields });
    else blocks.push({ type: 'file', ...fields });
  }
  return blocks;
}

/** The attachment blocks of one message, in order — what a message view renders. */
export function attachmentsOf(content: readonly ContentBlock[]): AttachmentRef[] {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { attachment_id: string }> =>
        'attachment_id' in block && typeof block.attachment_id === 'string',
    )
    .map((block) => ({
      attachment_id: block.attachment_id,
      ...('name' in block && block.name ? { name: block.name } : {}),
      ...('mime' in block && block.mime ? { mime: block.mime } : {}),
      ...('size_bytes' in block && typeof block.size_bytes === 'number'
        ? { size_bytes: block.size_bytes }
        : {}),
      ...('url' in block && block.url ? { url: block.url } : {}),
    }));
}

/** `409 conflict` from `uploadChunk` says where the hub actually stopped. */
function expectedOffsetOf(error: unknown): number | null {
  if (!(error instanceof HubApiError) || error.status !== 409) return null;
  const details = (error.body as { details?: { expected_offset?: unknown } } | null)?.details;
  return typeof details?.expected_offset === 'number' ? details.expected_offset : null;
}

// ----------------------------------------------------------------- internals

interface XhrUploadOptions {
  url: string;
  file: File;
  purpose: string;
  profile: string;
  token: string | undefined;
  onProgress?(progress: UploadProgress): void;
  signal?: AbortSignal;
}

/**
 * One multipart `POST`, with progress and cancel.
 *
 * `fetch` has no upload-progress event, so this is the one place the web client does
 * not go through the generated client. Failures are raised as `HubApiError`, the same
 * type every other call throws, so `describeError` keeps working unchanged.
 */
function xhrUpload(options: XhrUploadOptions): Promise<Attachment> {
  return new Promise<Attachment>((resolve, reject) => {
    const form = new FormData();
    form.append('file', options.file, options.file.name);
    form.append('purpose', options.purpose);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', options.url, true);
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Hub-Profile', options.profile);
    if (options.token) xhr.setRequestHeader('Authorization', `Bearer ${options.token}`);

    const abort = () => xhr.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const finish = () => options.signal?.removeEventListener('abort', abort);

    xhr.upload.addEventListener('progress', (event) => {
      const total = event.lengthComputable ? event.total : options.file.size;
      options.onProgress?.({
        loaded: event.loaded,
        total,
        ratio: total === 0 ? 1 : event.loaded / total,
      });
    });
    xhr.addEventListener('abort', () => {
      finish();
      reject(new DOMException('the upload was cancelled', 'AbortError'));
    });
    xhr.addEventListener('error', () => {
      finish();
      reject(new HubApiError(0, 'network_error', 'the upload could not reach the hub', null));
    });
    xhr.addEventListener('load', () => {
      finish();
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as Attachment);
        return;
      }
      const envelope = (body ?? {}) as { error?: unknown; code?: unknown };
      reject(
        new HubApiError(
          xhr.status,
          typeof envelope.code === 'string' ? envelope.code : 'http_error',
          typeof envelope.error === 'string' ? envelope.error : `HTTP ${xhr.status}`,
          body,
        ),
      );
    });
    xhr.send(form);
  });
}
