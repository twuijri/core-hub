/**
 * The canvas's arithmetic: where a point of the drawing lands on screen, how a pan or a
 * zoom moves that, and the shape of an edge.
 *
 * The drawing's `x` is logical (along the reading direction, `model.ts`). On screen the
 * canvas is one transform, `translate(tx, ty) scale(sign · zoom, zoom)`, where `sign` is
 * −1 in a right-to-left language: the whole drawing is mirrored, so a flow runs the way the
 * page reads, and each node's own content is mirrored back so its words read normally.
 */
import { NODE_HEIGHT, NODE_WIDTH, type Position, type Route, type WfNode } from './model.js';

export interface View {
  tx: number;
  ty: number;
  zoom: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export const signOf = (rtl: boolean) => (rtl ? -1 : 1);

/** A point on screen (relative to the canvas) as a point of the drawing. */
export function toWorld(view: View, rtl: boolean, sx: number, sy: number): Position {
  return { x: (signOf(rtl) * (sx - view.tx)) / view.zoom, y: (sy - view.ty) / view.zoom };
}

/** A screen movement as a movement of the drawing. */
export function deltaToWorld(view: View, rtl: boolean, dx: number, dy: number): Position {
  return { x: (signOf(rtl) * dx) / view.zoom, y: dy / view.zoom };
}

/** Zoom by `factor` keeping the drawing's point under (sx, sy) where it is. */
export function zoomAt(view: View, rtl: boolean, factor: number, sx: number, sy: number): View {
  const zoom = clampZoom(view.zoom * factor);
  const at = toWorld(view, rtl, sx, sy);
  return { zoom, tx: sx - signOf(rtl) * at.x * zoom, ty: sy - at.y * zoom };
}

/** The view that shows every node, centred, no closer than 1.25×. */
export function fitView(
  nodes: readonly { position: Position }[],
  width: number,
  height: number,
  rtl: boolean,
): View {
  if (nodes.length === 0 || width <= 0 || height <= 0) {
    return { zoom: 1, tx: rtl ? Math.max(width, 0) : 0, ty: 0 };
  }
  const margin = 48;
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((n) => n.position.y + NODE_HEIGHT));
  const zoom = clampZoom(
    Math.min(
      (width - 2 * margin) / Math.max(maxX - minX, 1),
      (height - 2 * margin) / Math.max(maxY - minY, 1),
      1.25,
    ),
  );
  return {
    zoom,
    tx: width / 2 - (signOf(rtl) * zoom * (minX + maxX)) / 2,
    ty: height / 2 - (zoom * (minY + maxY)) / 2,
  };
}

/** Where an edge leaves a node: success high, failure low, always in the middle. */
export function outPort(node: WfNode, route: Route): Position {
  const share = route === 'success' ? 0.34 : route === 'failure' ? 0.74 : 0.5;
  return { x: node.position.x + NODE_WIDTH, y: node.position.y + NODE_HEIGHT * share };
}

export function inPort(node: WfNode): Position {
  return { x: node.position.x, y: node.position.y + NODE_HEIGHT / 2 };
}

/** A smooth curve from one port to another, and its midpoint (for the edge's handle). */
export function edgeCurve(from: Position, to: Position): { d: string; mid: Position } {
  const bend = Math.max(48, Math.abs(to.x - from.x) / 2);
  const c1 = { x: from.x + bend, y: from.y };
  const c2 = { x: to.x - bend, y: to.y };
  const mid = {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
  return {
    d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
    mid,
  };
}

/** The least pan that brings a node fully into view (a step just added off-screen). */
export function reveal(
  view: View,
  rtl: boolean,
  position: Position,
  width: number,
  height: number,
  margin = 24,
): View {
  const sign = signOf(rtl);
  const a = view.tx + sign * view.zoom * position.x;
  const b = view.tx + sign * view.zoom * (position.x + NODE_WIDTH);
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  const top = view.ty + view.zoom * position.y;
  const bottom = top + view.zoom * NODE_HEIGHT;
  const dx = left < margin ? margin - left : right > width - margin ? width - margin - right : 0;
  const dy = top < margin ? margin - top : bottom > height - margin ? height - margin - bottom : 0;
  return dx === 0 && dy === 0 ? view : { ...view, tx: view.tx + dx, ty: view.ty + dy };
}
