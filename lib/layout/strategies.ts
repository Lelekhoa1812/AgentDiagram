import type { Diagram } from '../ir/types';
import { layout, type LayoutOptions, type LayoutResult } from './elk';
import { cacheGet, cacheSet, diagramHash } from './layoutCache';
import { layoutWithGraphviz } from './graphviz';
import { layoutForceDirected } from './forceDirected';

export type LayoutStrategy = 'auto' | 'layered' | 'force-lite' | 'grid-cluster' | 'manual';

export async function runLayout(
  diagram: Diagram,
  strategy: LayoutStrategy,
  opts?: LayoutOptions,
): Promise<LayoutResult> {
  const resolvedOpts = resolveOpts(diagram, strategy, opts);

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
    result = await layout(diagram, resolvedOpts);
  } catch (elkErr) {
    // eslint-disable-next-line no-console
    console.warn(
      '[Layout] ELK exhausted all strategies; falling back to Graphviz Wasm.',
      elkErr instanceof Error ? elkErr.message : elkErr,
    );
    try {
      result = await layoutWithGraphviz(diagram, resolvedOpts);
    } catch (gvErr) {
      // eslint-disable-next-line no-console
      console.warn(
        '[Layout] Graphviz also failed; falling back to Force-Directed approximation.',
        gvErr instanceof Error ? gvErr.message : gvErr,
      );
      // Force-directed is synchronous and doesn't throw — provides best-effort layout
      result = layoutForceDirected(diagram);
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
