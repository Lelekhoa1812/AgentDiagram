/**
 * Edge Router Worker Wrapper
 *
 * Manages a singleton Web Worker for edge routing off the main thread.
 * Supports progressive batch delivery so large diagrams can paint nodes/groups
 * first, then fill in edges without blocking the browser page.
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
  batchSize: number;
}

interface RouteResponse extends RoutedEdgePath {
  edgeId: string;
}

type RouteWorkerMessage =
  | {
      requestId: number;
      type: 'batch';
      routes: RouteResponse[];
      completed: number;
      total: number;
    }
  | { requestId: number; type: 'complete'; completed: number; total: number }
  | { requestId: number; type: 'error'; error: string };

interface EdgeOverrides {
  nodes?: Record<string, Partial<LayoutRect>>;
  groups?: Record<string, Partial<LayoutRect>>;
  edges?: Record<string, { bends: Point[] }>;
}

export interface RouteProgress {
  routed: Map<string, RoutedEdgePath>;
  batch: Map<string, RoutedEdgePath>;
  completed: number;
  total: number;
}

export interface ProgressiveRouteOptions {
  timeoutMs?: number;
  batchSize?: number;
  signal?: AbortSignal;
  onBatch?: (progress: RouteProgress) => void;
}

let routerWorker: Worker | null = null;
let nextRequestId = 1;

interface PendingRouteRequest {
  routes: Map<string, RoutedEdgePath>;
  resolve: (value: Map<string, RoutedEdgePath>) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
  onBatch?: (progress: RouteProgress) => void;
}

const pendingRouteRequests = new Map<number, PendingRouteRequest>();

function toRouteMap(routes: RouteResponse[]): Map<string, RoutedEdgePath> {
  return new Map(
    routes.map((route) => [
      route.edgeId,
      {
        path: route.path,
        points: route.points,
        labelPoint: route.labelPoint,
      },
    ]),
  );
}

function cleanupPending(requestId: number, pending: PendingRouteRequest): void {
  clearTimeout(pending.timeoutId);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener('abort', pending.abortHandler);
  }
  pendingRouteRequests.delete(requestId);
}

function rejectPendingRequests(error: Error): void {
  for (const [requestId, pending] of pendingRouteRequests) {
    cleanupPending(requestId, pending);
    pending.reject(error);
  }
}

function resetRouterWorker(error?: Error): void {
  if (routerWorker) {
    routerWorker.terminate();
    routerWorker = null;
  }
  if (error) rejectPendingRequests(error);
}

function handleWorkerMessage(event: MessageEvent<RouteWorkerMessage>) {
  const requestId = event.data?.requestId;
  if (requestId === undefined) return;

  const pending = pendingRouteRequests.get(requestId);
  if (!pending) return;

  // Root Cause vs Logic: route worker responses can arrive after newer renders
  // have started, so every response is matched by request id before updating UI
  // state; stale messages are ignored instead of painting old arrows.
  if (event.data.type === 'batch') {
    const batch = toRouteMap(event.data.routes);
    for (const [edgeId, route] of batch) pending.routes.set(edgeId, route);
    pending.onBatch?.({
      routed: new Map(pending.routes),
      batch,
      completed: event.data.completed,
      total: event.data.total,
    });
    return;
  }

  cleanupPending(requestId, pending);
  if (event.data.type === 'error') {
    pending.reject(new Error(event.data.error || 'Edge routing worker failed.'));
    return;
  }
  pending.resolve(new Map(pending.routes));
}

function handleWorkerError(error: ErrorEvent) {
  console.error('[EdgeRouter] Worker error:', error.message);
  resetRouterWorker(new Error(error.message || 'Edge routing worker crashed.'));
}

function getRouterWorker(): Worker {
  if (!routerWorker) {
    routerWorker = new Worker(new URL('../workers/route-worker.ts', import.meta.url), {
      type: 'module',
    });

    console.debug('[EdgeRouter] Worker instantiated');
    routerWorker.addEventListener('message', handleWorkerMessage);
    routerWorker.addEventListener('error', handleWorkerError);
  }
  return routerWorker;
}

export async function routeEdgesProgressively(
  edges: IREdge[],
  layout: LayoutResult,
  overrides: EdgeOverrides | undefined,
  edgeOffsets: Map<string, number>,
  options: ProgressiveRouteOptions = {},
): Promise<Map<string, RoutedEdgePath>> {
  if (edges.length === 0) return new Map();
  if (options.signal?.aborted) {
    throw new DOMException('Edge routing aborted.', 'AbortError');
  }

  const worker = getRouterWorker();
  const requestId = nextRequestId++;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const batchSize = Math.max(1, options.batchSize ?? 16);

  const request: RouteRequest = {
    requestId,
    edges,
    nodes: Array.from(layout.nodes.entries()),
    groups: Array.from(layout.groups.entries()),
    layoutEdges: Array.from(layout.edges.entries()),
    overrides: overrides?.edges ?? {},
    edgeOffsets: Array.from(edgeOffsets.entries()),
    batchSize,
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      resetRouterWorker(
        new Error(`Edge routing timed out after ${Math.round(timeoutMs / 1000)}s.`),
      );
    }, timeoutMs);

    const pending: PendingRouteRequest = {
      routes: new Map(),
      resolve,
      reject,
      timeoutId,
      signal: options.signal,
      onBatch: options.onBatch,
    };

    if (options.signal) {
      pending.abortHandler = () => {
        resetRouterWorker(new DOMException('Edge routing aborted.', 'AbortError') as Error);
      };
      options.signal.addEventListener('abort', pending.abortHandler, { once: true });
    }

    pendingRouteRequests.set(requestId, pending);
    try {
      worker.postMessage(request);
    } catch (err) {
      cleanupPending(requestId, pending);
      resetRouterWorker();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Compatibility wrapper for callers that still need all routes as one result.
 */
export async function routeAllEdgesAsync(
  edges: IREdge[],
  layout: LayoutResult,
  overrides: EdgeOverrides | undefined,
  edgeOffsets: Map<string, number>,
  timeoutMs = 10_000,
): Promise<Map<string, RoutedEdgePath>> {
  return routeEdgesProgressively(edges, layout, overrides, edgeOffsets, { timeoutMs });
}

/**
 * Terminate the worker when done (optional cleanup).
 * Not called automatically to reuse the worker across renders.
 */
export function terminateRouterWorker(): void {
  resetRouterWorker(new Error('Edge routing worker terminated.'));
}
