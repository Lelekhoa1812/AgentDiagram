/**
 * splitLayer.ts — splits a complex Diagram IR into multiple LayerDiagram objects,
 * each guaranteed to be within ELK's complexity limit.
 *
 * The split is structural (no AI call): top-level root elements are distributed
 * across partitions round-robin, and only intra-partition edges are kept in each
 * sub-diagram. Cross-partition connections that are dropped are recorded as DSL
 * comments (// cross-ref: …) at the end of each sub-layer so users and the AI
 * repair agent can understand dependencies across partitions.
 *
 * Complexity constants are defined in lib/layout/constants.ts (single source of truth).
 */

import { formatDiagram } from '../../dsl/formatter';
import type { Diagram } from '../../ir/types';
import type { LayerDiagram } from '../../state/projectStorage';
import { ELK_COMPLEXITY_LIMIT, diagramComplexity } from '../../layout/constants';

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
  // Use the accurate cross-group × depth complexity metric. After a k-way split,
  // cross-partition edges are dropped, so the score decreases faster than
  // proportionally. ceil(score / limit) partitions is a safe conservative estimate.
  const { score: complexityScore } = diagramComplexity(diagram);
  // Fall back to a minimum of 2 even if the score is within limit — we're here
  // precisely because something is wrong and splitting was explicitly requested.
  const needed = Math.max(2, Math.ceil(complexityScore / ELK_COMPLEXITY_LIMIT));
  // Clamp: at least 2, at most 10, never more partitions than roots
  const k = Math.max(2, Math.min(10, needed, roots.length));

  // ── Round-robin assignment of roots → partitions ──────────────────────────
  const buckets: string[][] = Array.from({ length: k }, () => []);
  roots.forEach((id, i) => { buckets[i % k]!.push(id); });

  const nonEmpty = buckets.filter((b) => b.length > 0);

  // ── Build ID → display name lookup (used for cross-ref comments) ─────────
  const nameById = new Map<string, string>([
    ...diagram.nodes.map((n): [string, string] => [n.id, n.label ?? n.name]),
    ...diagram.groups.map((g): [string, string] => [g.id, g.label ?? g.name]),
  ]);

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

    // ── Cross-partition edge annotations ──────────────────────────────────
    // Dropped edges (those spanning this partition and another) are preserved as
    // DSL comments. This allows users and the AI repair agent to understand the
    // full dependency graph without re-examining the original diagram.
    const crossRefLines: string[] = [];
    for (const e of diagram.edges) {
      const srcIn = allIds.has(e.source);
      const tgtIn = allIds.has(e.target);
      if (srcIn === tgtIn) continue; // both inside or both outside — skip
      const srcName = nameById.get(e.source) ?? e.source;
      const tgtName = nameById.get(e.target) ?? e.target;
      crossRefLines.push(`// cross-ref: ${srcName} → ${tgtName} (other partition)`);
    }

    const baseDsl = formatDiagram(subDiagram).trim();
    const dsl =
      crossRefLines.length > 0
        ? `${baseDsl}\n\n// ── Cross-partition references (informational, not rendered) ──\n${crossRefLines.join('\n')}`
        : baseDsl;

    return {
      name: `${baseLayerName} #${idx + 1}`,
      description: `Part ${idx + 1} of ${nonEmpty.length} — split from "${baseLayerName}"`,
      dsl,
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
