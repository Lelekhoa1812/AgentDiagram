/**
 * Edge Router Worker Wrapper
 *
 * Manages a singleton Web Worker for edge routing off the main thread.
 * Mirrors the pattern established in lib/layout/elk.ts.
 */

import type { IREdge, Point } from '../ir/types';
import type { LayoutResult, LayoutEdge, LayoutRect } from '../layout/elk';
import type { RoutedEdgePath } from './edgePath';

export type { RoutedEdgePath } from './edgePath';

interface RouteRequest {
  edges: IREdge[];
  nodes: Array<[string, LayoutRect]>;
  groups: Array<[string, LayoutRect]>;
  layoutEdges: Array<[string, LayoutEdge]>;
  overrides: Record<string, { bends: Point[] }>;
  edgeOffsets: Array<[string, number]>;
}

/**
 * Response from the worker includes edgeId for mapping.
 * The RoutedEdgePath interface doesn't include edgeId since it's the Map key.
 */
interface RouteResponse extends RoutedEdgePath {
  edgeId: string;
}

interface EdgeOverrides {
  nodes?: Record<string, Partial<LayoutRect>>;
  groups?: Record<string, Partial<LayoutRect>>;
  edges?: Record<string, { bends: Point[] }>;
}

let routerWorker: Worker | null = null;

function getRouterWorker(): Worker {
  if (!routerWorker) {
    // In Next.js, we use module worker syntax
    // The TypeScript file is compiled by webpack during build
    routerWorker = new Worker(new URL('../workers/route-worker.ts', import.meta.url), {
      type: 'module',
    });

    // Log for debugging
    console.debug('[EdgeRouter] Worker instantiated');
  }
  return routerWorker;
}

/**
 * Route all edges asynchronously using the worker.
 * Falls back to returning empty results if worker fails — caller should use sync routing.
 */
export async function routeAllEdgesAsync(
  edges: IREdge[],
  layout: LayoutResult,
  overrides: EdgeOverrides | undefined,
  edgeOffsets: Map<string, number>,
): Promise<Map<string, RoutedEdgePath>> {
  const worker = getRouterWorker();

  // Serialize the request
  // Maps must be converted to arrays since they're not JSON-serializable
  const request: RouteRequest = {
    edges,
    nodes: Array.from(layout.nodes.entries()),
    groups: Array.from(layout.groups.entries()),
    layoutEdges: Array.from(layout.edges.entries()),
    overrides: overrides?.edges ?? {},
    edgeOffsets: Array.from(edgeOffsets.entries()),
  };

  return new Promise((resolve) => {
    const handleMessage = (event: MessageEvent<RouteResponse[]>) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);

      // Convert array to Map, keyed by edgeId, omitting edgeId from the values
      const result = new Map(
        event.data.map((r) => [
          r.edgeId,
          {
            path: r.path,
            points: r.points,
            labelPoint: r.labelPoint,
          } as RoutedEdgePath,
        ]),
      );
      resolve(result);
    };

    const handleError = (error: ErrorEvent) => {
      console.error('[EdgeRouter] Worker error:', error.message);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      // Return empty map on error — caller will fall back to sync routing
      resolve(new Map());
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    try {
      worker.postMessage(request);
    } catch (err) {
      console.error('[EdgeRouter] Failed to post message to worker:', err);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      resolve(new Map());
    }
  });
}

/**
 * Terminate the worker when done (optional cleanup).
 * Not called automatically to reuse the worker across renders.
 */
export function terminateRouterWorker(): void {
  if (routerWorker) {
    routerWorker.terminate();
    routerWorker = null;
  }
}
