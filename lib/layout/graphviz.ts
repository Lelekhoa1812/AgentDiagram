/**
 * Graphviz Wasm layout fallback (T3-2).
 *
 * Used as the final fallback in strategies.ts when all 4 ELK escalation
 * strategies (T1-4) fail. Converts the Diagram IR to DOT format, runs
 * Graphviz's `dot` algorithm via WASM, parses the `plain` output to extract
 * node and edge positions, and returns a LayoutResult in the same shape as
 * ELK's layout() output.
 *
 * The WASM bundle (~780 KB) is dynamically imported so it is not included in
 * the main chunk and only downloads on first ELK failure.
 *
 * Coordinate system note:
 *   Graphviz works in inches (72 pt/inch). Node positions are CENTER coords
 *   with y=0 at the BOTTOM of the graph. We multiply by GV_TO_PX=72 and
 *   flip the y-axis to match our pixel-based top-left-origin coordinate system.
 */

import type { Diagram } from '../ir/types';
import type { LayoutOptions, LayoutResult, LayoutRect } from './elk';
import { nodeSize } from './measure';

/** Points per inch — used to convert Graphviz inch coordinates to pixels. */
const GV_TO_PX = 72;

/** Pixels reserved for the group title bar (matches svgScene.tsx rendering). */
const GROUP_TITLE_H = 28;

/** Padding inside each group's bounding box (matches ELK DEFAULT_OPTS.groupPadding). */
const GROUP_PAD = 28;

// ── DOT format emitter ────────────────────────────────────────────────────────

/** Wraps any string in DOT-safe double-quotes, escaping internal quotes. */
function dotStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildDot(diagram: Diagram, opts: LayoutOptions): string {
  const direction = opts.direction === 'RIGHT' ? 'LR' : 'TB';
  const nodeSep   = ((opts.nodeNodeSpacing ?? 28) / GV_TO_PX).toFixed(4);
  const rankSep   = ((opts.layerSpacing ?? 48)    / GV_TO_PX).toFixed(4);

  const lines: string[] = [
    `digraph G {`,
    `  graph [rankdir=${direction} nodesep=${nodeSep} ranksep=${rankSep} splines=ortho];`,
    `  node [fixedsize=true shape=box];`,
  ];

  const groupById = new Map(diagram.groups.map((g) => [g.id, g]));
  const nodeById  = new Map(diagram.nodes.map((n) => [n.id, n]));

  function emitGroup(groupId: string, indent: string): void {
    const g = groupById.get(groupId);
    if (!g) return;
    const title = (g.label ?? g.name).toUpperCase();
    lines.push(`${indent}subgraph cluster_${dotStr(groupId)} {`);
    lines.push(`${indent}  label=${dotStr(title)};`);
    // Recursively emit children
    for (const childId of g.children) {
      if (groupById.has(childId)) {
        emitGroup(childId, indent + '  ');
      } else {
        emitNode(childId, indent + '  ');
      }
    }
    lines.push(`${indent}}`);
  }

  function emitNode(nodeId: string, indent: string): void {
    const n = nodeById.get(nodeId);
    if (!n) return;
    const label = n.label ?? n.name;
    const sz    = nodeSize(label);
    const wIn   = (sz.width  / GV_TO_PX).toFixed(4);
    const hIn   = (sz.height / GV_TO_PX).toFixed(4);
    lines.push(`${indent}${dotStr(nodeId)} [label=${dotStr(label)} width=${wIn} height=${hIn}];`);
  }

  // Emit root elements in source order
  for (const rootId of diagram.roots) {
    if (groupById.has(rootId)) {
      emitGroup(rootId, '  ');
    } else {
      emitNode(rootId, '  ');
    }
  }

  // Emit edges
  for (const edge of diagram.edges) {
    const labelAttr = edge.label ? ` label=${dotStr(edge.label)}` : '';
    lines.push(`  ${dotStr(edge.source)} -> ${dotStr(edge.target)} [${labelAttr.trim()}];`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ── Plain format parser ───────────────────────────────────────────────────────

interface GvNode {
  id: string;
  cx: number; // center-x, inches, x=0 is left
  cy: number; // center-y, inches, y=0 is BOTTOM
  w:  number; // width, inches
  h:  number; // height, inches
}

interface GvEdge {
  tail:   string;
  head:   string;
  points: Array<{ x: number; y: number }>; // inches, y=0 is BOTTOM
}

interface GvPlain {
  graphH: number;    // total graph height in inches (for y-flip)
  nodes:  GvNode[];
  edges:  GvEdge[];
}

function parsePlain(plain: string): GvPlain {
  const nodes: GvNode[] = [];
  const edges: GvEdge[] = [];
  let graphH = 1;

  for (const raw of plain.split('\n')) {
    const line  = raw.trim();
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'graph': {
        // graph <scale> <width> <height>
        graphH = parseFloat(parts[3] ?? '1');
        break;
      }
      case 'node': {
        // node <name> <x> <y> <width> <height> <label> ...
        // Node names may be quoted — strip surrounding quotes
        const id = (parts[1] ?? '').replace(/^"|"$/g, '');
        nodes.push({
          id,
          cx: parseFloat(parts[2] ?? '0'),
          cy: parseFloat(parts[3] ?? '0'),
          w:  parseFloat(parts[4] ?? '1'),
          h:  parseFloat(parts[5] ?? '0.5'),
        });
        break;
      }
      case 'edge': {
        // edge <tail> <head> <n> <x1> <y1> <x2> <y2> ... [<label> <lx> <ly>] <style> <color>
        const tail = (parts[1] ?? '').replace(/^"|"$/g, '');
        const head = (parts[2] ?? '').replace(/^"|"$/g, '');
        const n    = parseInt(parts[3] ?? '0', 10);
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < n; i++) {
          pts.push({
            x: parseFloat(parts[4 + i * 2] ?? '0'),
            y: parseFloat(parts[5 + i * 2] ?? '0'),
          });
        }
        if (pts.length > 0) edges.push({ tail, head, points: pts });
        break;
      }
    }
  }

  return { graphH, nodes, edges };
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

/** Graphviz inch x → pixel x (no axis flip needed for x). */
function px(inchVal: number): number {
  return inchVal * GV_TO_PX;
}

/** Graphviz inch y (y=0 at bottom) → pixel y (y=0 at top). */
function py(inchY: number, graphH: number): number {
  return (graphH - inchY) * GV_TO_PX;
}

// ── Group bounding box computation ────────────────────────────────────────────

/**
 * Computes group bounding boxes bottom-up from the leaf-node positions.
 * Graphviz doesn't expose cluster bounds in `plain` format, so we derive
 * them the same way as ELK: wrap contained elements with GROUP_PAD + title bar.
 */
function computeGroupRects(
  diagram: Diagram,
  nodeMap: Map<string, LayoutRect>,
): Map<string, LayoutRect> {
  const result = new Map<string, LayoutRect>();
  const groupById = new Map(diagram.groups.map((g) => [g.id, g]));

  function boundsOf(groupId: string): LayoutRect | null {
    const g = groupById.get(groupId);
    if (!g) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasContent = false;

    for (const childId of g.children) {
      let r: LayoutRect | null = null;
      if (groupById.has(childId)) {
        r = boundsOf(childId);
      } else {
        r = nodeMap.get(childId) ?? null;
      }
      if (!r) continue;
      hasContent = true;
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }

    if (!hasContent) return null;

    const rect: LayoutRect = {
      x:      minX - GROUP_PAD,
      y:      minY - GROUP_PAD - GROUP_TITLE_H,
      width:  (maxX - minX) + GROUP_PAD * 2,
      height: (maxY - minY) + GROUP_PAD * 2 + GROUP_TITLE_H,
    };
    result.set(groupId, rect);
    return rect;
  }

  for (const rootId of diagram.roots) {
    if (groupById.has(rootId)) boundsOf(rootId);
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Lays out `diagram` using Graphviz's `dot` algorithm via WASM.
 * Returns a `LayoutResult` compatible with ELK's output format.
 *
 * Called by `runLayout()` in strategies.ts only after all ELK escalation
 * strategies are exhausted. Logs a console warning when invoked so developers
 * can observe fallback usage.
 */
export async function layoutWithGraphviz(
  diagram: Diagram,
  opts: LayoutOptions,
): Promise<LayoutResult> {
  // Dynamic import — the 780 KB WASM bundle is fetched only on first ELK failure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Graphviz } = await import('@hpcc-js/wasm-graphviz' as any);
  const gv = await (Graphviz as { load(): Promise<{ layout(d: string, f: string, e: string): string }> }).load();

  const dotSrc = buildDot(diagram, opts);

  let plainText: string;
  try {
    plainText = gv.layout(dotSrc, 'plain', 'dot');
  } catch (err) {
    throw new Error(
      `[Graphviz] layout failed: ${err instanceof Error ? err.message : String(err)}\n` +
      `DOT source:\n${dotSrc.slice(0, 400)}`,
    );
  }

  const { graphH, nodes: gvNodes, edges: gvEdges } = parsePlain(plainText);

  // ── Assemble LayoutResult ───────────────────────────────────────────────
  const result: LayoutResult = {
    nodes:  new Map(),
    groups: new Map(),
    edges:  new Map(),
    bbox:   { x: 0, y: 0, width: 0, height: 0 },
  };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  // Nodes
  for (const gvn of gvNodes) {
    const pxW  = px(gvn.w);
    const pxH  = px(gvn.h);
    const rect: LayoutRect = {
      x:      px(gvn.cx) - pxW / 2,
      y:      py(gvn.cy, graphH) - pxH / 2,
      width:  pxW,
      height: pxH,
    };
    result.nodes.set(gvn.id, rect);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  // Groups — derive bounding boxes from node positions
  const groupRects = computeGroupRects(diagram, result.nodes);
  for (const [id, rect] of groupRects) {
    result.groups.set(id, rect);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  // Edges — map Graphviz spline control points to LayoutEdge bend points.
  // The `plain` format doesn't guarantee matched tail/head node IDs when the
  // same pair has multiple edges, so we match by (tail, head) and assign to the
  // first unmatched IREdge for that pair.
  const usedEdgeIds = new Set<string>();
  for (const gve of gvEdges) {
    const pts = gve.points.map((p) => ({ x: px(p.x), y: py(p.y, graphH) }));
    if (pts.length < 2) continue;
    const irEdge = diagram.edges.find(
      (e) => e.source === gve.tail && e.target === gve.head && !usedEdgeIds.has(e.id),
    );
    if (!irEdge) continue;
    usedEdgeIds.add(irEdge.id);
    result.edges.set(irEdge.id, {
      id:     irEdge.id,
      source: gve.tail,
      target: gve.head,
      start:  pts[0]!,
      end:    pts[pts.length - 1]!,
      bends:  pts.slice(1, -1),
    });
  }

  // Bounding box
  if (isFinite(minX)) {
    result.bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  return result;
}
