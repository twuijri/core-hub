/**
 * One terminal screen: xterm.js (MIT) with its fit addon.
 *
 * Loaded lazily (`TerminalTool` imports it with `React.lazy`), so the emulator — the largest
 * library in the client — reaches only the owner who opens the Terminal page, never anyone
 * else's bundle.
 *
 * The screen is always left to right: a shell's output is laid out by columns, and the page's
 * Arabic direction must not mirror it. Its colours and font are the design tokens of a code
 * block (`--ch-color-code-*`, `--ch-font-mono`), read when it is created.
 */
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/** What the page drives a screen with. */
export interface PaneHandle {
  write(data: string): void;
  reset(): void;
  focus(): void;
  copy(): Promise<void>;
  paste(): Promise<void>;
  size(): { cols: number; rows: number };
}

export interface XtermPaneProps {
  id: string;
  active: boolean;
  label: string;
  register(id: string, handle: PaneHandle | null): void;
  onInput(id: string, data: string): void;
  onResize(id: string, cols: number, rows: number): void;
  onClipboardDenied(): void;
}

function token(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? undefined : value;
}

export default function XtermPane(props: XtermPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PaneHandle | null>(null);
  const fitNow = useRef<() => void>(() => undefined);
  // The callbacks change on every render of the page; the terminal is made once.
  const latest = useRef(props);
  latest.current = props;
  const { id, active } = props;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const background = token('--ch-color-code-bg');
    const foreground = token('--ch-color-code-text');
    const cursor = token('--ch-color-accent');
    const selection = token('--ch-color-accent-soft');
    const fontFamily = token('--ch-font-mono');
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5_000,
      ...(fontFamily ? { fontFamily } : {}),
      theme: {
        ...(background ? { background } : {}),
        ...(foreground ? { foreground } : {}),
        ...(cursor ? { cursor } : {}),
        ...(selection ? { selectionBackground: selection } : {}),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    const copy = async () => {
      const text = terminal.getSelection();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        latest.current.onClipboardDenied();
      }
    };
    const paste = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) terminal.paste(text);
      } catch {
        latest.current.onClipboardDenied();
      }
      terminal.focus();
    };
    // Ctrl+C belongs to the shell (it interrupts); copying and pasting take Shift as well,
    // the way desktop terminals do. The browser's own paste (Ctrl+V, the menu) also works.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      if (event.code === 'KeyC') {
        void copy();
        return false;
      }
      if (event.code === 'KeyV') {
        event.preventDefault();
        void paste();
        return false;
      }
      return true;
    });
    const typed = terminal.onData((data) => latest.current.onInput(id, data));

    const doFit = () => {
      // A hidden tab has no size; it is fitted when it is shown.
      if (!element.offsetParent || element.clientWidth === 0) return;
      const before = { cols: terminal.cols, rows: terminal.rows };
      fit.fit();
      if (terminal.cols !== before.cols || terminal.rows !== before.rows) {
        latest.current.onResize(id, terminal.cols, terminal.rows);
      }
    };
    fitNow.current = doFit;
    const observer = new ResizeObserver(() => doFit());
    observer.observe(element);

    handle.current = {
      write: (data) => terminal.write(data),
      reset: () => terminal.reset(),
      focus: () => terminal.focus(),
      copy,
      paste,
      size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    };
    latest.current.register(id, handle.current);
    return () => {
      observer.disconnect();
      typed.dispose();
      latest.current.register(id, null);
      handle.current = null;
      terminal.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    fitNow.current();
    handle.current?.focus();
  }, [active]);

  return (
    <div
      ref={host}
      dir="ltr"
      hidden={!active}
      role="group"
      aria-label={props.label}
      data-testid="terminal-screen"
      data-terminal-id={id}
      className="ch-terminal-screen"
    />
  );
}
