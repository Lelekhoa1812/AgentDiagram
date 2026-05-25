import type { IREdge } from '../ir/types';
import type { LayoutResult } from '../layout/elk';
import type { RoutedEdgePath } from './edgePath';

export function validateCompletedRoutes(
  edges: readonly IREdge[],
  layout: LayoutResult,
  routedEdges: Map<string, RoutedEdgePath>,
): string[] {
  const errors: string[] = [];

  for (const edge of edges) {
    const sourceRect = layout.nodes.get(edge.source) ?? layout.groups.get(edge.source);
    const targetRect = layout.nodes.get(edge.target) ?? layout.groups.get(edge.target);
    const routed = routedEdges.get(edge.id);

    if (!sourceRect || !targetRect) {
      errors.push(
        `Edge ${edge.id} cannot connect ${edge.source} to ${edge.target}: missing endpoint layout.`,
      );
      continue;
    }
    if (!routed?.path || routed.points.length < 2) {
      errors.push(`Edge ${edge.id} did not produce a complete routed path.`);
      continue;
    }
    if (!Number.isFinite(routed.labelPoint.x) || !Number.isFinite(routed.labelPoint.y)) {
      errors.push(`Edge ${edge.id} produced an invalid label position.`);
    }
  }

  return errors;
}
