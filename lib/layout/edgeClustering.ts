/**
 * Edge Clustering for Complexity Reduction
 *
 * Groups edges by structural similarity to reduce the effective edge count
 * sent to the layout engine. Multiple edges between the same node pair are
 * collapsed into a single representative edge during layout; all originals
 * get positioned in the final LayoutResult.
 *
 * Supports three aggressiveness levels:
 *   - mild: cluster only edges between same node pair
 *   - moderate: cluster by group pair + bidirectional edges
 *   - aggressive: cluster all related edges, preserve direction via styling
 */

import type { Diagram, IREdge } from '../ir/types';

export interface EdgeCluster {
  representativeId: string; // The edge drawn; others are bundled
  originalEdgeIds: string[]; // All edges in this cluster
  type: 'same-node-pair' | 'same-group-pair' | 'related-path';
  multiplicity: number; // Total edges in cluster
}

export type AggressivenessLevel = 'mild' | 'moderate' | 'aggressive';

/**
 * Find the top-level group ancestor of a node.
 */
function topGroupAncestor(nodeId: string, diagram: Diagram): string {
  const nodeById = new Map(diagram.nodes.map((n) => [n.id, n]));
  const groupById = new Map(diagram.groups.map((g) => [g.id, g]));

  let current = nodeId;
  for (;;) {
    const node = nodeById.get(current);
    if (node && node.parentId) {
      current = node.parentId;
      // Walk up group hierarchy
      for (;;) {
        const grp = groupById.get(current);
        if (!grp || !grp.parentId) return current;
        current = grp.parentId;
      }
    }
    return current;
  }
}

/**
 * Cluster edges based on aggressiveness level.
 *
 * Mild (score 100-200):
 *   Cluster only edges between the same two nodes.
 *   Minimal reduction; preserves all edge relationships.
 *
 * Moderate (score 200-250):
 *   Cluster by group pair + bidirectional edge merging.
 *   Merges e.g. "A→B" and "B→A" as a single undirected edge.
 *   Reduces count significantly without losing group-level topology.
 *
 * Aggressive (score > 250):
 *   Cluster all edges with same group ancestors, preserving direction via styling.
 *   May lose some edge-level detail but dramatically reduces complexity.
 */
export function clusterEdges(
  diagram: Diagram,
  aggressiveness: AggressivenessLevel,
): {
  clusters: EdgeCluster[];
  edgeToCluster: Map<string, string>; // edgeId → clusterRepresentativeId
  effectiveEdgeCount: number;
} {
  const edgeToCluster = new Map<string, string>();
  const clusters: EdgeCluster[] = [];
  const seen = new Set<string>();

  if (aggressiveness === 'mild') {
    // Mild: cluster by (source, target) node pair
    const pairMap = new Map<string, IREdge[]>();
    for (const edge of diagram.edges) {
      const pair = `${edge.source}|${edge.target}`;
      if (!pairMap.has(pair)) pairMap.set(pair, []);
      pairMap.get(pair)!.push(edge);
    }

    for (const [_pair, edges] of pairMap) {
      const representative = edges[0];
      if (!representative) continue;
      const cluster: EdgeCluster = {
        representativeId: representative.id,
        originalEdgeIds: edges.map((e) => e.id),
        type: 'same-node-pair',
        multiplicity: edges.length,
      };
      clusters.push(cluster);

      for (const edge of edges) {
        edgeToCluster.set(edge.id, representative.id);
      }
    }
  } else if (aggressiveness === 'moderate') {
    // Moderate: cluster by group pair + bidirectional merging
    const pairMap = new Map<string, IREdge[]>();
    for (const edge of diagram.edges) {
      const sourceGroup = topGroupAncestor(edge.source, diagram);
      const targetGroup = topGroupAncestor(edge.target, diagram);
      // Normalize pair order for bidirectional merging (A|B same as B|A)
      const pair =
        sourceGroup < targetGroup
          ? `${sourceGroup}|${targetGroup}`
          : `${targetGroup}|${sourceGroup}`;
      if (!pairMap.has(pair)) pairMap.set(pair, []);
      pairMap.get(pair)!.push(edge);
    }

    for (const [_pair, edges] of pairMap) {
      const representative = edges[0];
      if (!representative) continue;
      const cluster: EdgeCluster = {
        representativeId: representative.id,
        originalEdgeIds: edges.map((e) => e.id),
        type: 'same-group-pair',
        multiplicity: edges.length,
      };
      clusters.push(cluster);

      for (const edge of edges) {
        edgeToCluster.set(edge.id, representative.id);
      }
    }
  } else {
    // Aggressive: cluster all edges with same group ancestors
    // Preserves direction via styling (thicker/styled lines)
    const pathMap = new Map<string, IREdge[]>();
    for (const edge of diagram.edges) {
      const sourceGroup = topGroupAncestor(edge.source, diagram);
      const targetGroup = topGroupAncestor(edge.target, diagram);
      const path = `${sourceGroup}->${targetGroup}`;
      if (!pathMap.has(path)) pathMap.set(path, []);
      pathMap.get(path)!.push(edge);
    }

    for (const [_path, edges] of pathMap) {
      const representative = edges[0];
      if (!representative) continue;
      const cluster: EdgeCluster = {
        representativeId: representative.id,
        originalEdgeIds: edges.map((e) => e.id),
        type: 'related-path',
        multiplicity: edges.length,
      };
      clusters.push(cluster);

      for (const edge of edges) {
        edgeToCluster.set(edge.id, representative.id);
      }
    }
  }

  return {
    clusters,
    edgeToCluster,
    effectiveEdgeCount: clusters.length,
  };
}

/**
 * Get clustering strategy based on diagram complexity score.
 * Returns the aggressiveness level and bundle visibility penalty (opacity reduction).
 */
export function getClusteringStrategy(
  complexityScore: number,
): {
  aggressiveness: AggressivenessLevel;
  visibilityPenalty: number; // Opacity reduction for bundled edges (0-0.5)
} {
  if (complexityScore < 100) {
    return { aggressiveness: 'mild', visibilityPenalty: 0 };
  } else if (complexityScore < 200) {
    return { aggressiveness: 'mild', visibilityPenalty: 0.05 };
  } else if (complexityScore < 250) {
    return { aggressiveness: 'moderate', visibilityPenalty: 0.1 };
  } else {
    return { aggressiveness: 'aggressive', visibilityPenalty: 0.2 };
  }
}
