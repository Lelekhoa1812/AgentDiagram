/**
 * splitLayer.ts — splits a complex Diagram IR into multiple LayerDiagram objects,
 * each guaranteed to be within ELK's complexity limit.
 *
 * The split is structural (no AI call): top-level root elements are distributed
 * across partitions round-robin, and only intra-partition edges are kept in each
 * sub-diagram. Cross-partition connections are intentionally dropped to reduce
 * complexity.
 *
 * Must stay in sync with ELK_COMPLEXITY_LIMIT in DiagramCanvas.tsx.
 */

import { formatDiagram } from '../dsl/formatter';
import type { Diagram } from '../ir/types';
import type { LayerDiagram } from '../state/projectStorage';

// Mirror of DiagramCanvas.tsx's ELK_COMPLEXITY_LIMIT.
const ELK_COMPLEXITY_LIMIT = 200;

/**
 * Splits `diagram` into 2–10 sub-layer diagrams.
 * Each sub-diagram is named `"${baseLayerName} #N"`.
 *
 * @param diagram     The compiled IR (must have groups/nodes/edges populated).
 * @param baseLayerName  The display name of the current layer (e.g. "Frontend and UX Flow").
 * @returns           Array of LayerDiagram objects ready to be added to multiLayer.layers.
 */
export function splitDiagramIntoLayers(
  diagram: Diagram,
  baseLayerName: string,
): LayerDiagram[] {
  const roots = diagram.roots;

  if (roots.length < 2) {
    // Nothing meaningful to split — return original as a single sub-layer
    return [
      {
        name: `${baseLayerName} #1`,
        description: `Sub-layer 1 of 1 — split from "${baseLayerName}"`,
        dsl: formatDiagram(diagram),
      },
    ];
  }

  // ── Determine how many partitions we need ──────────────────────────────────
  // ELK complexity = groups × edges. After a k-way split, each partition
  // gets ≈ groups/k groups and (in the worst case) all E edges. We therefore
  // want (groups/k) × E < limit  ⟹  k > groups × E / limit.
  // Using total group count (including nested) gives the tightest bound.
  const G = Math.max(diagram.groups.length, roots.length);
  const E = diagram.edges.length;
  const needed = Math.ceil((G * E) / ELK_COMPLEXITY_LIMIT);
  // Clamp: at least 2, at most 10, never more partitions than roots
  const k = Math.max(2, Math.min(10, needed, roots.length));

  // ── Round-robin assignment of roots → partitions ──────────────────────────
  const buckets: string[][] = Array.from({ length: k }, () => []);
  roots.forEach((id, i) => { buckets[i % k]!.push(id); });

  const nonEmpty = buckets.filter((b) => b.length > 0);

  // ── Build one LayerDiagram per partition ──────────────────────────────────
  return nonEmpty.map((rootIds, idx) => {
    const rootSet = new Set(rootIds);

    // Gather every descendant ID (groups + nodes) reachable from this partition
    const allIds = new Set<string>();
    for (const rootId of rootIds) {
      collectDescendants(diagram, rootId, allIds);
    }

    // Construct a sub-Diagram that formatDiagram can serialise
    const subDiagram: Diagram = {
      meta: { ...diagram.meta },
      groups: diagram.groups.filter((g) => allIds.has(g.id)),
      nodes: diagram.nodes.filter((n) => allIds.has(n.id)),
      // Only keep edges where BOTH endpoints are inside this partition
      edges: diagram.edges.filter((e) => allIds.has(e.source) && allIds.has(e.target)),
      // Preserve original root ordering, filtered to this partition's roots
      roots: diagram.roots.filter((id) => rootSet.has(id)),
      diagnostics: [],
    };

    return {
      name: `${baseLayerName} #${idx + 1}`,
      description: `Part ${idx + 1} of ${nonEmpty.length} — split from "${baseLayerName}"`,
      dsl: formatDiagram(subDiagram).trim(),
    };
  });
}

/** Recursively collects the given node/group ID and all its descendants. */
function collectDescendants(diagram: Diagram, id: string, out: Set<string>): void {
  out.add(id);
  const group = diagram.groups.find((g) => g.id === id);
  if (!group) return; // leaf node — nothing more to traverse
  for (const childId of group.children) {
    collectDescendants(diagram, childId, out);
  }
}
