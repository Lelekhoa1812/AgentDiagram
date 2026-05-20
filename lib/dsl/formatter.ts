/**
 * DSL formatter: pretty-print a Diagram back to canonical DSL text.
 *
 * Used by:
 *   - Inspector → "rewrite props in source" path
 *   - Agent pipeline → compile DiagramPlan → DSL string
 *
 * NOT used to round-trip user input — user comments and whitespace are
 * preserved by Monaco directly. This is a generator, not a reformatter.
 */

import type { Diagram, IREdge, IRGroup, IRNode } from '../ir/types';

function fmtPropValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function nodeProps(n: IRNode): string {
  const entries: Array<[string, unknown]> = [];
  if (n.color) entries.push(['color', n.color]);
  if (n.icon) entries.push(['icon', n.icon]);
  if (n.label) entries.push(['label', n.label]);
  if (n.width) entries.push(['width', n.width]);
  if (n.height) entries.push(['height', n.height]);
  if (n.shape) entries.push(['shape', n.shape]);
  if (n.note) entries.push(['note', n.note]);
  if (!entries.length) return '';
  return ` [${entries.map(([k, v]) => `${k}: ${fmtPropValue(v)}`).join(', ')}]`;
}

function groupProps(g: IRGroup): string {
  const entries: Array<[string, unknown]> = [];
  if (g.color) entries.push(['color', g.color]);
  if (g.icon) entries.push(['icon', g.icon]);
  if (g.label) entries.push(['label', g.label]);
  if (g.direction) entries.push(['direction', g.direction]);
  if (g.collapsed) entries.push(['collapsed', true]);
  if (g.padding && g.padding !== 24) entries.push(['padding', g.padding]);
  if (g.note) entries.push(['note', g.note]);
  if (!entries.length) return '';
  return ` [${entries.map(([k, v]) => `${k}: ${fmtPropValue(v)}`).join(', ')}]`;
}

function edgeOp(e: IREdge): string {
  switch (e.kind) {
    case 'fwd':
      return '>';
    case 'bwd':
      return '<';
    case 'bi':
      return '<>';
    case 'dashed':
      return '--';
    case 'thick':
      return '=>';
  }
}

export function formatDiagram(diagram: Diagram): string {
  const lines: string[] = [];
  const nodesById = new Map(diagram.nodes.map((n) => [n.id, n]));
  const groupsById = new Map(diagram.groups.map((g) => [g.id, g]));

  function writeNode(n: IRNode, indent: number) {
    lines.push(`${'  '.repeat(indent)}${n.name}${nodeProps(n)}`);
  }

  function writeGroup(g: IRGroup, indent: number) {
    const pad = '  '.repeat(indent);
    lines.push(`${pad}${g.name}${groupProps(g)} {`);
    for (const childId of g.children) {
      const child = groupsById.get(childId);
      if (child) {
        writeGroup(child, indent + 1);
      } else {
        const node = nodesById.get(childId);
        if (node) writeNode(node, indent + 1);
      }
    }
    lines.push(`${pad}}`);
  }

  for (const rootId of diagram.roots) {
    const g = groupsById.get(rootId);
    if (g) {
      writeGroup(g, 0);
    } else {
      const n = nodesById.get(rootId);
      if (n) writeNode(n, 0);
    }
    lines.push('');
  }

  if (diagram.edges.length) {
    lines.push('// ==== Connections ====');
    for (const e of diagram.edges) {
      const src = nodesById.get(e.source)?.name ?? groupsById.get(e.source)?.name ?? e.source;
      const tgt = nodesById.get(e.target)?.name ?? groupsById.get(e.target)?.name ?? e.target;
      const label = e.label ? `: ${e.label}` : '';
      lines.push(`${src} ${edgeOp(e)} ${tgt}${label}`);
    }
  }

  return lines.join('\n');
}
