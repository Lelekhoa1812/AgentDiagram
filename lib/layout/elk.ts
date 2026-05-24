/**
 * ELK compound-graph layout driver.
 *
 * Builds an ELK graph from a Diagram, runs `elk.layered` with hierarchical
 * compound support and orthogonal edge routing, and produces a
 * LayoutResult with absolute positions for every node, group, and edge.
 */

import ELKApi from 'elkjs/lib/elk-api.js';
import type { ELK as ELKType } from 'elkjs/lib/elk-api.js';
import type { Diagram, Point } from '../ir/types';
import { nodeSize, groupTitleSize, edgeLabelSize } from './measure';

// Singleton — created once per browser session, reset whenever the worker crashes.
// In the browser we spin up a real Web Worker (elk-worker.min.js served from /public)
// so the layout algorithm never blocks the main thread. The bundled fallback is kept
// for SSR / test environments where Worker is unavailable.
let _elk: ELKType | null = null;
// The raw Worker reference lets us terminate it on crash and add an onerror handler.
// elk-api.js's PromisedWorker never sets worker.onerror, so a crashing worker leaves
// pending layout promises hanging forever — we add the handler here to fix that.
let _elkRawWorker: Worker | null = null;
// When the worker crashes we call this to immediately reject the in-flight layout promise.
let _elkPendingReject: ((err: Error) => void) | null = null;

function resetElk() {
  if (_elkRawWorker) {
    _elkRawWorker.terminate();
    _elkRawWorker = null;
  }
  if (_elkPendingReject) {
    _elkPendingReject(new Error('ELK worker crashed (diagram too complex or internal error)'));
    _elkPendingReject = null;
  }
  _elk = null;
}

/** Terminate the ELK worker and reject any in-flight layout call. Call this on unmount. */
export function terminateElkWorker() {
  resetElk();
}

function getElk(): ELKType {
  if (_elk) return _elk;
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    const worker = new Worker('/elk-worker.min.js');
    _elkRawWorker = worker;
    // elk-api.js never sets worker.onerror, so we do it here. When the ELK
    // network-simplex algorithm throws (e.g. "Invalid array length"), the worker
    // posts a global error that fires this handler — we reject the pending promise
    // and reset the singleton so the next layout call gets a fresh worker.
    worker.addEventListener('error', () => {
      const reject = _elkPendingReject;
      _elkPendingReject = null;
      _elkRawWorker = null;
      _elk = null;
      reject?.(new Error('ELK worker crashed — diagram is too complex to lay out'));
      worker.terminate();
    });
    _elk = new ELKApi({
      workerUrl: '/elk-worker.min.js',
      workerFactory: () => worker,
    }) as unknown as ELKType;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ELKBundled = require('elkjs/lib/elk.bundled.js').default as typeof ELKApi;
    _elk = new ELKBundled() as unknown as ELKType;
  }
  return _elk;
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  bends: Point[];
  /** Anchor points (start / end) used by renderer for arrow markers */
  start: Point;
  end: Point;
}

export interface LayoutResult {
  /** Absolute rect for nodes, indexed by IR id */
  nodes: Map<string, LayoutRect>;
  /** Absolute rect for groups, indexed by IR id */
  groups: Map<string, LayoutRect>;
  edges: Map<string, LayoutEdge>;
  bbox: { x: number; y: number; width: number; height: number };
}

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  labels?: Array<{ text: string; width?: number; height?: number }>;
  layoutOptions?: Record<string, string>;
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: Array<{ text: string; width?: number; height?: number }>;
}

interface ElkLayoutNode extends ElkNode {
  x?: number;
  y?: number;
  children?: ElkLayoutNode[];
  edges?: ElkLayoutEdge[];
}

interface ElkLayoutEdge extends ElkEdge {
  sections?: Array<{
    startPoint: Point;
    endPoint: Point;
    bendPoints?: Point[];
  }>;
}

export interface LayoutOptions {
  /** Layout direction */
  direction?: 'DOWN' | 'RIGHT';
  /** Spacing between nodes inside a layer */
  nodeNodeSpacing?: number;
  /** Spacing between layers */
  layerSpacing?: number;
  /** Padding inside groups */
  groupPadding?: number;
}

const DEFAULT_OPTS: Required<LayoutOptions> = {
  direction: 'DOWN',
  nodeNodeSpacing: 28,
  layerSpacing: 48,
  groupPadding: 28,
};

export async function layout(diagram: Diagram, opts: LayoutOptions = {}): Promise<LayoutResult> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Compute graph complexity (groups × edges) to choose a safe node-placement
  // strategy. ELK's NETWORK_SIMPLEX has quadratic memory usage on compound graphs
  // and throws "Invalid array length" above ~200–260. BRANDES_KOEPF handles
  // moderate complexity well; SIMPLE is a safe fallback for very dense diagrams.
  const complexity = diagram.groups.length * diagram.edges.length;
  // Switch away from NETWORK_SIMPLEX early — anything in the 100–200 band
  // (diagrams near the ELK_COMPLEXITY_LIMIT guard) gets BRANDES_KOEPF which is
  // more stable in compound graphs. Below 100 NETWORK_SIMPLEX gives best quality.
  const nodePlacementStrategy =
    complexity > 100 ? 'BRANDES_KOEPF' : 'NETWORK_SIMPLEX';

  // Build a quick lookup for groups so we can recurse children → ELK nodes.
  const groupsById = new Map(diagram.groups.map((g) => [g.id, g]));
  const nodesById = new Map(diagram.nodes.map((n) => [n.id, n]));

  function buildChildren(parentChildren: string[]): ElkNode[] {
    const out: ElkNode[] = [];
    for (const id of parentChildren) {
      const grp = groupsById.get(id);
      if (grp) {
        const title = (grp.label ?? grp.name).toUpperCase();
        const titleSize = groupTitleSize(title);
        out.push({
          id: grp.id,
          children: buildChildren(grp.children),
          labels: [{ text: title, width: titleSize.width, height: titleSize.height }],
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': (grp.direction ?? o.direction).toString(),
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.padding': `[top=${grp.padding + 18},left=${grp.padding},bottom=${grp.padding},right=${grp.padding}]`,
            'elk.spacing.nodeNode': `${o.nodeNodeSpacing}`,
            'elk.layered.spacing.nodeNodeBetweenLayers': `${o.layerSpacing}`,
            'elk.edgeRouting': 'ORTHOGONAL',
          },
        });
        continue;
      }
      const node = nodesById.get(id);
      if (node) {
        const sz = nodeSize(node.label ?? node.name);
        out.push({
          id: node.id,
          width: node.width ?? sz.width,
          height: node.height ?? sz.height,
        });
      }
    }
    return out;
  }

  const rootChildren = buildChildren(diagram.roots);
  const elkEdges: ElkEdge[] = diagram.edges.map((e) => {
    const labelSize = e.label ? edgeLabelSize(e.label) : null;
    return {
      id: e.id,
      sources: [e.source],
      targets: [e.target],
      labels: e.label && labelSize ? [{ text: e.label, width: labelSize.width, height: labelSize.height }] : undefined,
    };
  });

  const elkGraph: ElkNode = {
    id: 'root',
    children: rootChildren,
    edges: elkEdges,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': o.direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': `${o.nodeNodeSpacing}`,
      'elk.layered.spacing.nodeNodeBetweenLayers': `${o.layerSpacing}`,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': `[top=24,left=24,bottom=24,right=24]`,
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.nodePlacement.strategy': nodePlacementStrategy,
      // DEPTH_FIRST cycle-breaking is more stable on complex diagrams with back-edges.
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
    },
  };

  const elk = getElk();
  // Wrap the layout call with a crash-rejection promise. If the ELK worker dies
  // (e.g. "Invalid array length" RangeError inside the worker), the onerror
  // handler set in getElk() fires _elkPendingReject, which immediately rejects
  // this promise — otherwise it would hang until the 5s timeout in DiagramCanvas.
  const crashPromise = new Promise<never>((_, reject) => {
    _elkPendingReject = reject;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const laid = (await Promise.race([elk.layout(elkGraph as any), crashPromise])) as ElkLayoutNode;
  _elkPendingReject = null;

  const result: LayoutResult = {
    nodes: new Map(),
    groups: new Map(),
    edges: new Map(),
    bbox: { x: 0, y: 0, width: 0, height: 0 },
  };

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  function walk(node: ElkLayoutNode, ox: number, oy: number) {
    const x = (node.x ?? 0) + ox;
    const y = (node.y ?? 0) + oy;
    const w = node.width ?? 0;
    const h = node.height ?? 0;
    const isGroup = groupsById.has(node.id);
    const rect: LayoutRect = { x, y, width: w, height: h };
    if (node.id !== 'root') {
      if (isGroup) result.groups.set(node.id, rect);
      else result.nodes.set(node.id, rect);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    for (const child of node.children ?? []) walk(child, x, y);
    for (const edge of node.edges ?? []) {
      const sec = edge.sections?.[0];
      if (!sec) continue;
      result.edges.set(edge.id, {
        id: edge.id,
        source: edge.sources[0] ?? '',
        target: edge.targets[0] ?? '',
        bends: sec.bendPoints?.map((p) => ({ x: p.x + x, y: p.y + y })) ?? [],
        start: { x: sec.startPoint.x + x, y: sec.startPoint.y + y },
        end: { x: sec.endPoint.x + x, y: sec.endPoint.y + y },
      });
    }
  }

  walk(laid, 0, 0);

  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = laid.width ?? 800;
    maxY = laid.height ?? 600;
  }

  result.bbox = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return result;
}
