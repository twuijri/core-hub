/**
 * The drawing surface: nodes you drag, edges you draw from a node's success or failure dot,
 * pan and zoom, and the keyboard for all of it. Plain HTML nodes over one SVG of edges, with
 * pointer events — no canvas library (the editor needs a few hundred lines of this, not a
 * framework, and our own controls stay ours: DESIGN.md §UI policy).
 *
 * Direction (DECISIONS §52): a flow runs the way the page reads. The drawing's `x` is
 * logical, and in a right-to-left language the whole drawing is mirrored by one transform
 * (`geometry.ts`); each node mirrors its own content back, so words read normally while the
 * steps run right-to-left. The same workflow opened in English runs left-to-right. The
 * world layer itself is laid out left-to-right (`dir="ltr"`), because its coordinates are
 * geometry, not text.
 *
 * Keyboard: every node and every edge is a focusable button (Tab), focusing selects it and
 * Enter opens it; arrows move the selected node (Shift: further) or pan when nothing is
 * selected; Delete or Backspace removes the selection; + and − zoom; 0 fits; Escape clears
 * the selection. Connecting without a pointer is done in a step's dialog ("Next step", "When").
 *
 * Like n8n (owner, 2026-09-29): the workflow's triggers are drawn as nodes before its first
 * steps (`trigger-nodes.ts`) with a line to each step a run starts at; an empty workflow shows
 * one big "Add a trigger"; each step has a "+" after its outputs that adds the next step, and
 * a connection dropped on empty canvas adds one there. A click opens a step, a connection or
 * a trigger in its own dialog (the editor's), so the canvas itself carries no form.
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
import { Button, Tooltip } from '../../ui/index.js';
import {
  IconAgents,
  IconApproval,
  IconCondition,
  IconDelay,
  IconNotify,
  IconPlay,
  IconPlus,
  IconScheduleClock,
  IconSendMessage,
  IconTrigger,
  IconWebhook,
} from '../../ui/icons.js';
import {
  TRIGGER_HEIGHT,
  TRIGGER_WIDTH,
  firstSteps,
  triggerPlaces,
  triggerPort,
  type CanvasTrigger,
} from './trigger-nodes.js';
import {
  deltaToWorld,
  edgeCurve,
  fitView,
  inPort,
  outPort,
  reveal,
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

/** Where a step added from the canvas comes after: a step's output, a trigger, or nothing. */
export type AddFrom = { type: 'node'; id: string; route: Route } | { type: 'trigger'; id: string };

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
  | {
      kind: 'link';
      pointer: number;
      from: string;
      /** From a trigger's dot: it can only start a first step. */
      trigger: boolean;
      route: Route;
      origin: Position;
      at: Position;
    };

/** How far a connection must be dragged before dropping it on empty canvas adds a step. */
const DROP_DISTANCE = 24;

const ROUTE_STROKE: Record<Route, string> = {
  success: 'var(--color-success-soft-text)',
  failure: 'var(--color-danger)',
  always: 'var(--color-muted)',
};

const STATE_CLASS: Record<NodeRunState, string> = {
  idle: 'border-line',
  waiting: 'border-warning-soft-text ring-2 ring-warning-soft',
  running: 'border-info-soft-text ring-2 ring-info-soft motion-safe:animate-pulse',
  done: 'border-success-soft-text',
  failed: 'border-danger',
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
  triggers = [],
  onOpenNode,
  onOpenEdge,
  onOpenTrigger,
  onAddStep,
  onAddTrigger,
  toolbar,
}: {
  draft: Draft;
  selected: Selection;
  dispatch: (action: Action) => void;
  readOnly: boolean;
  issues: CanvasIssues;
  run: CanvasRun | null;
  /** Something drawn under a node — the approval buttons of a step that waits. */
  nodeExtra?: (node: WfNode) => ReactNode;
  height?: number | string;
  /** The workflow's triggers, drawn before its first steps (`trigger-nodes.ts`). */
  triggers?: readonly CanvasTrigger[];
  /** A click (or Enter) on a step, a connection or a trigger opens it. */
  onOpenNode?: (id: string) => void;
  onOpenEdge?: (id: string) => void;
  onOpenTrigger?: (id: string) => void;
  /** A "+" was pressed, or a connection dropped on empty canvas (`at`, in the drawing). */
  onAddStep?: (from: AddFrom | null, at?: Position) => void;
  /** The big "Add a trigger" of an empty workflow. */
  onAddTrigger?: () => void;
  /** Buttons drawn in the canvas's top corner ("Add step", "Add trigger"). */
  toolbar?: ReactNode;
}) {
  const { t, language } = useI18n();
  const rtl = directionOf(language) === 'rtl';
  const sign = signOf(rtl);
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, zoom: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const nodes = useMemo(() => new Map(draft.nodes.map((node) => [node.id, node])), [draft.nodes]);
  // The trigger column, and the steps a run starts at (what each trigger's line reaches).
  const places = useMemo(() => triggerPlaces(draft, triggers.length), [draft, triggers.length]);
  const starts = useMemo(() => firstSteps(draft), [draft]);
  const startIds = useMemo(() => new Set(starts.map((node) => node.id)), [starts]);
  const triggerAt = useMemo(
    () => new Map(triggers.map((trigger, index) => [trigger.id, places[index]!])),
    [triggers, places],
  );
  // Which side a step's outputs are on, on screen: the reading direction's end.
  const outSide = rtl ? 'left' : 'right';

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
    const boxes = [...draft.nodes, ...places.map((position) => ({ position }))];
    setView(fitView(boxes, width, tall, rtl));
  }, [draft.nodes, places, rtl]);

  // Fit when the canvas opens, when the drawing first has steps (a workflow loaded, or the
  // first step added), when its triggers first arrive, and when the direction changes. Never
  // while someone is drawing.
  const hasNodes = draft.nodes.length > 0;
  const hasTriggers = triggers.length > 0;
  const fittedWith = useRef<{ rtl: boolean; hasNodes: boolean; hasTriggers: boolean } | null>(null);
  useLayoutEffect(() => {
    const last = fittedWith.current;
    if (
      last &&
      last.rtl === rtl &&
      (last.hasNodes || !hasNodes) &&
      (last.hasTriggers || !hasTriggers)
    )
      return;
    fit();
    fittedWith.current = { rtl, hasNodes, hasTriggers };
  }, [rtl, hasNodes, hasTriggers, fit]);

  // A hint about a connection that could not be made fades after a moment.
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(timer);
  }, [hint]);

  // A step just added is brought into view, without changing the zoom.
  const count = draft.nodes.length;
  const lastCount = useRef(count);
  useEffect(() => {
    const grew = count > lastCount.current;
    lastCount.current = count;
    const added = draft.nodes[count - 1];
    if (!grew || !added) return;
    const { width, height: tall } = size();
    setView((current) => reveal(current, rtl, added.position, width, tall));
    // Only a change in the number of steps asks for this.
  }, [count]);

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

  const onPortDown = (
    event: ReactPointerEvent<HTMLElement>,
    from: string,
    route: Route,
    trigger = false,
  ) => {
    if (event.button !== 0 || readOnly) return;
    event.stopPropagation();
    event.preventDefault();
    frame.current?.setPointerCapture?.(event.pointerId);
    const { left, top } = size();
    const at = toWorld(view, rtl, event.clientX - left, event.clientY - top);
    setGesture({ kind: 'link', pointer: event.pointerId, from, trigger, route, origin: at, at });
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
    // A step pressed and let go without moving opens it.
    if (gesture.kind === 'drag' && !gesture.moved) onOpenNode?.(gesture.id);
    if (gesture.kind === 'link') {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const target = under?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      const onTrigger = !!under?.closest('[data-trigger-node]');
      const { left, top } = size();
      const at = toWorld(view, rtl, event.clientX - left, event.clientY - top);
      const far =
        Math.hypot(at.x - gesture.origin.x, at.y - gesture.origin.y) * view.zoom >= DROP_DISTANCE;
      if (gesture.trigger) {
        // A trigger starts the steps nothing leads into; it cannot start one in the middle.
        if (target && !startIds.has(target)) setHint(t('workflows.nodes.trigger_link_hint'));
        else if (!target && !onTrigger && far)
          onAddStep?.({ type: 'trigger', id: gesture.from }, at);
      } else if (target && target !== gesture.from) {
        dispatch({ type: 'connect', from: gesture.from, to: target, route: gesture.route });
      } else if (!target && !onTrigger && far) {
        onAddStep?.({ type: 'node', id: gesture.from, route: gesture.route }, at);
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
      case 'Enter':
        // Enter on a step or a connection is its own button's click (it opens it).
        return;
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
  const linkStart: Position | null = linking
    ? linking.trigger
      ? triggerAt.has(linking.from)
        ? triggerPort(triggerAt.get(linking.from)!)
        : null
      : nodes.has(linking.from)
        ? outPort(nodes.get(linking.from)!, linking.route)
        : null
    : null;
  const dots = 20 * view.zoom;
  const empty = draft.nodes.length === 0 && triggers.length === 0;
  const hasOut = (node: WfNode, route: Route) =>
    draft.edges.some(
      (edge) => edge.from === node.id && (edge.route === route || edge.route === 'always'),
    );

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={frame}
        className="relative touch-none select-none overflow-hidden rounded-md border border-line bg-surface outline-none focus-visible:ring-2 focus-visible:ring-focus"
        style={{
          height,
          minHeight: 420,
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
                  markerUnits="userSpaceOnUse"
                  markerWidth="11"
                  markerHeight="11"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={ROUTE_STROKE[route]} />
                </marker>
              ))}
              <marker
                id="wf-arrow-trigger"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerUnits="userSpaceOnUse"
                markerWidth="11"
                markerHeight="11"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-warning-soft-text)" />
              </marker>
            </defs>
            {triggers.map((trigger) => {
              const at = triggerAt.get(trigger.id);
              if (!at) return null;
              return starts.map((step) => (
                <path
                  key={`${trigger.id}-${step.id}`}
                  d={edgeCurve(triggerPort(at), inPort(step)).d}
                  fill="none"
                  stroke="var(--color-warning-soft-text)"
                  strokeWidth={2}
                  strokeDasharray={trigger.pending || !trigger.enabled ? '5 5' : undefined}
                  opacity={trigger.enabled ? 0.9 : 0.45}
                  markerEnd="url(#wf-arrow-trigger)"
                  data-testid="workflow-trigger-edge"
                  data-trigger-id={trigger.id}
                  data-to={step.id}
                />
              ));
            })}
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
            {linking && linkStart && (
              <path
                d={edgeCurve(linkStart, linking.at).d}
                fill="none"
                stroke={
                  linking.trigger ? 'var(--color-warning-soft-text)' : ROUTE_STROKE[linking.route]
                }
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
                      ? 'border-danger'
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
                onClick={() => onOpenEdge?.(edge.id)}
                data-testid="workflow-edge-handle"
                data-edge-id={edge.id}
              >
                {edge.route === 'success' ? '✓' : edge.route === 'failure' ? '✕' : '→'}
              </button>
            );
          })}

          {triggers.map((trigger) => {
            const at = triggerAt.get(trigger.id);
            if (!at) return null;
            return (
              <div
                key={trigger.id}
                dir={rtl ? 'rtl' : 'ltr'}
                className="group pointer-events-auto absolute top-0 left-0"
                style={{
                  width: TRIGGER_WIDTH,
                  transform: `translate(${at.x}px, ${at.y}px) scaleX(${sign})`,
                  transformOrigin: `${TRIGGER_WIDTH / 2}px ${TRIGGER_HEIGHT / 2}px`,
                }}
                data-trigger-node={trigger.id}
              >
                <button
                  type="button"
                  className={`relative flex w-full items-center gap-2 overflow-hidden rounded-e-md rounded-s-[2rem] border-2 bg-raised py-2 pe-3 ps-2 text-start shadow-sm ${
                    trigger.pending || !trigger.enabled
                      ? 'border-dashed border-warning-soft-text/70'
                      : 'border-warning-soft-text'
                  } ${trigger.enabled ? '' : 'opacity-70'}`}
                  style={{ height: TRIGGER_HEIGHT }}
                  aria-label={[
                    t('workflows.nodes.trigger'),
                    trigger.title,
                    trigger.detail,
                    trigger.pending ? t('workflows.nodes.pending') : null,
                    trigger.enabled ? null : t('workflows.nodes.off'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onOpenTrigger?.(trigger.id)}
                  data-testid="workflow-trigger-node"
                  data-trigger-id={trigger.id}
                  data-trigger-kind={trigger.kind}
                  data-pending={trigger.pending ? 'true' : undefined}
                >
                  <span
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-warning-soft text-warning-soft-text"
                    aria-hidden
                  >
                    {TRIGGER_ICON[trigger.kind]}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                      <IconTrigger size={11} aria-hidden />
                      {t('workflows.nodes.trigger')}
                    </span>
                    <span className="truncate text-sm font-medium" dir="auto">
                      {trigger.title}
                    </span>
                    <span
                      className="max-w-full self-start truncate text-xs text-muted"
                      dir={trigger.detailLtr && !trigger.pending ? 'ltr' : 'auto'}
                    >
                      {trigger.pending ? t('workflows.nodes.pending') : trigger.detail}
                    </span>
                  </span>
                </button>
                {!readOnly && (
                  <>
                    <span
                      aria-hidden
                      className="absolute size-4 cursor-crosshair rounded-full border-2 border-raised shadow"
                      style={{
                        top: TRIGGER_HEIGHT / 2 - 8,
                        [outSide]: -8,
                        background: 'var(--color-warning-soft-text)',
                      }}
                      onPointerDown={(event) => onPortDown(event, trigger.id, 'success', true)}
                      data-testid="workflow-trigger-port"
                    />
                    <AddHandle
                      top={TRIGGER_HEIGHT / 2}
                      side={outSide}
                      shown={starts.length === 0}
                      label={t('workflows.nodes.add_first', { name: trigger.title })}
                      onAdd={() => onAddStep?.({ type: 'trigger', id: trigger.id })}
                      testId="workflow-trigger-add-step"
                    />
                  </>
                )}
              </div>
            );
          })}

          {draft.nodes.map((node) => {
            const chosen = selected?.type === 'node' && selected.id === node.id;
            const found = issues.nodes.get(node.id) ?? [];
            const bad = issues.problems.has(node.id);
            const state = run?.states.get(node.id) ?? null;
            const extra = nodeExtra?.(node);
            const kindName = node.send
              ? t('workflows.send.title')
              : t(`workflows.kinds.${node.kind}`);
            return (
              <div
                key={node.id}
                dir={rtl ? 'rtl' : 'ltr'}
                className="group pointer-events-auto absolute top-0 left-0"
                style={{
                  width: NODE_WIDTH,
                  transform: `translate(${node.position.x}px, ${node.position.y}px) scaleX(${sign})`,
                  transformOrigin: `${NODE_WIDTH / 2}px ${NODE_HEIGHT / 2}px`,
                }}
                data-node-id={node.id}
              >
                <button
                  type="button"
                  className={`relative flex w-full items-center gap-2.5 overflow-hidden rounded-md border-2 bg-raised px-2.5 py-2 text-start shadow-sm ${
                    state
                      ? STATE_CLASS[state]
                      : bad
                        ? 'border-danger'
                        : found.length
                          ? 'border-warning-soft-text'
                          : 'border-line'
                  } ${chosen ? 'outline outline-2 outline-offset-2 outline-accent' : ''}`}
                  style={{ height: NODE_HEIGHT, cursor: readOnly ? 'pointer' : 'grab' }}
                  aria-pressed={chosen}
                  aria-label={[
                    kindName,
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
                  onClick={(event) => {
                    // Enter or Space (a click with no pointer) opens the step; a pointer
                    // opens it when it lets go without dragging (`onUp`).
                    if (event.detail === 0) onOpenNode?.(node.id);
                  }}
                  data-testid="workflow-node"
                  data-node-id={node.id}
                  data-kind={node.kind}
                  data-state={state ?? undefined}
                  data-issues={found.length || undefined}
                >
                  <span
                    className={`grid size-9 shrink-0 place-items-center rounded-md ${KIND_TONE[node.kind]}`}
                    aria-hidden
                  >
                    {node.send ? <IconSendMessage size={18} /> : KIND_ICON[node.kind]}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                      <span className="truncate">{kindName}</span>
                      {node.approval_required && node.kind !== 'approval' && (
                        <IconApproval size={11} aria-hidden />
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
                  </span>
                </button>
                {!readOnly && (
                  <>
                    <Port
                      share={0.34}
                      side={outSide}
                      route="success"
                      label={`${node.title || node.id}: ${routeLabel('success', node)}`}
                      onPointerDown={(event) => onPortDown(event, node.id, 'success')}
                    />
                    <Port
                      share={0.74}
                      side={outSide}
                      route="failure"
                      label={`${node.title || node.id}: ${routeLabel('failure', node)}`}
                      onPointerDown={(event) => onPortDown(event, node.id, 'failure')}
                    />
                    {onAddStep && (
                      <AddHandle
                        top={NODE_HEIGHT * 0.34}
                        side={outSide}
                        shown={!hasOut(node, 'success')}
                        label={t('workflows.nodes.add_after', {
                          name: node.title || node.id,
                          route: routeLabel('success', node),
                        })}
                        onAdd={() => onAddStep({ type: 'node', id: node.id, route: 'success' })}
                        testId="workflow-node-add"
                        route="success"
                      />
                    )}
                    {onAddStep && node.kind === 'condition' && (
                      <AddHandle
                        top={NODE_HEIGHT * 0.74}
                        side={outSide}
                        shown={!hasOut(node, 'failure')}
                        label={t('workflows.nodes.add_after', {
                          name: node.title || node.id,
                          route: routeLabel('failure', node),
                        })}
                        onAdd={() => onAddStep({ type: 'node', id: node.id, route: 'failure' })}
                        testId="workflow-node-add"
                        route="failure"
                      />
                    )}
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

        {empty && !readOnly && onAddTrigger && (
          <div className="absolute inset-0 grid place-items-center">
            <button
              type="button"
              className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line-strong bg-raised/80 px-10 py-8 text-center shadow-sm hover:border-accent focus-visible:border-accent"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onAddTrigger}
              data-testid="workflow-add-first"
            >
              <span className="grid size-14 place-items-center rounded-full bg-warning-soft text-warning-soft-text">
                <IconPlus size={28} aria-hidden />
              </span>
              <span className="text-base font-medium">
                {t('workflows.nodes.add_first_trigger')}
              </span>
              <span className="max-w-72 text-xs text-muted">
                {t('workflows.nodes.add_first_hint')}
              </span>
            </button>
          </div>
        )}

        {toolbar && !readOnly && (
          <div
            className="absolute top-2 end-2 flex items-center gap-1 rounded-md border border-line bg-raised p-1 shadow-sm"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {toolbar}
          </div>
        )}

        {hint && (
          <p
            className="absolute bottom-2 start-2 max-w-[60%] rounded-md bg-warning-soft px-2 py-1 text-xs text-warning-soft-text shadow-sm"
            role="status"
            data-testid="workflow-canvas-hint"
          >
            {hint}
          </p>
        )}

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
        {readOnly ? t('workflows.editor.run_readonly') : t('workflows.nodes.canvas_help')}{' '}
        <span className="whitespace-nowrap">{t('workflows.editor.legend')}</span>
      </p>
    </div>
  );
}

const TRIGGER_ICON: Record<CanvasTrigger['kind'], ReactNode> = {
  manual: <IconPlay size={18} />,
  webhook: <IconWebhook size={18} />,
  schedule: <IconScheduleClock size={18} />,
};

const KIND_ICON: Record<WfNode['kind'], ReactNode> = {
  agent: <IconAgents size={18} />,
  condition: <IconCondition size={18} />,
  delay: <IconDelay size={18} />,
  notify: <IconNotify size={18} />,
  approval: <IconApproval size={18} />,
};

/** Each kind of step keeps one colour, so a drawing reads at a glance. */
const KIND_TONE: Record<WfNode['kind'], string> = {
  agent: 'bg-accent-soft text-accent-soft-text',
  condition: 'bg-info-soft text-info-soft-text',
  delay: 'bg-surface-2 text-muted',
  notify: 'bg-success-soft text-success-soft-text',
  approval: 'bg-danger-soft text-danger-soft-text',
};

function summaryOf(node: WfNode): string {
  // A condition with several rules shows them, not the single line it no longer reads (§123).
  if (node.kind === 'condition' && node.rules && node.rules.items.length > 0) {
    const joiner = node.rules.match === 'any' ? ' | ' : ' & ';
    return node.rules.items
      .map((rule) =>
        rule.value === null
          ? `${rule.path} ${rule.operator}`
          : `${rule.path} ${rule.operator} ${rule.value}`,
      )
      .join(joiner);
  }
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
  side,
  route,
  label,
  onPointerDown,
}: {
  share: number;
  /** The screen side a step's outputs are on (the reading direction's end). */
  side: 'left' | 'right';
  route: Route;
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <span
      aria-hidden
      data-label={label}
      className="absolute size-4 cursor-crosshair rounded-full border-2 border-raised shadow"
      style={{ top: NODE_HEIGHT * share - 8, [side]: -8, background: ROUTE_STROKE[route] }}
      onPointerDown={onPointerDown}
      data-testid={`workflow-port-${route}`}
    />
  );
}

/**
 * The "+" after a step's output (or a trigger): adds the next step there. Shown while that
 * output leads nowhere; otherwise when the step is hovered or has the keyboard.
 */
function AddHandle({
  top,
  side,
  shown,
  label,
  onAdd,
  testId,
  route,
}: {
  top: number;
  side: 'left' | 'right';
  shown: boolean;
  label: string;
  onAdd: () => void;
  testId: string;
  route?: Route;
}) {
  return (
    <span
      className={`absolute flex items-center ${
        shown ? '' : 'opacity-0 transition-ui group-hover:opacity-100 focus-within:opacity-100'
      }`}
      style={{ top: top - 12, [side]: -46 }}
    >
      <span aria-hidden className="h-0.5 w-4 bg-line-strong" />
      <Tooltip label={label}>
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md border border-line-strong bg-raised text-muted shadow-sm hover:border-accent hover:text-accent focus-visible:border-accent"
          aria-label={label}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onAdd}
          data-testid={testId}
          data-route={route}
        >
          <IconPlus size={14} aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}
