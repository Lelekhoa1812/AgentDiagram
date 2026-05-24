/**
 * Edge Routing Web Worker
 *
 * Handles A* pathfinding and edge routing off the main thread to prevent
 * UI blocking on diagrams with 50+ edges. Mirrors the synchronous routing
 * logic from lib/render/edgePath.ts.
 *
 * This file runs in a Web Worker context and must not import React or
 * browser APIs. It can only import pure computation functions and types.
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
  edges: IREdge[];
  nodes: Array<[string, LayoutRect]>;
  groups: Array<[string, LayoutRect]>;
  layoutEdges: Array<[string, LayoutEdge]>;
  overrides: Record<string, { bends: Point[] }>;
  edgeOffsets: Array<[string, number]>;
}

/**
 * Response format from the worker.
 * Note: edgeId is included for mapping back to edges, but RoutedEdgePath itself doesn't include it
 * (the edgeId is the Map key in the main thread).
 */
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

/**
 * Reconstruct LayoutResult from serialized Maps (arrays of [key, value] pairs)
 * since Map objects are not JSON-serializable.
 */
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

self.onmessage = (event: MessageEvent<RouteRequest>) => {
  try {
    const { edges, nodes, groups, layoutEdges, overrides, edgeOffsets } = event.data;

    // Reconstruct Map objects from serialized arrays
    const layout = reconstructLayout(nodes, groups, layoutEdges);
    const edgeOffsetMap = new Map(edgeOffsets);

    // Reconstruct EdgeOverrides object
    const edgeOverridesObj: EdgeOverrides = {};
    if (overrides && Object.keys(overrides).length > 0) {
      edgeOverridesObj.edges = overrides;
    }

    // Route all edges using the synchronous routing logic
    const results: RouteResponse[] = edges.map((edge) => {
      const routed = routeEdgePath(
        edge,
        layout,
        edgeOverridesObj,
        edgeOffsetMap.get(edge.id) ?? 0,
      );

      return {
        edgeId: edge.id,
        path: routed?.path ?? '',
        points: routed?.points ?? [],
        labelPoint: routed?.labelPoint ?? { x: 0, y: 0 },
      };
    });

    // Send back the routed paths
    self.postMessage(results);
  } catch (err) {
    console.error('[Route Worker] Error during edge routing:', err);
    // Send error signal by posting empty array so main thread can fall back to sync
    self.postMessage([]);
  }
};
