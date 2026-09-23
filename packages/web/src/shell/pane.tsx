// The right-hand split pane: artifacts, code, preview, tool output, later the tasks. One
// provider; any screen can open content in it. Width is remembered per browser.
import { derived } from '@majlis/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type PaneKind = 'tool' | 'code' | 'preview' | 'artifact' | 'tasks';

export interface PaneContent {
  kind: PaneKind;
  title: string;
  node: ReactNode;
}

interface PaneValue {
  content: PaneContent | null;
  open(content: PaneContent): void;
  close(): void;
  collapsed: boolean;
  toggle(): void;
  width: number;
  setWidth(px: number): void;
}

const PaneContext = createContext<PaneValue | null>(null);
const WIDTH_KEY = `${derived.storagePrefix}pane.width`;
export const PANE_MIN = 288;
export const PANE_DEFAULT = 544;

export function PaneProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<PaneContent | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidthState] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(stored) && stored >= PANE_MIN ? stored : PANE_DEFAULT;
    } catch {
      return PANE_DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // fine
    }
  }, [width]);
  const setWidth = useCallback((px: number) => {
    const max = typeof window === 'undefined' ? 1200 : Math.max(PANE_MIN, window.innerWidth - 480);
    setWidthState(Math.min(max, Math.max(PANE_MIN, Math.round(px))));
  }, []);
  const value = useMemo<PaneValue>(
    () => ({
      content,
      open: (next) => {
        setContent(next);
        setCollapsed(false);
      },
      close: () => setContent(null),
      collapsed,
      toggle: () => setCollapsed((c) => !c),
      width,
      setWidth,
    }),
    [content, collapsed, width, setWidth],
  );
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePane(): PaneValue {
  const value = useContext(PaneContext);
  if (!value) throw new Error('usePane outside PaneProvider');
  return value;
}
