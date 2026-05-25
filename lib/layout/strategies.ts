import type { Diagram } from '../ir/types';
import { layout, terminateElkWorker, type LayoutOptions, type LayoutResult } from './elk';
import { cacheGet, cacheSet, diagramHash } from './layoutCache';
import { layoutWithGraphviz, prewarmGraphvizWasm, terminateGraphvizWorker } from './graphviz';
import { layoutForceDirected } from './forceDirected';
import { diagramComplexity, getEffectiveThresholds } from './constants';

export type LayoutStrategy = 'auto' | 'layered' | 'force-lite' | 'grid-cluster' | 'manual';

export interface LayoutRunControl {
  deadlineMs?: number;
  signal?: AbortSignal;
}

function remainingBudget(deadlineMs: number | undefined, fallbackMs: number): number {
  if (deadlineMs === undefined) return fallbackMs;
  return Math.max(0, deadlineMs - Date.now());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Layout aborted.', 'AbortError');
}

function withAbortableTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (timeoutMs <= 0) {
    onTimeout?.();
    return Promise.reject(new Error(message));
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);

    if (signal) {
      abortHandler = () => {
        onTimeout?.();
        reject(new DOMException('Layout aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  });
}

export async function runLayout(
  diagram: Diagram,
  strategy: LayoutStrategy,
  opts?: LayoutOptions,
  control: LayoutRunControl = {},
): Promise<LayoutResult> {
  const resolvedOpts = resolveOpts(diagram, strategy, opts);
  const thresholds = getEffectiveThresholds();
  const { score: complexity } = diagramComplexity(diagram);

  if (complexity >= thresholds.complexityLimit * 0.65) {
    prewarmGraphvizWasm();
  }

  // ── Layout cache ─────────────────────────────────────────────────────────
  // Skip ELK entirely when the structural diagram and options are identical to
  // a previous call. This covers the common case of re-rendering after a label
  // edit, theme change, or selection that doesn't alter node/edge structure.
  const cacheKey = diagramHash(diagram, resolvedOpts);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Layout strategy escalation chain:
  // 1. ELK (with built-in 4-strategy escalation loop)
  // 2. Graphviz Wasm (preserves compound-graph semantics better than force-directed)
  // 3. Force-Directed (fast fallback for extreme complexity, may lose quality)
  let result: LayoutResult;
  try {
    const elkBudget = Math.min(
      thresholds.layoutTimeoutMs,
      remainingBudget(control.deadlineMs, thresholds.layoutTimeoutMs),
    );
    result = await withAbortableTimeout(
      layout(diagram, resolvedOpts),
      elkBudget,
      `Layout timed out after ${Math.round(elkBudget / 1000)}s.`,
      terminateElkWorker,
      control.signal,
    );
  } catch (elkErr) {
    throwIfAborted(control.signal);
    // eslint-disable-next-line no-console
    console.warn(
      '[Layout] ELK exhausted all strategies; falling back to Graphviz Wasm.',
      elkErr instanceof Error ? elkErr.message : elkErr,
    );
    try {
      const graphvizBudget = Math.min(
        thresholds.layoutTimeoutMs,
        remainingBudget(control.deadlineMs, thresholds.layoutTimeoutMs),
      );
      result = await withAbortableTimeout(
        layoutWithGraphviz(diagram, resolvedOpts, graphvizBudget),
        graphvizBudget,
        `Graphviz layout timed out after ${Math.round(graphvizBudget / 1000)}s.`,
        terminateGraphvizWorker,
        control.signal,
      );
    } catch (gvErr) {
      throwIfAborted(control.signal);
      // eslint-disable-next-line no-console
      console.warn(
        '[Layout] Graphviz also failed; falling back to Force-Directed approximation.',
        gvErr instanceof Error ? gvErr.message : gvErr,
      );
      const elementCount = diagram.nodes.length + diagram.groups.length + diagram.edges.length;
      if (elementCount > 350) {
        throw new Error(
          `Fallback layout skipped for ${elementCount} elements to keep the browser responsive.`,
        );
      }
      result = layoutForceDirected(diagram, { iterations: thresholds.forceDirectedIterations });
    }
  }

  cacheSet(cacheKey, result);
  return result;
}

/** Resolves layout options for the given strategy and diagram size. */
function resolveOpts(
  diagram: Diagram,
  strategy: LayoutStrategy,
  extra?: LayoutOptions,
): LayoutOptions {
  switch (strategy) {
    case 'auto':
      return diagram.nodes.length <= 50
        ? { direction: 'DOWN', ...extra }
        : { direction: 'DOWN', layerSpacing: 64, nodeNodeSpacing: 36, ...extra };
    case 'layered':
      return { direction: 'DOWN', ...extra };
    case 'grid-cluster':
      return { direction: 'DOWN', layerSpacing: 80, nodeNodeSpacing: 32, ...extra };
    case 'force-lite':
      // Fallback: still uses ELK but with looser layered settings
      return { direction: 'DOWN', layerSpacing: 96, nodeNodeSpacing: 48, ...extra };
    case 'manual':
      // Manual: still run a layered pass to seed positions; overrides win later.
      return { direction: 'DOWN', ...extra };
  }
}
