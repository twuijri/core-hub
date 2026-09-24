// files upload · show · download · delete — the terminal half of the attachment store.
//
// `chat` and `sessions` hold ids; this is where bytes enter and leave the hub from a
// shell. Everything goes through the generated client (ADR 0003): the upload is a
// `FormData`, the chunks of a big file are `ArrayBuffer`s, and the download asks the
// client for bytes rather than text.
//
//   corehub files upload ./report.pdf              -> the attachment id, and its facts
//   corehub chat SESSION --message "…" --attach ./report.pdf
//   corehub files show ID
//   corehub files download ID --out ./here.pdf     (or `-` for stdout)
//   corehub files delete ID
import { createReadStream } from 'node:fs';
import { open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { basename } from 'node:path';
import type { CommandSpec } from '../args.js';
import type { AuthenticatedClient } from '../client.js';
import type { CommandContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { Attachment } from '../types.js';
import { formatTime, optionString, requireSession } from './shared.js';

/** The contract's one-shot ceiling; above it the resumable flow is used instead. */
export const MAX_ONE_SHOT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

interface OpenUpload {
  id: string;
  chunk_bytes: number;
  next_offset: number;
}

/**
 * Upload one local file and answer the stored attachment.
 *
 * Exported because `chat --attach` uses it: one implementation of "a path becomes an
 * attachment id", so the two commands cannot drift.
 */
export async function uploadFile(
  auth: AuthenticatedClient,
  filePath: string,
  purpose = 'message',
): Promise<Attachment> {
  const absolute = path.resolve(filePath);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile())
    throw new UsageError('usage.invalid_option', { option: 'FILE', value: filePath });
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new CliError('files.too_large', { max: String(MAX_ATTACHMENT_BYTES) });
  }
  return info.size > MAX_ONE_SHOT_BYTES
    ? resumable(auth, absolute, info.size, purpose)
    : oneShot(auth, absolute, purpose);
}

async function oneShot(
  auth: AuthenticatedClient,
  absolute: string,
  purpose: string,
): Promise<Attachment> {
  const form = new FormData();
  // A stream would be nicer; `FormData` needs a `Blob`, and a one-shot upload is
  // capped at 25 MB, so reading it is bounded and predictable.
  const handle = await open(absolute, 'r');
  try {
    const bytes = await handle.readFile();
    form.append('file', new Blob([Uint8Array.from(bytes)]), basename(absolute));
    form.append('purpose', purpose);
  } finally {
    await handle.close();
  }
  const { data } = await auth.client.raw('post', '/attachments', { body: form });
  return data as Attachment;
}

/** The chunked flow, so a big file survives a dropped connection. */
async function resumable(
  auth: AuthenticatedClient,
  absolute: string,
  sizeBytes: number,
  purpose: string,
): Promise<Attachment> {
  const started = await auth.client.request('post', '/attachment-uploads', {
    body: {
      name: basename(absolute),
      mime: 'application/octet-stream',
      size_bytes: sizeBytes,
      purpose: purpose as never,
    },
  });
  let upload = started.data as unknown as OpenUpload;
  const stream = createReadStream(absolute, { highWaterMark: upload.chunk_bytes });
  let offset = upload.next_offset;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const res = await auth.client.request('put', '/attachment-uploads/{upload_id}', {
      params: { upload_id: upload.id },
      query: { offset },
      headers: { 'Content-Type': 'application/octet-stream' },
      // A `Blob` copy of exactly this chunk: `chunk.buffer` is a pooled allocation
      // that Node reuses, so slicing it by hand is the classic corrupted-upload bug.
      body: new Blob([Uint8Array.from(chunk)]),
    });
    upload = res.data as unknown as OpenUpload;
    offset = upload.next_offset;
  }
  const done = await auth.client.request('post', '/attachment-uploads/{upload_id}/complete', {
    params: { upload_id: upload.id },
  });
  return done.data as Attachment;
}

/** The bytes of one attachment, as a `Buffer`. */
export async function downloadFile(
  auth: AuthenticatedClient,
  attachmentId: string,
): Promise<Buffer> {
  const res = await auth.client.request('get', '/attachments/{attachment_id}/content', {
    params: { attachment_id: attachmentId },
    responseKind: 'bytes',
  });
  return Buffer.from(res.data as unknown as ArrayBuffer);
}

function printAttachment(ctx: CommandContext, attachment: Attachment): void {
  const { t } = ctx;
  if (ctx.globals.json) {
    ctx.out.json(attachment);
    return;
  }
  ctx.out.kv([
    [t('files.id'), attachment.id],
    [t('files.name'), attachment.name],
    [t('files.kind'), `${attachment.kind} · ${attachment.mime}`],
    [t('files.size'), String(attachment.size_bytes)],
    [t('files.created'), formatTime(attachment.created_at)],
  ]);
}

export const filesUploadCommand: CommandSpec = {
  path: ['files', 'upload'],
  description: 'cmd.files_upload',
  positionals: [{ name: 'FILE', description: 'arg.file', required: true }],
  options: {
    purpose: { type: 'string', description: 'option.purpose', value: 'PURPOSE' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const file = ctx.positionals[0];
    if (!file) throw new UsageError('usage.missing_argument', { name: 'FILE' });
    const attachment = await uploadFile(
      requireSession(ctx),
      file,
      optionString(ctx, 'purpose') ?? 'message',
    );
    printAttachment(ctx, attachment);
    return 0;
  },
};

export const filesShowCommand: CommandSpec = {
  path: ['files', 'show'],
  description: 'cmd.files_show',
  positionals: [{ name: 'ATTACHMENT_ID', description: 'arg.attachment_id', required: true }],
  options: {},
  async run(ctx: CommandContext): Promise<number> {
    const id = ctx.positionals[0];
    if (!id) throw new UsageError('usage.missing_argument', { name: 'ATTACHMENT_ID' });
    const { data } = await requireSession(ctx).client.request(
      'get',
      '/attachments/{attachment_id}',
      {
        params: { attachment_id: id },
      },
    );
    printAttachment(ctx, data as Attachment);
    return 0;
  },
};

export const filesDownloadCommand: CommandSpec = {
  path: ['files', 'download'],
  description: 'cmd.files_download',
  positionals: [{ name: 'ATTACHMENT_ID', description: 'arg.attachment_id', required: true }],
  options: {
    out: { type: 'string', description: 'option.out', value: 'PATH' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const id = ctx.positionals[0];
    if (!id) throw new UsageError('usage.missing_argument', { name: 'ATTACHMENT_ID' });
    const auth = requireSession(ctx);
    const { data } = await auth.client.request('get', '/attachments/{attachment_id}', {
      params: { attachment_id: id },
    });
    const attachment = data as Attachment;
    const bytes = await downloadFile(auth, id);
    const target = optionString(ctx, 'out') ?? attachment.name;
    if (target === '-') {
      // `-` writes the bytes to stdout, so `corehub files download ID --out - | …` works.
      ctx.out.write(bytes.toString('binary'));
      return 0;
    }
    await writeFile(target, bytes);
    if (ctx.globals.json) ctx.out.json({ path: path.resolve(target), size_bytes: bytes.length });
    else ctx.out.line(ctx.t('files.saved', { path: path.resolve(target) }));
    return 0;
  },
};

export const filesDeleteCommand: CommandSpec = {
  path: ['files', 'delete'],
  description: 'cmd.files_delete',
  positionals: [{ name: 'ATTACHMENT_ID', description: 'arg.attachment_id', required: true }],
  options: {},
  async run(ctx: CommandContext): Promise<number> {
    const id = ctx.positionals[0];
    if (!id) throw new UsageError('usage.missing_argument', { name: 'ATTACHMENT_ID' });
    await requireSession(ctx).client.request('delete', '/attachments/{attachment_id}', {
      params: { attachment_id: id },
    });
    if (ctx.globals.json) ctx.out.json({ id, deleted: true });
    else ctx.out.line(ctx.t('files.deleted', { id }));
    return 0;
  },
};
