/**
 * Edge Routing Web Worker
 *
 * Handles A* pathfinding and edge routing off the main thread to prevent
 * UI blocking on diagrams with 50+ edges. Routes are posted in batches so the
 * main canvas can progressively reveal complex diagrams.
 */

import type { IREdge, Point } from '../ir/types';
import type { LayoutEdge, LayoutRect } from '../layout/elk';
import { routeEdgePath } from '../render/edgePath';

interface EdgeOverrides {
  nodes?: Record<string, Partial<LayoutRect>>;
  groups?: Record<string, Partial<LayoutRect>>;
  edges?: Record<string, { bends: Point[] }>;
}

interface RouteRequest {
  requestId: number;
  edges: IREdge[];
  nodes: Array<[string, LayoutRect]>;
  groups: Array<[string, LayoutRect]>;
  layoutEdges: Array<[string, LayoutEdge]>;
  overrides: Record<string, { bends: Point[] }>;
  edgeOffsets: Array<[string, number]>;
  batchSize?: number;
}

interface RouteResponse {
  edgeId: string;
  path: string;
  points: Point[];
  labelPoint: Point;
}

interface LayoutResult {
  nodes: Map<string, LayoutRect>;
  groups: Map<string, LayoutRect>;
  edges: Map<string, LayoutEdge>;
  bbox: { x: number; y: number; width: number; height: number };
}

function reconstructLayout(
  nodes: Array<[string, LayoutRect]>,
  groups: Array<[string, LayoutRect]>,
  layoutEdges: Array<[string, LayoutEdge]>,
): LayoutResult {
  return {
    nodes: new Map(nodes),
    groups: new Map(groups),
    edges: new Map(layoutEdges),
    bbox: { x: 0, y: 0, width: 0, height: 0 },
  };
}

function postBatch(requestId: number, routes: RouteResponse[], completed: number, total: number) {
  self.postMessage({
    requestId,
    type: 'batch',
    routes,
    completed,
    total,
  });
}

self.onmessage = (event: MessageEvent<RouteRequest>) => {
  const requestId = event.data?.requestId ?? -1;

  try {
    const { edges, nodes, groups, layoutEdges, overrides, edgeOffsets } = event.data;
    const batchSize = Math.max(1, event.data.batchSize ?? 16);
    const layout = reconstructLayout(nodes, groups, layoutEdges);
    const edgeOffsetMap = new Map(edgeOffsets);
    const edgeOverridesObj: EdgeOverrides = {};
    if (overrides && Object.keys(overrides).length > 0) {
      edgeOverridesObj.edges = overrides;
    }

    let index = 0;
    const total = edges.length;

    const routeNextBatch = () => {
      try {
        const batch: RouteResponse[] = [];
        const end = Math.min(index + batchSize, total);

        for (; index < end; index++) {
          const edge = edges[index]!;
          const routed = routeEdgePath(
            edge,
            layout,
            edgeOverridesObj,
            edgeOffsetMap.get(edge.id) ?? 0,
          );

          batch.push({
            edgeId: edge.id,
            path: routed?.path ?? '',
            points: routed?.points ?? [],
            labelPoint: routed?.labelPoint ?? { x: 0, y: 0 },
          });
        }

        if (batch.length > 0) postBatch(requestId, batch, index, total);

        if (index < total) {
          setTimeout(routeNextBatch, 0);
          return;
        }

        self.postMessage({ requestId, type: 'complete', completed: total, total });
      } catch (err) {
        self.postMessage({
          requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    routeNextBatch();
  } catch (err) {
    console.error('[Route Worker] Error during edge routing:', err);
    self.postMessage({
      requestId,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
