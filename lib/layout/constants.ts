/**
 * Layout constants — single source of truth.
 *
 * Previously each of these values was declared independently in:
 *   - components/diagram/DiagramCanvas.tsx  (render guards)
 *   - lib/layout/elk.ts                     (strategy selection)
 *   - lib/agent/repair.ts                   (AI repair triggers)
 *   - lib/agent/planning/splitLayer.ts               (partition sizing)
 *
 * Any threshold change now only needs one edit here.
 *
 * Tier 5 Enhancement: Adaptive thresholds based on device capacity.
 * Use detectDeviceCapacity() and getAdaptiveThresholds() for device-aware scaling.
 */
import type { Diagram } from '../ir/types';
import { detectDeviceCapacity, getAdaptiveThresholds, type AdaptiveThresholds } from '../render/deviceCapacity';
export { RENDER_TIMEOUT_MS } from '../render/deviceCapacity';

// ── Timeouts ───────────────────────────────────────────────────────────────────
/** How long to wait for one layout engine attempt before escalating.
 *  The canvas-level render budget remains RENDER_TIMEOUT_MS. */
export const LAYOUT_TIMEOUT_MS = 8_000;

// ── ELK safety limits ──────────────────────────────────────────────────────────
/** ELK's network-simplex throws "Invalid array length" above this raw edge count. */
export const ELK_EDGE_LIMIT = 80;

/** Maximum diagramComplexity() score before we reject layout pre-emptively.
 *  Uses the cross-group × depth metric — see diagramComplexity() for calibration notes. */
export const ELK_COMPLEXITY_LIMIT = 150;

// ── Complexity metric ──────────────────────────────────────────────────────────
/**
 * Returns a complexity score that accurately reflects ELK compound-graph difficulty.
 *
 * Formula: crossGroupEdgeCount × (1 + maxNestingDepth)
 *
 *  - crossGroupEdgeCount: edges whose endpoints belong to different top-level groups.
 *    Pure intra-group edges do not stress ELK's network-simplex at all.
 *  - maxNestingDepth: deepest group nesting in the diagram (0 = completely flat).
 *    Deep nesting amplifies the cost of every cross-group edge.
 *
 * Calibration vs. the old `groups × edges` proxy:
 *   Old failing case: 7 groups × 42 edges = 294 → blocked at 200.
 *   New metric examples for the same 42-edge diagram:
 *     • All intra-group edges        → score =   0  (renders fine)
 *     • 42 cross-group, depth 0      → score =  42  (renders fine)
 *     • 42 cross-group, depth 1      → score =  84  (renders fine)
 *     • 42 cross-group, depth 2      → score = 126  (renders fine)
 *     • 50 cross-group, depth 2      → score = 150  (blocked at limit)
 */
export function diagramComplexity(diagram: Diagram): {
  /** The combined complexity score (compared against ELK_COMPLEXITY_LIMIT). */
  score: number;
  /** Number of edges whose endpoints live in different top-level groups. */
  crossGroupEdges: number;
  /** Deepest group nesting level (0 = flat diagram). */
  maxDepth: number;
} {
  if (diagram.groups.length === 0 || diagram.edges.length === 0) {
    return { score: 0, crossGroupEdges: 0, maxDepth: 0 };
  }

  const groupById = new Map(diagram.groups.map((g) => [g.id, g]));
  const nodeById  = new Map(diagram.nodes.map((n) => [n.id, n]));

  /** Walk the parentId chain to find the root-level group for any group id. */
  function topAncestorGroup(groupId: string): string {
    let current = groupId;
    for (;;) {
      const grp = groupById.get(current);
      if (!grp || grp.parentId === null) return current;
      current = grp.parentId;
    }
  }

  /**
   * Returns the top-level group ancestor of any node or group id.
   * Root-level nodes (parentId === null) return their own id so they never
   * accidentally match a sibling group.
   */
  function topAncestor(id: string): string {
    const node = nodeById.get(id);
    if (node) return node.parentId === null ? id : topAncestorGroup(node.parentId);
    return topAncestorGroup(id);
  }

  // ── Count cross-group edges ──────────────────────────────────────────────
  let crossGroupEdges = 0;
  for (const edge of diagram.edges) {
    if (topAncestor(edge.source) !== topAncestor(edge.target)) crossGroupEdges++;
  }

  // ── Compute max nesting depth ─────────────────────────────────────────────
  const depthCache = new Map<string, number>();
  function depth(groupId: string): number {
    const cached = depthCache.get(groupId);
    if (cached !== undefined) return cached;
    const grp = groupById.get(groupId);
    const d =
      grp?.parentId === null || grp?.parentId === undefined ? 0 : 1 + depth(grp.parentId);
    depthCache.set(groupId, d);
    return d;
  }
  let maxDepth = 0;
  for (const group of diagram.groups) maxDepth = Math.max(maxDepth, depth(group.id));

  return { score: crossGroupEdges * (1 + maxDepth), crossGroupEdges, maxDepth };
}

// ── Adaptive Thresholds (Tier 5) ───────────────────────────────────────────
/**
 * Cached device capacity and adaptive thresholds.
 * Initialized on first call and reused throughout the session.
 */
let cachedDevice: ReturnType<typeof detectDeviceCapacity> | null = null;
let cachedThresholds: AdaptiveThresholds | null = null;

/**
 * Get adaptive layout thresholds based on current device capacity.
 * Caches results to avoid repeated detection.
 *
 * Returns different limits for:
 *   - Low-end devices (≤2 cores, ≤4GB): conservative limits for responsiveness
 *   - Mid-range devices: balanced limits
 *   - High-end devices (≥8 cores, ≥16GB): aggressive limits to maximize capability
 *
 * Use this instead of the static LAYOUT_TIMEOUT_MS, ELK_EDGE_LIMIT, etc.
 * for diagrams that need to scale based on device capabilities.
 */
export function getEffectiveThresholds(): AdaptiveThresholds {
  if (cachedThresholds === null) {
    cachedDevice = detectDeviceCapacity();
    cachedThresholds = getAdaptiveThresholds(cachedDevice);
  }
  return cachedThresholds;
}

/**
 * Get the detected device capacity (CPU cores, RAM).
 * Useful for logging and diagnostics.
 */
export function getDetectedDevice(): ReturnType<typeof detectDeviceCapacity> {
  if (cachedDevice === null) {
    cachedDevice = detectDeviceCapacity();
    cachedThresholds = getAdaptiveThresholds(cachedDevice);
  }
  return cachedDevice;
}
