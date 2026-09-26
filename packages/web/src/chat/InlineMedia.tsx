/**
 * A video or a sound, played in place (DECISIONS §90, §98). A media element sends no header, so it
 * cannot carry the bearer; instead the page asks the hub for a short-lived address for this one
 * file — an attachment (`sessions.createAttachmentStream`) or a file of the conversation's working
 * folder (`sessions.createFileStream`) — and the element plays from it, asking for byte ranges as it
 * goes: a long render starts at once and seeks, instead of waiting for the whole file to arrive.
 *
 * Whether the browser can play the format is its own call: the player is offered for any `video/*`
 * or `audio/*` file (or a name that says one), and when the element says it cannot play the
 * source, the file is its name again (`fallback`). Until the address comes, likewise.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../auth/context.js';

export type MediaKind = 'video' | 'audio';

/** What a name says, when the stored type says nothing (`application/octet-stream`). */
const BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
};

/** The media type of a file: the stored one when it says video or audio, else the name's. */
export function mediaTypeOf(mime: string | null | undefined, name?: string | null): string | null {
  if (mime && (mime.startsWith('video/') || mime.startsWith('audio/'))) return mime;
  const base = (name ?? '').toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? (BY_EXTENSION[base.slice(dot + 1)] ?? null) : null;
}

/** Played in place: a video or a sound, by its type or, failing that, its name. */
export function isPlayable(
  mime: string | null | undefined,
  name?: string | null,
): MediaKind | null {
  const type = mediaTypeOf(mime, name);
  if (!type) return null;
  return type.startsWith('video/') ? 'video' : 'audio';
}

export type MediaSource =
  { kind: 'attachment'; attachmentId: string } | { kind: 'path'; sessionId: string; path: string };

/** The one-hour address a media element plays `source` from; no data until it comes. */
export function useMediaStream(source: MediaSource, enabled = true) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey:
      source.kind === 'attachment'
        ? ['attachment-stream', profile, source.attachmentId]
        : ['file-stream', profile, source.sessionId, source.path],
    queryFn: async () =>
      source.kind === 'attachment'
        ? (
            await client.request('post', '/attachments/{attachment_id}/stream', {
              params: { attachment_id: source.attachmentId },
            })
          ).data
        : (
            await client.request('post', '/sessions/{session_id}/files/stream', {
              params: { session_id: source.sessionId },
              body: { path: source.path },
            })
          ).data,
    enabled,
    // A ticket lasts an hour; a fresh one well before that.
    staleTime: 45 * 60_000,
    gcTime: 50 * 60_000,
    retry: false,
  });
}

/** The player itself, once there is an address. Falls back when the browser cannot play it. */
export function MediaPlayer({
  url,
  name,
  kind,
  className,
  testId,
  fallback,
}: {
  url: string;
  name: string;
  kind: MediaKind;
  className: string;
  testId: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  const common = {
    className,
    controls: true,
    preload: 'metadata' as const,
    src: url,
    'aria-label': name,
    'data-testid': testId,
    onError: () => setFailed(true),
  };
  return kind === 'video' ? <video {...common} playsInline /> : <audio {...common} />;
}

export function InlineMedia({
  attachmentId,
  source,
  name,
  kind,
  fallback,
}: {
  /** An attachment of the message; or say `source`. */
  attachmentId?: string;
  source?: MediaSource;
  name: string;
  kind: MediaKind;
  fallback: ReactNode;
}) {
  const from: MediaSource = source ?? { kind: 'attachment', attachmentId: attachmentId ?? '' };
  const stream = useMediaStream(from);
  if (!stream.data) return <>{fallback}</>;
  return (
    <MediaPlayer
      url={stream.data.url}
      name={name}
      kind={kind}
      className={kind === 'video' ? 'msg-video' : 'msg-audio'}
      testId={kind === 'video' ? 'message-video' : 'message-audio'}
      fallback={fallback}
    />
  );
}
