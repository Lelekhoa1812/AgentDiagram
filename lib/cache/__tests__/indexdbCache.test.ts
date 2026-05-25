import { describe, expect, it } from 'vitest';
import { hasCompletedRoutes, type CachedRoutedEdge } from '../indexdbCache';

function route(edgeId: string): CachedRoutedEdge {
  return {
    edgeId,
    path: 'M 0 0 L 10 10',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
    labelPoint: { x: 5, y: 5 },
  };
}

describe('hasCompletedRoutes', () => {
  it('rejects partial layout-only cache records', () => {
    expect(hasCompletedRoutes(undefined, ['a'])).toBe(false);
    expect(hasCompletedRoutes([], ['a'])).toBe(false);
  });

  it('requires every expected edge id before a cache entry is reusable', () => {
    expect(hasCompletedRoutes([route('a')], ['a', 'b'])).toBe(false);
    expect(hasCompletedRoutes([route('a'), route('b')], ['a', 'b'])).toBe(true);
  });

  it('allows completed diagrams with no edges', () => {
    expect(hasCompletedRoutes([], [])).toBe(true);
  });
});
