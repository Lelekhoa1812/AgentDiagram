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
  requestId: number;
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
  requestId: number;
  edgeId: string;
}

interface EdgeOverrides {
  nodes?: Record<string, Partial<LayoutRect>>;
  groups?: Record<string, Partial<LayoutRect>>;
  edges?: Record<string, { bends: Point[] }>;
}

let routerWorker: Worker | null = null;
let nextRequestId = 1;

interface PendingRouteRequest {
  resolve: (value: Map<string, RoutedEdgePath>) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRouteRequests = new Map<number, PendingRouteRequest>();

function rejectPendingRequests(error: Error): void {
  for (const pending of pendingRouteRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  pendingRouteRequests.clear();
}

function resetRouterWorker(error?: Error): void {
  if (routerWorker) {
    routerWorker.terminate();
    routerWorker = null;
  }
  if (error) rejectPendingRequests(error);
}

function handleWorkerMessage(event: MessageEvent<RouteResponse[]>) {
  const first = event.data[0];
  const requestId = first?.requestId;
  if (requestId === undefined) return;

  const pending = pendingRouteRequests.get(requestId);
  if (!pending) return;
  pendingRouteRequests.delete(requestId);
  clearTimeout(pending.timeoutId);

  if (first && event.data.length === 1 && first.edgeId === '' && !first.path) {
    pending.reject(new Error('Edge routing worker failed before completing routes.'));
    return;
  }

  // Root Cause vs Logic: route worker responses can arrive after newer renders
  // have started, so every response is matched by request id before updating UI
  // state; stale messages are ignored instead of painting old arrows.
  pending.resolve(
    new Map(
      event.data.map((r) => [
        r.edgeId,
        {
          path: r.path,
          points: r.points,
          labelPoint: r.labelPoint,
        } as RoutedEdgePath,
      ]),
    ),
  );
}

function handleWorkerError(error: ErrorEvent) {
  console.error('[EdgeRouter] Worker error:', error.message);
  resetRouterWorker(new Error(error.message || 'Edge routing worker crashed.'));
}

function getRouterWorker(): Worker {
  if (!routerWorker) {
    // In Next.js, we use module worker syntax
    // The TypeScript file is compiled by webpack during build
    routerWorker = new Worker(new URL('../workers/route-worker.ts', import.meta.url), {
      type: 'module',
    });

    // Log for debugging
    console.debug('[EdgeRouter] Worker instantiated');
    routerWorker.addEventListener('message', handleWorkerMessage);
    routerWorker.addEventListener('error', handleWorkerError);
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
  timeoutMs = 10_000,
): Promise<Map<string, RoutedEdgePath>> {
  if (edges.length === 0) return new Map();

  const worker = getRouterWorker();
  const requestId = nextRequestId++;

  // Serialize the request
  // Maps must be converted to arrays since they're not JSON-serializable
  const request: RouteRequest = {
    requestId,
    edges,
    nodes: Array.from(layout.nodes.entries()),
    groups: Array.from(layout.groups.entries()),
    layoutEdges: Array.from(layout.edges.entries()),
    overrides: overrides?.edges ?? {},
    edgeOffsets: Array.from(edgeOffsets.entries()),
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      resetRouterWorker(
        new Error(`Edge routing timed out after ${Math.round(timeoutMs / 1000)}s.`),
      );
    }, timeoutMs);

    pendingRouteRequests.set(requestId, { resolve, reject, timeoutId });
    try {
      worker.postMessage(request);
    } catch (err) {
      console.error('[EdgeRouter] Failed to post message to worker:', err);
      pendingRouteRequests.delete(requestId);
      clearTimeout(timeoutId);
      resetRouterWorker();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Terminate the worker when done (optional cleanup).
 * Not called automatically to reuse the worker across renders.
 */
export function terminateRouterWorker(): void {
  resetRouterWorker(new Error('Edge routing worker terminated.'));
}
