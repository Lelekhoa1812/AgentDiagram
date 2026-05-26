import { describe, expect, it } from 'vitest';
import { placeEdgeLabel, rectAtCenter, type RectLike } from '../labelPlacement';

function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function pointToPolylineDistance(point: { x: number; y: number }, points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1]!;
    const end = points[i]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
    const proj = { x: start.x + t * dx, y: start.y + t * dy };
    best = Math.min(best, Math.hypot(point.x - proj.x, point.y - proj.y));
  }
  return best;
}

describe('placeEdgeLabel', () => {
  it('moves later annotations out of occupied label space', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 240, y: 0 },
    ];
    const size = { width: 72, height: 14 };
    const obstacle: RectLike = { x: 102, y: -10, width: 36, height: 20 };

    const firstCenter = placeEdgeLabel(points, size, [], [obstacle]);
    const firstRect = rectAtCenter(firstCenter, size);
    const secondCenter = placeEdgeLabel(points, size, [firstRect], [obstacle]);
    const secondRect = rectAtCenter(secondCenter, size);

    expect(rectsOverlap(firstRect, obstacle)).toBe(false);
    expect(rectsOverlap(secondRect, obstacle)).toBe(false);
    expect(rectsOverlap(firstRect, secondRect)).toBe(false);
    expect(pointToPolylineDistance(firstCenter, points)).toBeLessThanOrEqual(40);
    expect(pointToPolylineDistance(secondCenter, points)).toBeLessThanOrEqual(40);
  });
});
