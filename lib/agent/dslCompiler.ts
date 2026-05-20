/**
 * DiagramPlan → DSL string. Deterministic, programmatic — no LLM.
 */
import type { DiagramPlan } from './planner';

function fmtProps(entries: Array<[string, string]>): string {
  if (entries.length === 0) return '';
  return ` [${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}]`;
}

function edgeOp(kind: DiagramPlan['edges'][number]['kind']): string {
  switch (kind) {
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

export function planToDsl(plan: DiagramPlan): string {
  const lines: string[] = [];
  if (plan.title) lines.push(`// ${plan.title}`);
  lines.push('');

  const groupsByParent = new Map<string | null, DiagramPlan['groups']>();
  for (const g of plan.groups) {
    const arr = groupsByParent.get(g.parent) ?? [];
    arr.push(g);
    groupsByParent.set(g.parent, arr);
  }

  const nodesByParent = new Map<string | null, DiagramPlan['nodes']>();
  for (const n of plan.nodes) {
    const arr = nodesByParent.get(n.parent) ?? [];
    arr.push(n);
    nodesByParent.set(n.parent, arr);
  }

  function writeGroup(g: DiagramPlan['groups'][number], indent: number) {
    const pad = '  '.repeat(indent);
    lines.push(
      `${pad}${g.name}${fmtProps([
        ['color', g.color],
        ['icon', g.icon],
      ])} {`,
    );
    for (const child of g.children) {
      const childGroup = plan.groups.find((gg) => gg.name === child);
      if (childGroup) {
        writeGroup(childGroup, indent + 1);
        continue;
      }
      const childNode = plan.nodes.find((nn) => nn.name === child);
      if (childNode) {
        lines.push(
          `${'  '.repeat(indent + 1)}${childNode.name}${fmtProps([
            ['color', childNode.color],
            ['icon', childNode.icon],
          ])}`,
        );
      }
    }
    lines.push(`${pad}}`);
  }

  // Top-level groups
  for (const g of groupsByParent.get(null) ?? []) {
    writeGroup(g, 0);
    lines.push('');
  }

  // Orphan nodes (no parent and not yet emitted)
  const emittedNames = new Set<string>();
  function collectEmitted(g: DiagramPlan['groups'][number]) {
    for (const child of g.children) emittedNames.add(child);
    const subs = plan.groups.filter((gg) => g.children.includes(gg.name));
    for (const s of subs) collectEmitted(s);
  }
  for (const g of groupsByParent.get(null) ?? []) collectEmitted(g);

  for (const n of nodesByParent.get(null) ?? []) {
    if (emittedNames.has(n.name)) continue;
    lines.push(
      `${n.name}${fmtProps([
        ['color', n.color],
        ['icon', n.icon],
      ])}`,
    );
  }

  lines.push('');
  lines.push('// ==== Connections ====');
  for (const e of plan.edges) {
    const label = e.label ? `: ${e.label}` : '';
    lines.push(`${e.source} ${edgeOp(e.kind)} ${e.target}${label}`);
  }

  if (plan.uncertainties.length || plan.omitted.length) {
    lines.push('');
    lines.push('// ==== Notes ====');
    for (const u of plan.uncertainties) lines.push(`// uncertain: ${u}`);
    for (const o of plan.omitted) lines.push(`// omitted: ${o}`);
  }

  return lines.join('\n');
}
