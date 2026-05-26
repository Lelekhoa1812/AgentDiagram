import type { Point } from '../ir/types';
import type { LayoutRect, LayoutResult } from '../layout/elk';

export interface LabelSize {
  width: number;
  height: number;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelPlacementOverrides {
  nodes?: Record<string, Partial<LayoutRect>>;
  groups?: Record<string, Partial<LayoutRect>>;
}

const LABEL_OBSTACLE_PADDING = 10;

function midpointOnPolyline(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const len = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    lengths.push(len);
    total += len;
  }

  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const len = lengths[i - 1]!;
    if (remaining <= len) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const t = len === 0 ? 0 : remaining / len;
      return { x: prev.x + (curr.x - prev.x) * t, y: prev.y + (curr.y - prev.y) * t };
    }
    remaining -= len;
  }

  return points[points.length - 1]!;
}

function axisNearPoint(points: Point[], point: Point): 'horizontal' | 'vertical' {
  if (points.length < 2) return 'horizontal';
  let best = Infinity;
  let axis: 'horizontal' | 'vertical' = 'horizontal';
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1]!;
    const end = points[i]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
    const proj = { x: start.x + t * dx, y: start.y + t * dy };
    const distance = Math.hypot(point.x - proj.x, point.y - proj.y);
    if (distance < best) {
      best = distance;
      axis = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
    }
  }
  return axis;
}

function pointToPolylineDistance(point: Point, points: Point[]): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);

  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1]!;
    const end = points[i]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      best = Math.min(best, Math.hypot(point.x - start.x, point.y - start.y));
      continue;
    }
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
    const proj = { x: start.x + t * dx, y: start.y + t * dy };
    best = Math.min(best, Math.hypot(point.x - proj.x, point.y - proj.y));
  }
  return best;
}

function rectFromCenter(center: Point, size: LabelSize): RectLike {
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function expandRect(rect: LayoutRect, padding: number): RectLike {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

export function collectLabelObstacles(
  layout: LayoutResult,
  overrides?: LabelPlacementOverrides,
): RectLike[] {
  const out: RectLike[] = [];
  for (const [id, base] of layout.nodes) {
    const ov = overrides?.nodes?.[id];
    out.push(
      expandRect(
        {
          x: ov?.x ?? base.x,
          y: ov?.y ?? base.y,
          width: ov?.width ?? base.width,
          height: ov?.height ?? base.height,
        },
        LABEL_OBSTACLE_PADDING,
      ),
    );
  }
  for (const [id, base] of layout.groups) {
    const ov = overrides?.groups?.[id];
    out.push(
      expandRect(
        {
          x: ov?.x ?? base.x,
          y: ov?.y ?? base.y,
          width: ov?.width ?? base.width,
          height: ov?.height ?? base.height,
        },
        LABEL_OBSTACLE_PADDING,
      ),
    );
  }
  return out;
}

function scorePlacement(
  rect: RectLike,
  occupied: readonly RectLike[],
  obstacles: readonly RectLike[],
  points: Point[],
  center: Point,
  anchor: Point,
): number {
  let overlapScore = 0;
  for (const box of occupied) {
    if (rectsOverlap(rect, box)) overlapScore += 1;
  }
  for (const box of obstacles) {
    if (rectsOverlap(rect, box)) overlapScore += 5;
  }
  const routeDistance = pointToPolylineDistance(center, points);
  const anchorDistance = Math.hypot(center.x - anchor.x, center.y - anchor.y);
  const maxRouteDrift = Math.max(28, rect.height * 2.5);
  const driftPenalty = routeDistance <= maxRouteDrift ? routeDistance * 200 : 1_000_000 + routeDistance * 50;
  return overlapScore * 100000 + driftPenalty + anchorDistance;
}

/**
 * Root Cause vs Logic: edge labels were anchored to route midpoints only, so
 * parallel arrows and annotations in the same corridor would stack on top of
 * each other after a rebuild. Probe a small grid of nearby positions, prefer
 * empty slots away from node/group rectangles, and keep the placement stable
 * for both interactive rendering and export.
 */
export function placeEdgeLabel(
  points: Point[],
  size: LabelSize,
  occupied: readonly RectLike[] = [],
  obstacles: readonly RectLike[] = [],
): Point {
  const anchor = midpointOnPolyline(points);
  const axis = axisNearPoint(points, anchor);
  const perpStep = Math.max(14, size.height + 6);
  const parStep = Math.max(10, size.width * 0.18);
  const offsets = [0, 1, -1, 2, -2, 3, -3];

  const candidates: Array<{ center: Point; scoreHint: number }> = [];
  for (const perp of offsets) {
    for (const par of offsets) {
      const center =
        axis === 'horizontal'
          ? { x: anchor.x + par * parStep, y: anchor.y + perp * perpStep }
          : { x: anchor.x + perp * perpStep, y: anchor.y + par * parStep };
      candidates.push({
        center,
        scoreHint: Math.abs(perp) * 2 + Math.abs(par),
      });
    }
  }

  let best = anchor;
  let bestScore = Infinity;
  for (const candidate of candidates.sort((a, b) => a.scoreHint - b.scoreHint)) {
    const rect = rectFromCenter(candidate.center, size);
    const score = scorePlacement(rect, occupied, obstacles, points, candidate.center, anchor);
    if (score < bestScore) {
      bestScore = score;
      best = candidate.center;
      if (score === 0) break;
    }
  }

  return best;
}

export function rectAtCenter(center: Point, size: LabelSize): RectLike {
  return rectFromCenter(center, size);
}
