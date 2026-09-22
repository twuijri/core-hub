/**
 * The declared limits of attachment storage, in one place.
 *
 * Every number here is the contract's, not an invention: `sessions.uploadAttachment`
 * says "≤ 25 MB", `UploadStart.size_bytes` caps at 52428800 and the `PayloadTooLarge`
 * response carries `details.max_bytes`. A limit that lives in two files drifts, so the
 * routes, the service and the tests all read these.
 */

/** One-shot `POST /attachments`. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Resumable `POST /attachment-uploads` (the contract's `UploadStart.size_bytes` maximum). */
export const MAX_RESUMABLE_BYTES = 50 * 1024 * 1024;

/** `Upload.chunk_bytes`: the largest body one `PUT /attachment-uploads/{id}` may carry. */
export const CHUNK_BYTES = 256 * 1024;

/** An open upload with no chunk for this long is forgotten (contract: "5 minutes of inactivity"). */
export const UPLOAD_IDLE_MS = 5 * 60_000;

/** The longest original filename kept (`attachments.filename` is text(255)). */
export const MAX_FILENAME_LENGTH = 255;

/**
 * The ceiling on one file an agent produced. How *many* such files a turn may hand
 * back is `sessions`' policy (`modules/sessions/run-files.ts`); this is the store's.
 */
export const MAX_PRODUCED_FILE_BYTES = MAX_UPLOAD_BYTES;
