import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n/context.js';
import { IconClose, IconPanel } from '../ui/icons.js';
import { PANE_MIN, usePane } from './pane.js';

const STEP = 32;

/** The divider is a keyboard-operable separator: arrows resize, Home collapses, End expands. */
export function SplitPane() {
  const { t, language } = useI18n();
  const pane = usePane();
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      startX.current = event.clientX;
      startWidth.current = pane.width;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [pane.width],
  );
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const delta = event.clientX - startX.current;
      // The pane sits at the inline end: in LTR it grows when the divider moves left.
      pane.setWidth(language === 'ar' ? startWidth.current + delta : startWidth.current - delta);
    },
    [pane, language],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const grow = language === 'ar' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = language === 'ar' ? 'ArrowLeft' : 'ArrowRight';
      if (event.key === grow) pane.setWidth(pane.width + STEP);
      else if (event.key === shrink) pane.setWidth(pane.width - STEP);
      else if (event.key === 'Home') pane.toggle();
      else if (event.key === 'End') pane.setWidth(window.innerWidth);
      else return;
      event.preventDefault();
    },
    [pane, language],
  );

  if (!pane.content) return null;
  if (pane.collapsed) {
    return (
      <button
        type="button"
        className="btn btn-ghost self-start m-2"
        onClick={pane.toggle}
        aria-label={t('pane.expand')}
      >
        <IconPanel />
      </button>
    );
  }
  return (
    <div
      className="flex h-full shrink-0"
      style={{ inlineSize: pane.width }}
      data-testid="split-pane"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('pane.resize')}
        aria-valuenow={pane.width}
        aria-valuemin={PANE_MIN}
        tabIndex={0}
        className="w-2 shrink-0 cursor-col-resize hover:bg-accent-soft focus-visible:bg-accent-soft"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      />
      <section
        className="flex min-w-0 flex-1 flex-col border-s border-line bg-surface"
        aria-label={pane.content.title}
      >
        <header className="glass flex items-center gap-2 border-b px-3 py-2 text-sm">
          <span className="chip">{t(`pane.kind.${pane.content.kind}`)}</span>
          <h2 className="min-w-0 flex-1 truncate font-medium" dir="auto">
            {pane.content.title}
          </h2>
          <button
            type="button"
            className="btn btn-ghost px-1.5"
            onClick={pane.toggle}
            aria-label={t('pane.collapse')}
          >
            <IconPanel />
          </button>
          <button
            type="button"
            className="btn btn-ghost px-1.5"
            onClick={pane.close}
            aria-label={t('pane.close')}
          >
            <IconClose />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">{pane.content.node}</div>
      </section>
    </div>
  );
}
