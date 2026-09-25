/**
 * The drawing surface: nodes you drag, edges you draw from a node's success or failure dot,
 * pan and zoom, and the keyboard for all of it. Plain HTML nodes over one SVG of edges, with
 * pointer events — no canvas library (the editor needs a few hundred lines of this, not a
 * framework, and our own controls stay ours: DESIGN.md §UI policy).
 *
 * Direction (DECISIONS §48): a flow runs the way the page reads. The drawing's `x` is
 * logical, and in a right-to-left language the whole drawing is mirrored by one transform
 * (`geometry.ts`); each node mirrors its own content back, so words read normally while the
 * steps run right-to-left. The same workflow opened in English runs left-to-right. The
 * world layer itself is laid out left-to-right (`dir="ltr"`), because its coordinates are
 * geometry, not text.
 *
 * Keyboard: every node and every edge is a focusable button (Tab), focusing selects it;
 * arrows move the selected node (Shift: further) or pan when nothing is selected; Delete or
 * Backspace removes the selection; + and − zoom; 0 fits; Escape clears the selection.
 * Connecting without a pointer is done from the side panel ("Next step", "When").
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../i18n/context.js';
import { directionOf } from '../../i18n/index.js';
import { Button } from '../../ui/index.js';
import {
  deltaToWorld,
  edgeCurve,
  fitView,
  inPort,
  outPort,
  signOf,
  toWorld,
  zoomAt,
  type View,
} from './geometry.js';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type Action,
  type Draft,
  type NodeRunState,
  type Position,
  type Route,
  type Selection,
  type WfNode,
  type WorkflowIssue,
} from './model.js';

export interface CanvasRun {
  states: Map<string, NodeRunState>;
  taken: Set<string>;
}

export interface CanvasIssues {
  nodes: Map<string, WorkflowIssue[]>;
  edges: Map<string, WorkflowIssue[]>;
  /** Ids (node or edge) with at least one problem, not only warnings. */
  problems: Set<string>;
}

const STEP = 16;
const BIG_STEP = 64;
const DRAG_THRESHOLD = 3;

type Gesture =
  | { kind: 'pan'; pointer: number; startX: number; startY: number; view: View; moved: boolean }
  | {
      kind: 'drag';
      pointer: number;
      id: string;
      startX: number;
      startY: number;
      origin: Position;
      moved: boolean;
    }
  | { kind: 'link'; pointer: number; from: string; route: Route; at: Position };

const ROUTE_STROKE: Record<Route, string> = {
  success: 'var(--color-success-soft-text)',
  failure: 'var(--color-danger-text)',
  always: 'var(--color-muted)',
};

const STATE_CLASS: Record<NodeRunState, string> = {
  idle: 'border-line',
  waiting: 'border-warning-soft-text ring-2 ring-warning-soft',
  running: 'border-info-soft-text ring-2 ring-info-soft animate-pulse',
  done: 'border-success-soft-text',
  failed: 'border-danger-text',
  skipped: 'border-dashed border-line opacity-60',
};

export function WorkflowCanvas({
  draft,
  selected,
  dispatch,
  readOnly,
  issues,
  run,
  nodeExtra,
  height = 520,
}: {
  draft: Draft;
  selected: Selection;
  dispatch: (action: Action) => void;
  readOnly: boolean;
  issues: CanvasIssues;
  run: CanvasRun | null;
  /** Something drawn under a node — the approval buttons of a step that waits. */
  nodeExtra?: (node: WfNode) => ReactNode;
  height?: number;
}) {
  const { t, language } = useI18n();
  const rtl = directionOf(language) === 'rtl';
  const sign = signOf(rtl);
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, zoom: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const nodes = useMemo(() => new Map(draft.nodes.map((node) => [node.id, node])), [draft.nodes]);

  const size = () => {
    const box = frame.current?.getBoundingClientRect();
    return {
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      left: box?.left ?? 0,
      top: box?.top ?? 0,
    };
  };
  const fit = useCallback(() => {
    const { width, height: tall } = size();
    setView(fitView(draft.nodes, width, tall, rtl));
  }, [draft.nodes, rtl]);

  // Fit when the canvas opens, when the drawing first has steps (a workflow loaded, or the
  // first step added), and when the direction changes. Never while someone is drawing.
  const hasNodes = draft.nodes.length > 0;
  const fittedWith = useRef<{ rtl: boolean; hasNodes: boolean } | null>(null);
  useLayoutEffect(() => {
    const last = fittedWith.current;
    if (last && last.rtl === rtl && (last.hasNodes || !hasNodes)) return;
    fit();
    fittedWith.current = { rtl, hasNodes };
  }, [rtl, hasNodes, fit]);

  // The wheel zooms around the pointer. React's wheel listener is passive, so it is added
  // by hand to be allowed to keep the page from scrolling.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView((current) =>
        zoomAt(current, rtl, factor, event.clientX - box.left, event.clientY - box.top),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [rtl]);

  const zoomBy = (factor: number) => {
    const { width, height: tall } = size();
    setView((current) => zoomAt(current, rtl, factor, width / 2, tall / 2));
  };

  // ------------------------------------------------------------ pointer gestures

  const onBackgroundDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setGesture({
      kind: 'pan',
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      view,
      moved: false,
    });
  };

  const onNodeDown = (event: ReactPointerEvent<HTMLElement>, node: WfNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dispatch({ type: 'select', selection: { type: 'node', id: node.id } });
    if (readOnly) return;
    frame.current?.setPointerCapture?.(event.pointerId);
    setGesture({
      kind: 'drag',
      pointer: event.pointerId,
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: node.position,
      moved: false,
    });
  };

  const onPortDown = (event: ReactPointerEvent<HTMLElement>, node: WfNode, route: Route) => {
    if (event.button !== 0 || readOnly) return;
    event.stopPropagation();
    event.preventDefault();
    frame.current?.setPointerCapture?.(event.pointerId);
    const { left, top } = size();
    setGesture({
      kind: 'link',
      pointer: event.pointerId,
      from: node.id,
      route,
      at: toWorld(view, rtl, event.clientX - left, event.clientY - top),
    });
  };

  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.kind === 'pan') {
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      setGesture({ ...gesture, moved: true });
      setView({ ...gesture.view, tx: gesture.view.tx + dx, ty: gesture.view.ty + dy });
    } else if (gesture.kind === 'drag') {
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!gesture.moved) setGesture({ ...gesture, moved: true });
      const delta = deltaToWorld(view, rtl, dx, dy);
      dispatch({
        type: 'move',
        id: gesture.id,
        position: { x: gesture.origin.x + delta.x, y: gesture.origin.y + delta.y },
      });
    } else {
      const { left, top } = size();
      setGesture({ ...gesture, at: toWorld(view, rtl, event.clientX - left, event.clientY - top) });
    }
  };

  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.kind === 'pan' && !gesture.moved) dispatch({ type: 'select', selection: null });
    if (gesture.kind === 'link') {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      if (target && target !== gesture.from) {
        dispatch({ type: 'connect', from: gesture.from, to: target, route: gesture.route });
      }
    }
    setGesture(null);
  };

  // ------------------------------------------------------------ keyboard

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const node = selected?.type === 'node' ? nodes.get(selected.id) : undefined;
    const step = event.shiftKey ? BIG_STEP : STEP;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const arrow = arrows[event.key];
    if (arrow) {
      event.preventDefault();
      if (node && !readOnly) {
        // A key names a direction on screen; the drawing's x runs the other way in RTL.
        dispatch({ type: 'nudge', id: node.id, dx: sign * arrow[0] * step, dy: arrow[1] * step });
      } else {
        setView((current) => ({
          ...current,
          tx: current.tx - arrow[0] * step * 2,
          ty: current.ty - arrow[1] * step * 2,
        }));
      }
      return;
    }
    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        if (!readOnly && selected) {
          event.preventDefault();
          dispatch({ type: 'remove_selected' });
          frame.current?.focus();
        }
        return;
      case 'Escape':
        if (selected) {
          event.preventDefault();
          dispatch({ type: 'select', selection: null });
        }
        return;
      case '+':
      case '=':
        event.preventDefault();
        zoomBy(1.2);
        return;
      case '-':
      case '_':
        event.preventDefault();
        zoomBy(1 / 1.2);
        return;
      case '0':
        event.preventDefault();
        fit();
        return;
    }
  };

  // ------------------------------------------------------------ drawing

  const routeLabel = (route: Route, from: WfNode | undefined) =>
    from?.kind === 'condition'
      ? t(`workflows.condition_routes.${route}`)
      : t(`workflows.routes.${route}`);

  const linking = gesture?.kind === 'link' ? gesture : null;
  const linkFrom = linking ? nodes.get(linking.from) : undefined;
  const dots = 20 * view.zoom;

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={frame}
        className="relative touch-none select-none overflow-hidden rounded-md border border-line bg-surface outline-none focus-visible:ring-2 focus-visible:ring-focus"
        style={{
          height,
          backgroundImage: 'radial-gradient(var(--color-line) 1px, transparent 1px)',
          backgroundSize: `${dots}px ${dots}px`,
          backgroundPosition: `${view.tx}px ${view.ty}px`,
          cursor: gesture?.kind === 'pan' && gesture.moved ? 'grabbing' : 'default',
        }}
        tabIndex={0}
        role="group"
        aria-label={t('workflows.editor.canvas_label')}
        aria-describedby="workflow-canvas-help"
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setGesture(null)}
        onKeyDown={onKeyDown}
        data-testid="workflow-canvas"
        data-zoom={view.zoom.toFixed(2)}
        data-direction={rtl ? 'rtl' : 'ltr'}
      >
        <div
          dir="ltr"
          className="pointer-events-none absolute inset-0"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${sign * view.zoom}, ${view.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            className="pointer-events-none absolute top-0 start-0 overflow-visible"
            width={1}
            height={1}
            aria-hidden
          >
            <defs>
              {(['success', 'failure', 'always'] as const).map((route) => (
                <marker
                  key={route}
                  id={`wf-arrow-${route}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={ROUTE_STROKE[route]} />
                </marker>
              ))}
            </defs>
            {draft.edges.map((edge) => {
              const from = nodes.get(edge.from);
              const to = nodes.get(edge.to);
              if (!from || !to) return null;
              const { d } = edgeCurve(outPort(from, edge.route), inPort(to));
              const chosen = selected?.type === 'edge' && selected.id === edge.id;
              const taken = run ? run.taken.has(edge.id) : true;
              return (
                <path
                  key={edge.id}
                  d={d}
                  fill="none"
                  stroke={ROUTE_STROKE[edge.route]}
                  strokeWidth={chosen ? 3.5 : run && taken ? 3 : 2}
                  strokeDasharray={edge.route === 'always' ? '6 5' : undefined}
                  opacity={run && !taken ? 0.25 : 1}
                  markerEnd={`url(#wf-arrow-${edge.route})`}
                  data-testid="workflow-edge"
                  data-edge-id={edge.id}
                  data-taken={run ? String(taken) : undefined}
                />
              );
            })}
            {linking && linkFrom && (
              <path
                d={edgeCurve(outPort(linkFrom, linking.route), linking.at).d}
                fill="none"
                stroke={ROUTE_STROKE[linking.route]}
                strokeWidth={2}
                strokeDasharray="4 4"
              />
            )}
          </svg>

          {draft.edges.map((edge) => {
            const from = nodes.get(edge.from);
            const to = nodes.get(edge.to);
            if (!from || !to) return null;
            const { mid } = edgeCurve(outPort(from, edge.route), inPort(to));
            const chosen = selected?.type === 'edge' && selected.id === edge.id;
            const flagged = issues.edges.has(edge.id);
            const label = t('workflows.editor.edge_label', {
              from: from.title || from.id,
              to: to.title || to.id,
              route: routeLabel(edge.route, from),
            });
            return (
              <button
                key={edge.id}
                type="button"
                className={`pointer-events-auto absolute top-0 start-0 grid size-5 place-items-center rounded-full border bg-raised text-[10px] leading-none shadow-sm ${
                  chosen
                    ? 'border-accent ring-2 ring-accent'
                    : flagged
                      ? 'border-danger-text'
                      : 'border-line'
                }`}
                style={{
                  transform: `translate(${mid.x - 10}px, ${mid.y - 10}px) scaleX(${sign})`,
                  color: ROUTE_STROKE[edge.route],
                  opacity: run && !run.taken.has(edge.id) ? 0.4 : 1,
                }}
                aria-label={label}
                aria-pressed={chosen}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  dispatch({ type: 'select', selection: { type: 'edge', id: edge.id } });
                }}
                onFocus={() =>
                  dispatch({ type: 'select', selection: { type: 'edge', id: edge.id } })
                }
                data-testid="workflow-edge-handle"
                data-edge-id={edge.id}
              >
                {edge.route === 'success' ? '✓' : edge.route === 'failure' ? '✕' : '→'}
              </button>
            );
          })}

          {draft.nodes.map((node) => {
            const chosen = selected?.type === 'node' && selected.id === node.id;
            const found = issues.nodes.get(node.id) ?? [];
            const bad = issues.problems.has(node.id);
            const state = run?.states.get(node.id) ?? null;
            const extra = nodeExtra?.(node);
            return (
              <div
                key={node.id}
                className="pointer-events-auto absolute top-0 start-0"
                style={{
                  width: NODE_WIDTH,
                  transform: `translate(${node.position.x}px, ${node.position.y}px) scaleX(${sign})`,
                  transformOrigin: `${NODE_WIDTH / 2}px ${NODE_HEIGHT / 2}px`,
                }}
                data-node-id={node.id}
              >
                <button
                  type="button"
                  dir={rtl ? 'rtl' : 'ltr'}
                  className={`relative flex w-full flex-col gap-0.5 overflow-hidden rounded-md border-2 bg-raised px-3 py-2 text-start shadow-sm ${
                    state
                      ? STATE_CLASS[state]
                      : bad
                        ? 'border-danger-text'
                        : found.length
                          ? 'border-warning-soft-text'
                          : 'border-line'
                  } ${chosen ? 'outline outline-2 outline-offset-2 outline-accent' : ''}`}
                  style={{ height: NODE_HEIGHT, cursor: readOnly ? 'pointer' : 'grab' }}
                  aria-pressed={chosen}
                  aria-label={[
                    t(`workflows.kinds.${node.kind}`),
                    node.title || node.id,
                    state ? t(`workflows.states.${state}`) : null,
                    found.length
                      ? t('workflows.editor.issue_count', { count: found.length })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onPointerDown={(event) => onNodeDown(event, node)}
                  onFocus={() =>
                    dispatch({ type: 'select', selection: { type: 'node', id: node.id } })
                  }
                  data-testid="workflow-node"
                  data-node-id={node.id}
                  data-kind={node.kind}
                  data-state={state ?? undefined}
                  data-issues={found.length || undefined}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                    <span aria-hidden>{KIND_GLYPH[node.kind]}</span>
                    {t(`workflows.kinds.${node.kind}`)}
                    {node.approval_required && node.kind !== 'approval' && (
                      <span aria-hidden>⏸</span>
                    )}
                    {state && (
                      <span
                        className="ms-auto normal-case tracking-normal"
                        data-testid="workflow-node-state"
                      >
                        {t(`workflows.states.${state}`)}
                      </span>
                    )}
                    {!state && found.length > 0 && (
                      <span
                        className={`ms-auto rounded-full px-1.5 normal-case tracking-normal ${
                          bad
                            ? 'bg-danger-soft text-danger-soft-text'
                            : 'bg-warning-soft text-warning-soft-text'
                        }`}
                        data-testid="workflow-node-issues"
                      >
                        {found.length}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-sm font-medium" dir="auto">
                    {node.title || node.id}
                  </span>
                  <span className="truncate text-xs text-muted" dir="auto">
                    {summaryOf(node)}
                  </span>
                </button>
                {!readOnly && (
                  <>
                    <Port
                      share={0.34}
                      route="success"
                      label={`${node.title || node.id}: ${routeLabel('success', node)}`}
                      onPointerDown={(event) => onPortDown(event, node, 'success')}
                    />
                    <Port
                      share={0.74}
                      route="failure"
                      label={`${node.title || node.id}: ${routeLabel('failure', node)}`}
                      onPointerDown={(event) => onPortDown(event, node, 'failure')}
                    />
                  </>
                )}
                {extra && (
                  <div dir={rtl ? 'rtl' : 'ltr'} className="mt-1.5">
                    {extra}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="absolute bottom-2 end-2 flex items-center gap-1 rounded-md border border-line bg-raised p-1 shadow-sm">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => zoomBy(1 / 1.2)}
            aria-label={t('workflows.editor.zoom_out')}
            tooltip={t('workflows.editor.zoom_out')}
            data-testid="workflow-zoom-out"
          >
            −
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => zoomBy(1.2)}
            aria-label={t('workflows.editor.zoom_in')}
            tooltip={t('workflows.editor.zoom_in')}
            data-testid="workflow-zoom-in"
          >
            +
          </Button>
          <Button size="sm" variant="ghost" onClick={fit} data-testid="workflow-fit">
            {t('workflows.editor.fit')}
          </Button>
        </div>
      </div>
      <p id="workflow-canvas-help" className="text-xs text-muted">
        {readOnly ? t('workflows.editor.run_readonly') : t('workflows.editor.canvas_help')}{' '}
        <span className="whitespace-nowrap">{t('workflows.editor.legend')}</span>
      </p>
    </div>
  );
}

const KIND_GLYPH: Record<WfNode['kind'], string> = {
  agent: '✦',
  condition: '◇',
  delay: '◷',
  notify: '✉',
  approval: '✋',
};

function summaryOf(node: WfNode): string {
  const text = (node.input ?? '').replace(/\s+/g, ' ').trim();
  if (node.kind === 'delay' && /^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return seconds % 60 === 0 && seconds > 0 ? `${seconds / 60} min` : `${seconds} s`;
  }
  return text;
}

/** A node's outgoing dot: drag from it onto another node to connect them. */
function Port({
  share,
  route,
  label,
  onPointerDown,
}: {
  share: number;
  route: Route;
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <span
      aria-hidden
      data-label={label}
      className="absolute -end-2 size-4 cursor-crosshair rounded-full border-2 border-raised shadow"
      style={{ top: NODE_HEIGHT * share - 8, background: ROUTE_STROKE[route] }}
      onPointerDown={onPointerDown}
      data-testid={`workflow-port-${route}`}
    />
  );
}
