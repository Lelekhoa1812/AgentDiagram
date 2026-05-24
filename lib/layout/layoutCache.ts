/**
 * In-memory LRU cache for ELK layout results.
 *
 * Keyed by a djb2 hash of the diagram's structural data (nodes, groups, edges,
 * roots) and the layout options. Avoids rerunning the full ELK layout when the
 * DSL hasn't structurally changed (e.g. label-only edits, theme switches).
 *
 * Capacity: MAX_ENTRIES results, evicted in insertion order (oldest first).
 */
import type { Diagram } from '../ir/types';
import type { LayoutOptions, LayoutResult } from './elk';

const MAX_ENTRIES = 20;

// The cache — plain Map used as an LRU (Map insertion order is stable in V8).
const cache = new Map<string, LayoutResult>();

// ── Hash ──────────────────────────────────────────────────────────────────────
/** djb2 string hash — browser-safe, no crypto API needed. Returns unsigned int. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Computes a stable cache key from the diagram's structural shape and layout
 * options. Excludes diagnostics and volatile metadata (source text, generatedAt).
 * Node/group/edge arrays preserve source-declaration order from the compiler, so
 * JSON.stringify is stable across calls for the same DSL.
 */
export function diagramHash(diagram: Diagram, opts: LayoutOptions): string {
  const structural = {
    nodes: diagram.nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      width: n.width,
      height: n.height,
    })),
    groups: diagram.groups.map((g) => ({
      id: g.id,
      parentId: g.parentId,
      direction: g.direction,
      padding: g.padding,
      children: g.children,
    })),
    edges: diagram.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
    })),
    roots: diagram.roots,
  };
  return String(djb2(JSON.stringify(structural) + '|' + JSON.stringify(opts)));
}

// ── Cache API ─────────────────────────────────────────────────────────────────
/** Returns a cached LayoutResult and refreshes its LRU position. */
export function cacheGet(key: string): LayoutResult | undefined {
  const result = cache.get(key);
  if (result !== undefined) {
    // Refresh LRU position — delete + re-insert moves to end of insertion order
    cache.delete(key);
    cache.set(key, result);
  }
  return result;
}

/** Stores a LayoutResult, evicting the oldest entry if over capacity. */
export function cacheSet(key: string, result: LayoutResult): void {
  if (cache.has(key)) cache.delete(key); // refresh position if already present
  cache.set(key, result);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Removes all cached results. Call when node sizes change (e.g. measure changes). */
export function cacheClear(): void {
  cache.clear();
}
