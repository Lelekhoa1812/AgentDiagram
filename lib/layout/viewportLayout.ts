/**
 * Viewport-First Layout & Progressive Rendering
 *
 * Identifies visible elements in the current viewport and prioritizes their
 * layout and routing, enabling rapid initial render followed by asynchronous
 * quality refinement for off-screen elements.
 */

import type { Diagram, IREdge } from '../ir/types';
import type { LayoutResult, LayoutRect } from './elk';

export interface ViewportInfo {
  x: number;
  y: number;
  scale: number;
  containerW: number;
  containerH: number;
}

/**
 * Get the visible bounding box in diagram-space (accounting for pan/zoom).
 */
function getVisibleBbox(viewport: ViewportInfo): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const visX = -viewport.x / viewport.scale;
  const visY = -viewport.y / viewport.scale;
  const visW = viewport.containerW / viewport.scale;
  const visH = viewport.containerH / viewport.scale;

  return {
    minX: visX,
    maxX: visX + visW,
    minY: visY,
    maxY: visY + visH,
  };
}

/**
 * Check if a rectangle is visible in the viewport (with margin for safe buffer).
 */
function isVisible(rect: LayoutRect, bbox: ReturnType<typeof getVisibleBbox>, margin: number): boolean {
  return (
    rect.x + rect.width + margin > bbox.minX &&
    rect.x - margin < bbox.maxX &&
    rect.y + rect.height + margin > bbox.minY &&
    rect.y - margin < bbox.maxY
  );
}

/**
 * Check if an edge's bounding box intersects the visible region.
 */
function edgeBboxIntersects(
  sourceRect: LayoutRect,
  targetRect: LayoutRect,
  bbox: ReturnType<typeof getVisibleBbox>,
  margin: number,
): boolean {
  const edgeMinX = Math.min(sourceRect.x, targetRect.x) - margin;
  const edgeMaxX = Math.max(sourceRect.x + sourceRect.width, targetRect.x + targetRect.width) + margin;
  const edgeMinY = Math.min(sourceRect.y, targetRect.y) - margin;
  const edgeMaxY = Math.max(sourceRect.y + sourceRect.height, targetRect.y + targetRect.height) + margin;

  return (
    edgeMaxX > bbox.minX &&
    edgeMinX < bbox.maxX &&
    edgeMaxY > bbox.minY &&
    edgeMinY < bbox.maxY
  );
}

/**
 * Identify visible and culled elements based on viewport.
 * Margin extends the visible region slightly to include connecting edges.
 */
export function getVisibleElements(
  layout: LayoutResult,
  viewport: ViewportInfo,
  margin: number = 200,
): {
  visibleNodeIds: Set<string>;
  visibleGroupIds: Set<string>;
  visibleEdgeIds: Set<string>;
  culledEdgeIds: Set<string>;
} {
  const bbox = getVisibleBbox(viewport);
  const visibleNodeIds = new Set<string>();
  const visibleGroupIds = new Set<string>();
  const visibleEdgeIds = new Set<string>();
  const culledEdgeIds = new Set<string>();

  // Identify visible nodes and groups
  for (const [nodeId, rect] of layout.nodes) {
    if (isVisible(rect, bbox, margin)) {
      visibleNodeIds.add(nodeId);
    }
  }

  for (const [groupId, rect] of layout.groups) {
    if (isVisible(rect, bbox, margin)) {
      visibleGroupIds.add(groupId);
    }
  }

  // Identify visible and culled edges
  for (const edge of layout.edges.keys()) {
    const layoutEdge = layout.edges.get(edge);
    if (!layoutEdge) continue;

    const sourceNode = layout.nodes.get(layoutEdge.source);
    const targetNode = layout.nodes.get(layoutEdge.target);
    if (!sourceNode || !targetNode) continue;

    // Edge is visible if:
    // 1. Both endpoints are visible, OR
    // 2. At least one endpoint is visible, OR
    // 3. The edge's bbox intersects the visible region
    const sourceVisible = visibleNodeIds.has(layoutEdge.source);
    const targetVisible = visibleNodeIds.has(layoutEdge.target);

    if (
      sourceVisible ||
      targetVisible ||
      edgeBboxIntersects(sourceNode, targetNode, bbox, margin)
    ) {
      visibleEdgeIds.add(edge);
    } else {
      culledEdgeIds.add(edge);
    }
  }

  return {
    visibleNodeIds,
    visibleGroupIds,
    visibleEdgeIds,
    culledEdgeIds,
  };
}

/**
 * Split diagram into high-priority (visible) and low-priority (culled) subsets.
 * Useful for multi-phase layout or routing strategies.
 */
export function prioritizeLayout(
  diagram: Diagram,
  visibleNodeIds: Set<string>,
  visibleEdgeIds: Set<string>,
): {
  highPriority: Diagram;
  lowPriority: Diagram;
} {
  const highNodes = diagram.nodes.filter((n) => visibleNodeIds.has(n.id));
  const lowNodes = diagram.nodes.filter((n) => !visibleNodeIds.has(n.id));

  const highEdges = diagram.edges.filter((e) => visibleEdgeIds.has(e.id));
  const lowEdges = diagram.edges.filter((e) => !visibleEdgeIds.has(e.id));

  return {
    highPriority: {
      ...diagram,
      nodes: highNodes,
      edges: highEdges,
    },
    lowPriority: {
      ...diagram,
      nodes: lowNodes,
      edges: lowEdges,
    },
  };
}
