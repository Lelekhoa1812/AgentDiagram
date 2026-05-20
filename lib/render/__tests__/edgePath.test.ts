import { describe, expect, it } from 'vitest';
import type { IREdge } from '@/lib/ir/types';
import type { LayoutRect, LayoutResult } from '@/lib/layout/elk';
import { routeEdgePath } from '../edgePath';

function layoutResult(): LayoutResult {
  return {
    nodes: new Map([
      ['a', { x: 0, y: 0, width: 100, height: 40 }],
      ['b', { x: 200, y: 0, width: 100, height: 40 }],
    ]),
    groups: new Map(),
    edges: new Map([
      [
        'e1',
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          start: { x: 100, y: 20 },
          end: { x: 200, y: 20 },
          bends: [{ x: 150, y: 20 }],
        },
      ],
    ]),
    bbox: { x: 0, y: 0, width: 300, height: 40 },
  };
}

function edge(): IREdge {
  return {
    id: 'e1',
    source: 'a',
    target: 'b',
    kind: 'fwd',
    label: null,
    color: null,
    style: null,
  };
}

function isOnBoundary(point: { x: number; y: number }, rect: LayoutRect): boolean {
  const onVertical = point.x === rect.x || point.x === rect.x + rect.width;
  const onHorizontal = point.y === rect.y || point.y === rect.y + rect.height;
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height &&
    (onVertical || onHorizontal)
  );
}

function segmentsAreOrthogonal(points: Array<{ x: number; y: number }>): boolean {
  return points.slice(1).every((point, index) => {
    const prev = points[index]!;
    return point.x === prev.x || point.y === prev.y;
  });
}

function segmentIntersectsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: LayoutRect,
): boolean {
  if (a.x === b.x) {
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return (
      a.x > rect.x &&
      a.x < rect.x + rect.width &&
      Math.max(minY, rect.y) < Math.min(maxY, rect.y + rect.height)
    );
  }
  if (a.y === b.y) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return (
      a.y > rect.y &&
      a.y < rect.y + rect.height &&
      Math.max(minX, rect.x) < Math.min(maxX, rect.x + rect.width)
    );
  }
  return true;
}

function pathAvoidsRect(points: Array<{ x: number; y: number }>, rect: LayoutRect): boolean {
  return points
    .slice(1)
    .every((point, index) => !segmentIntersectsRect(points[index]!, point, rect));
}

describe('routeEdgePath', () => {
  it('reattaches arrow endpoints to moved nodes', () => {
    const layout = layoutResult();
    const movedTarget = { x: 320, y: 80, width: 100, height: 40 };
    const routed = routeEdgePath(edge(), layout, { nodes: { b: movedTarget } });

    expect(routed).not.toBeNull();
    expect(isOnBoundary(routed!.points[routed!.points.length - 1]!, movedTarget)).toBe(true);
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
  });

  it('keeps manual edge bends editable while enforcing orthogonal segments', () => {
    const layout = layoutResult();
    const movedSource = { x: 40, y: 80, width: 100, height: 40 };
    const routed = routeEdgePath(edge(), layout, {
      nodes: { a: movedSource },
      edges: { e1: { bends: [{ x: 150, y: 20 }] } },
    });

    expect(routed).not.toBeNull();
    expect(isOnBoundary(routed!.points[0]!, movedSource)).toBe(true);
    expect(routed!.points).toContainEqual({ x: 150, y: 20 });
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
  });

  it('routes default arrows around intervening components', () => {
    const layout = layoutResult();
    const obstacle = { x: 120, y: -20, width: 60, height: 80 };
    layout.nodes.set('c', obstacle);

    const routed = routeEdgePath(edge(), layout);

    expect(routed).not.toBeNull();
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
    expect(pathAvoidsRect(routed!.points, obstacle)).toBe(true);
  });
});
