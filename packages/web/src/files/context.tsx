/**
 * The files of the open conversation, and which of them are open beside it.
 *
 * The provider wraps the chat's whole frame (`AppShell`), because the preview is drawn in
 * the frame's split pane, not inside the chat column: a tool card, a word in a reply, an
 * attachment and the Files list all open a file through `useOpenFile`, and the panel in the
 * pane reads the same tabs.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';
import { usePaneOptional } from '../shell/pane.js';
import type { SessionFile } from '../types.js';
import { FilePreviewPanel } from './FilePreviewPanel.js';
import { useSessionFiles } from './queries.js';

export interface SessionFilesValue {
  sessionId: string;
  files: SessionFile[];
  truncated: boolean;
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  /** Open tabs, by `SessionFile.key`, in the order they were opened. */
  tabs: string[];
  active: string | null;
  openTab(key: string): void;
  closeTab(key: string): void;
  activate(key: string): void;
  fileOf(key: string): SessionFile | undefined;
}

const FilesContext = createContext<SessionFilesValue | null>(null);

export function SessionFilesProvider({
  sessionId,
  revision,
  children,
}: {
  sessionId: string;
  revision: string;
  children: ReactNode;
}) {
  const query = useSessionFiles(sessionId, revision);
  const [open, setOpen] = useState<{ tabs: string[]; active: string | null }>({
    tabs: [],
    active: null,
  });
  const { tabs, active } = open;
  const files = useMemo(() => query.data?.items ?? [], [query.data]);
  const byKey = useMemo(() => new Map(files.map((file) => [file.key, file])), [files]);

  const openTab = useCallback((key: string) => {
    setOpen((current) => ({
      tabs: current.tabs.includes(key) ? current.tabs : [...current.tabs, key],
      active: key,
    }));
  }, []);
  const closeTab = useCallback((key: string) => {
    setOpen((current) => {
      const at = current.tabs.indexOf(key);
      const next = current.tabs.filter((k) => k !== key);
      return {
        tabs: next,
        // The neighbour takes over, as closing a tab does in a browser.
        active:
          current.active === key ? (next[Math.min(at, next.length - 1)] ?? null) : current.active,
      };
    });
  }, []);
  const activate = useCallback(
    (key: string) => setOpen((current) => ({ ...current, active: key })),
    [],
  );

  const value = useMemo<SessionFilesValue>(
    () => ({
      sessionId,
      files,
      truncated: query.data?.truncated ?? false,
      status: query.isError ? 'error' : query.data ? 'ready' : 'loading',
      error: query.error,
      tabs,
      active,
      openTab,
      closeTab,
      activate,
      fileOf: (key) => byKey.get(key),
    }),
    [
      sessionId,
      files,
      query.data,
      query.isError,
      query.error,
      tabs,
      active,
      openTab,
      closeTab,
      activate,
      byKey,
    ],
  );
  return <FilesContext.Provider value={value}>{children}</FilesContext.Provider>;
}

/** The open conversation's files, or `null` outside a conversation. */
export function useSessionFilesOptional(): SessionFilesValue | null {
  return useContext(FilesContext);
}

export function useSessionFilesContext(): SessionFilesValue {
  const value = useContext(FilesContext);
  if (!value) throw new Error('useSessionFilesContext outside SessionFilesProvider');
  return value;
}

/**
 * Open one of the conversation's files in the pane beside it, as a tab. `null` outside a
 * conversation, so a caller can draw a plain name instead of a link.
 */
export function useOpenFile(): ((key: string) => void) | null {
  const files = useSessionFilesOptional();
  const pane = usePaneOptional();
  const { t } = useI18n();
  const open = useCallback(
    (key: string) => {
      if (!files || !pane) return;
      files.openTab(key);
      pane.open({ kind: 'preview', title: t('files.title'), node: <FilePreviewPanel /> });
    },
    [files, pane, t],
  );
  return files && pane ? open : null;
}
