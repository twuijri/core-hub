/**
 * A video or a sound on a message, played in place (DECISIONS §88). A media element sends no
 * header, so it cannot carry the bearer; instead the page asks the hub for a short-lived
 * address for this one attachment (`sessions.createAttachmentStream`) and the element plays
 * from it, asking for byte ranges as it goes — a long render starts at once instead of after
 * the whole file arrived. Until the address comes, or if it cannot, the file is its name.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/context.js';

/** Played in place: a video or a sound the browser knows by its type. */
export function isPlayable(mime: string | null | undefined): 'video' | 'audio' | null {
  if (!mime) return null;
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

export function InlineMedia({
  attachmentId,
  name,
  kind,
  fallback,
}: {
  attachmentId: string;
  name: string;
  kind: 'video' | 'audio';
  fallback: ReactNode;
}) {
  const { client, profile } = useAuth();
  const stream = useQuery({
    queryKey: ['attachment-stream', profile, attachmentId],
    queryFn: async () =>
      (
        await client.request('post', '/attachments/{attachment_id}/stream', {
          params: { attachment_id: attachmentId },
        })
      ).data,
    // A ticket lasts an hour; a fresh one well before that.
    staleTime: 45 * 60_000,
    gcTime: 50 * 60_000,
    retry: false,
  });
  if (!stream.data) return <>{fallback}</>;
  return kind === 'video' ? (
    <video
      className="msg-video"
      controls
      preload="metadata"
      src={stream.data.url}
      aria-label={name}
      data-testid="message-video"
    />
  ) : (
    <audio
      className="msg-audio"
      controls
      preload="metadata"
      src={stream.data.url}
      aria-label={name}
      data-testid="message-audio"
    />
  );
}
