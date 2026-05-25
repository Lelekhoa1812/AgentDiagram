import { describe, expect, it } from 'vitest';
import type { IREdge } from '@/lib/ir/types';
import type { LayoutResult } from '@/lib/layout/elk';
import { validateCompletedRoutes } from '../routeValidation';
import type { RoutedEdgePath } from '../edgePath';

const edge: IREdge = {
  id: 'e1',
  source: 'a',
  target: 'b',
  kind: 'fwd',
  label: null,
  color: null,
  style: null,
};

function layout(): LayoutResult {
  return {
    nodes: new Map([
      ['a', { x: 0, y: 0, width: 100, height: 40 }],
      ['b', { x: 200, y: 0, width: 100, height: 40 }],
    ]),
    groups: new Map(),
    edges: new Map(),
    bbox: { x: 0, y: 0, width: 300, height: 40 },
  };
}

describe('validateCompletedRoutes', () => {
  it('accepts a complete routed edge set', () => {
    const routed = new Map<string, RoutedEdgePath>([
      [
        'e1',
        {
          path: 'M 100 20 L 200 20',
          points: [
            { x: 100, y: 20 },
            { x: 200, y: 20 },
          ],
          labelPoint: { x: 150, y: 20 },
        },
      ],
    ]);

    expect(validateCompletedRoutes([edge], layout(), routed)).toEqual([]);
  });

  it('rejects missing endpoint layouts and empty paths', () => {
    const missingTarget = layout();
    missingTarget.nodes.delete('b');

    expect(validateCompletedRoutes([edge], missingTarget, new Map())).toEqual([
      'Edge e1 cannot connect a to b: missing endpoint layout.',
    ]);

    expect(
      validateCompletedRoutes(
        [edge],
        layout(),
        new Map([['e1', { path: '', points: [], labelPoint: { x: 0, y: 0 } }]]),
      ),
    ).toEqual(['Edge e1 did not produce a complete routed path.']);
  });
});
