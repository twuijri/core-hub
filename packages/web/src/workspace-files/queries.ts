/**
 * The Files page's data layer: the profile's working files over the generated client
 * (`knowledge.*WorkspaceFile*`, contract decision §65). Every key carries the profile, so
 * switching the chip at the top shows that profile's folder (NAVIGATION rule 4).
 *
 * The bearer token goes in the header, never in a URL, so downloads and previews fetch the
 * bytes and hand the browser an object URL — the same rule `attachments/queries.ts` follows.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useAuth } from '../auth/context.js';
import type { Attachment, Schemas } from '../types.js';

export type WorkspaceFileEntry = Schemas['WorkspaceFileEntry'];
export type WorkspaceFolder = Schemas['WorkspaceFolder'];
export type WorkspaceText = Schemas['WorkspaceText'];

export const workspaceFileKeys = {
  all: (profile: string) => ['workspace-files', profile] as const,
  folder: (profile: string, path: string) => ['workspace-files', profile, 'folder', path] as const,
  text: (profile: string, path: string) => ['workspace-files', profile, 'text', path] as const,
};

/** One folder of the profile's working files. */
export function useWorkspaceFolder(path: string) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: workspaceFileKeys.folder(profile, path),
    queryFn: async () =>
      (await client.request('get', '/workspace-files', { query: { path } }))
        .data as WorkspaceFolder,
    enabled: !!session,
    retry: false,
  });
}

/** A text file to show or edit; fetched fresh each time it opens (an agent may have written it). */
export function useWorkspaceText(path: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: workspaceFileKeys.text(profile, path ?? ''),
    queryFn: async () =>
      (await client.request('get', '/workspace-files/text', { query: { path: path as string } }))
        .data as WorkspaceText,
    enabled: !!session && !!path,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

/** Every write the page makes; each one refreshes the folders it touched. */
export function useWorkspaceFileActions() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  // Folders only: an open editor keeps the text it has, and learns of a change on disk from
  // the save's own conflict check rather than from a refetch under the person's cursor.
  const refresh = useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: [...workspaceFileKeys.all(profile), 'folder'] }),
    [queryClient, profile],
  );

  const mkdir = useMutation({
    mutationFn: async (path: string) =>
      (await client.request('post', '/workspace-files/folders', { body: { path } }))
        .data as WorkspaceFileEntry,
    onSuccess: refresh,
  });
  const move = useMutation({
    mutationFn: async (input: { from: string; to: string }) =>
      (await client.request('post', '/workspace-files/move', { body: input }))
        .data as WorkspaceFileEntry,
    onSuccess: refresh,
  });
  const copy = useMutation({
    mutationFn: async (input: { from: string; to: string }) =>
      (await client.request('post', '/workspace-files/copy', { body: input }))
        .data as WorkspaceFileEntry,
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (path: string) => {
      await client.request('delete', '/workspace-files', { query: { path } });
      return path;
    },
    onSuccess: refresh,
  });
  const save = useMutation({
    mutationFn: async (input: { path: string; content: string; etag: string | null }) =>
      (await client.request('put', '/workspace-files/text', { body: input })).data as WorkspaceText,
    onSuccess: refresh,
  });
  const upload = useMutation({
    mutationFn: async (input: { folder: string; file: File; overwrite?: boolean }) => {
      const form = new FormData();
      form.append('file', input.file, input.file.name);
      return (
        await client.request('post', '/workspace-files/upload', {
          query: { path: input.folder, ...(input.overwrite ? { overwrite: true } : {}) },
          body: form as never,
        })
      ).data as WorkspaceFileEntry;
    },
    onSuccess: refresh,
  });
  const attach = useMutation({
    mutationFn: async (path: string) =>
      (await client.request('post', '/workspace-files/attach', { body: { path } }))
        .data as Attachment,
  });

  return useMemo(
    () => ({ mkdir, move, copy, remove, save, upload, attach, refresh }),
    [mkdir, move, copy, remove, save, upload, attach, refresh],
  );
}

/** Bytes of a file, or of a folder as a zip, for a preview or a save. */
export function useWorkspaceBytes() {
  const { client } = useAuth();

  const fileBlob = useCallback(
    async (entry: { path: string; mime?: string | null }, inline = false): Promise<Blob> => {
      const res = await client.request('get', '/workspace-files/content', {
        query: { path: entry.path, ...(inline ? { disposition: 'inline' as const } : {}) },
        responseKind: 'bytes',
      });
      return new Blob([res.data as unknown as ArrayBuffer], {
        type: res.headers.get('content-type') ?? entry.mime ?? 'application/octet-stream',
      });
    },
    [client],
  );

  const zipBlob = useCallback(
    async (path: string): Promise<Blob> => {
      const res = await client.request('get', '/workspace-files/archive', {
        query: { path },
        responseKind: 'bytes',
      });
      return new Blob([res.data as unknown as ArrayBuffer], { type: 'application/zip' });
    },
    [client],
  );

  return useMemo(() => ({ fileBlob, zipBlob }), [fileBlob, zipBlob]);
}

/** Hand a blob to the browser as a download named `name`. */
export function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next turn: some browsers start the download after `click()` returns.
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
