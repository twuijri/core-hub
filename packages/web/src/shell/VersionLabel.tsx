/**
 * The version at the foot of the sidebar, and what it stands for.
 *
 * One number confused the owner (2026-10-27): the label showed the hub's build while his desktop
 * app was newer. So the label shows the version of *this app* — the desktop app's own in the
 * desktop window (from its bridge; the bundle inside a remote-mode window is the hub's), the
 * hub's in a browser, where the hub is what serves the page — and pointing at it (or focusing
 * it) shows each version on its own line: «Desktop app: X» and «Hub: Y» in the desktop app,
 * «Hub: Y» in a browser. It opens at once and closes the moment the pointer or focus leaves:
 * nothing to pin, nothing that lingers.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { desktopBridge } from '../desktop/desktop.js';
import { useI18n } from '../i18n/context.js';

/** The desktop app's own version, or null in a browser (and until the bridge answers). */
export function useDesktopAppVersion(): string | null {
  const bridge = desktopBridge();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .getState()
      .then((state) => live && setVersion(state.appVersion))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);
  return version;
}

export interface VersionFacts {
  /** The version the label shows. */
  shown: string;
  /** The popover's lines, in order: the desktop app (when there is one), then the hub. */
  lines: { key: 'desktop' | 'hub'; version: string }[];
}

/** What the label and its popover say, from the two versions there may be. */
export function versionFacts(desktop: string | null, hub: string): VersionFacts {
  if (desktop === null) return { shown: hub, lines: [{ key: 'hub', version: hub }] };
  return {
    shown: desktop,
    lines: [
      { key: 'desktop', version: desktop },
      { key: 'hub', version: hub },
    ],
  };
}

export function VersionLabel({ hubVersion }: { hubVersion: string }) {
  const { t } = useI18n();
  const facts = versionFacts(useDesktopAppVersion(), hubVersion);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useId();

  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    // Above the label, its end edge on the label's end edge — the end is the left in Arabic.
    const rtl = getComputedStyle(anchor.current!).direction === 'rtl';
    setPlace({
      position: 'fixed',
      bottom: window.innerHeight - rect.top + 6,
      ...(rtl ? { left: rect.left } : { right: window.innerWidth - rect.right }),
    });
  };
  const hide = () => setPlace(null);

  return (
    <span
      ref={anchor}
      className="ms-auto text-faint"
      tabIndex={0}
      data-testid="app-version"
      aria-describedby={place ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide();
      }}
    >
      v{facts.shown}
      {place
        ? createPortal(
            <span
              role="tooltip"
              id={id}
              className="ch-tooltip"
              style={place}
              data-testid="version-popover"
            >
              {facts.lines.map((line) => (
                <span key={line.key} className="block" data-line={line.key}>
                  {t(`shell.version_${line.key}`, { version: `\u2068${line.version}\u2069` })}
                </span>
              ))}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
