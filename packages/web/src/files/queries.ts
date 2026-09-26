/**
 * A conversation's files from the hub (contract `sessions.listFiles`, `sessions.readFile`,
 * decision §48): the list, one file's bytes, saving one.
 *
 * Bytes are fetched with the bearer header and handed to the page as a `Blob` — never as a
 * URL with the token in it (the contract forbids that), which is also why a plain link
 * cannot open a private file.
 */
import { HubApiError } from '@corehub/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useAuth } from '../auth/context.js';
import type {
  RunChanges,
  RunChangesList,
  RunFileDiff,
  SessionFile,
  SessionFileList,
} from '../types.js';

export const fileKeys = {
  list: (profile: string, sessionId: string) => ['session-files', profile, sessionId] as const,
  bytes: (profile: string, sessionId: string, file: SessionFile) =>
    [
      'session-file',
      profile,
      sessionId,
      file.key,
      file.modified_at ?? '',
      file.size_bytes,
    ] as const,
};

/**
 * The list. `revision` changes whenever a tool call or a run of the conversation ends, and
 * the list is read again then — which is how an open file notices the agent changed it.
 */
export function useSessionFiles(sessionId: string, revision: string) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: [...fileKeys.list(profile, sessionId), revision],
    queryFn: async () => {
      const res = await client.request('get', '/sessions/{session_id}/files', {
        params: { session_id: sessionId },
      });
      return res.data as SessionFileList;
    },
    placeholderData: keepPreviousData,
  });
}

/** Kinds whose preview reads the bytes as text. */
const TEXTUAL = new Set(['html', 'markdown', 'code', 'text', 'csv']);

export interface FileBytes {
  blob: Blob;
  /** The bytes as UTF-8 text, for the kinds shown as text. */
  text: string | null;
}

/** The bytes one tab shows. A new `modified_at` or size is a new read. */
export function useFileBytes(sessionId: string, file: SessionFile, enabled: boolean) {
  const { profile } = useAuth();
  const read = useReadFile(sessionId);
  return useQuery({
    queryKey: fileKeys.bytes(profile, sessionId, file),
    queryFn: async ({ signal }): Promise<FileBytes> => {
      const blob = await read(file, false, signal);
      return { blob, text: TEXTUAL.has(file.preview) ? await blob.text() : null };
    },
    enabled,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
}

/** One file's bytes: a path through `sessions.readFile`, an attachment through its own. */
export function useReadFile(sessionId: string) {
  const { client } = useAuth();
  return useCallback(
    async (file: SessionFile, download: boolean, signal?: AbortSignal): Promise<Blob> => {
      const res =
        file.attachment_id !== null
          ? await client.request('get', '/attachments/{attachment_id}/content', {
              params: { attachment_id: file.attachment_id },
              responseKind: 'bytes',
              ...(signal ? { signal } : {}),
            })
          : await client.request('get', '/sessions/{session_id}/files/content', {
              params: { session_id: sessionId },
              query: { path: file.path ?? '', download },
              responseKind: 'bytes',
              ...(signal ? { signal } : {}),
            });
      // The type comes from the list, which the hub chose from the name: never sniffed.
      return new Blob([res.data as unknown as ArrayBuffer], { type: file.mime });
    },
    [client],
  );
}

/** Save a file the way a download does, with its own name. */
export function useSaveFile(sessionId: string) {
  const read = useReadFile(sessionId);
  return useCallback(
    async (file: SessionFile) => {
      const blob = await read(file, true);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    },
    [read],
  );
}

/**
 * The runs of the conversation that changed a file, with their files and counts (decision
 * §49). Read again when a run ends (`revision`, `changesRevisionOf`): the hub records a run's
 * changes before it says the run ended. The newest 200 runs that changed something are read.
 */
export function useSessionChanges(sessionId: string, revision: string) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: ['session-changes', profile, sessionId, revision],
    queryFn: async () => {
      const res = await client.request('get', '/sessions/{session_id}/changes', {
        params: { session_id: sessionId },
        query: { limit: 200 },
      });
      return res.data as RunChangesList;
    },
    placeholderData: keepPreviousData,
  });
}

/** How often a live run's folder is looked at again while the card is on screen (§102). */
export const LIVE_CHANGES_POLL_MS = 4_000;

/**
 * What a run still going has changed so far (decision §102): `live: true` from the hub, read
 * again every few seconds and whenever one of its tool calls ends (`revision`). `null` when it
 * has nothing to compare (no folder) or has just ended — its recorded card takes over then.
 */
export function useLiveRunChanges(sessionId: string, runId: string, revision: number) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: ['live-run-changes', profile, sessionId, runId, revision],
    queryFn: async ({ signal }) => {
      try {
        const res = await client.request('get', '/sessions/{session_id}/runs/{run_id}/changes', {
          params: { session_id: sessionId, run_id: runId },
          signal,
        });
        return res.data as RunChanges;
      } catch (error) {
        if (error instanceof HubApiError && error.status === 404) return null;
        throw error;
      }
    },
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_CHANGES_POLL_MS,
    retry: false,
  });
}

/** One changed file's diff, as the hub recorded it when the run ended: it never changes. */
export function useRunDiff(sessionId: string, runId: string, path: string) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: ['run-diff', profile, sessionId, runId, path],
    queryFn: async ({ signal }) => {
      const res = await client.request('get', '/sessions/{session_id}/runs/{run_id}/changes/diff', {
        params: { session_id: sessionId, run_id: runId },
        query: { path },
        signal,
      });
      return res.data as RunFileDiff;
    },
    staleTime: Infinity,
    retry: false,
  });
}
