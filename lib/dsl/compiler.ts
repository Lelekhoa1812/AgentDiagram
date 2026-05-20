/**
 * AST → IR compiler.
 *
 * Responsibilities:
 *   - Slugify names into stable IDs (de-duped by suffix).
 *   - Walk groups recursively, preserving parent/child links.
 *   - Resolve edge endpoints by name; emit `info`-level diagnostics for
 *     missing endpoints rather than failing the whole compile.
 *   - Pull known properties into typed IR fields; preserve unknown props.
 */

import type {
  Diagram,
  Diagnostic,
  IREdge,
  IRGroup,
  IRNode,
  Meta,
  EdgeKind,
} from '../ir/types';
import { isColorName } from '../ir/types';
import {
  type Statement,
  type GroupDecl,
  type NodeDecl,
  type EdgeDecl,
  type PropList,
} from './ast';
import { parse } from './parser';

const KNOWN_NODE_PROPS = new Set([
  'color',
  'icon',
  'label',
  'width',
  'height',
  'shape',
  'note',
  'id',
]);

const KNOWN_GROUP_PROPS = new Set([
  'color',
  'icon',
  'label',
  'direction',
  'collapsed',
  'padding',
  'note',
  'id',
]);

const KNOWN_EDGE_PROPS = new Set(['color', 'style', 'label']);

interface Ctx {
  groups: IRGroup[];
  nodes: IRNode[];
  edges: IREdge[];
  diagnostics: Diagnostic[];
  byName: Map<string, string>; // name → id
  byId: Set<string>;
  edgeCounter: number;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\|/g, '-')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function ensureUniqueId(ctx: Ctx, base: string): string {
  let candidate = base || 'node';
  let i = 2;
  while (ctx.byId.has(candidate)) {
    candidate = `${base}-${i}`;
    i++;
  }
  ctx.byId.add(candidate);
  return candidate;
}

function propMap(props: PropList | null): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>();
  if (!props) return m;
  for (const e of props.entries) m.set(e.key, e.value);
  return m;
}

function asString(v: string | number | boolean | undefined): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

function asNumber(v: string | number | boolean | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function compileGroup(decl: GroupDecl, parentId: string | null, ctx: Ctx): IRGroup {
  const id = decl.props?.entries.find((e) => e.key === 'id')?.value;
  const baseId = id ? slugify(String(id)) : slugify(decl.name);
  const gid = ensureUniqueId(ctx, baseId);
  ctx.byName.set(decl.name, gid);

  const p = propMap(decl.props);
  const color = p.get('color');
  if (color !== undefined && !isColorName(color)) {
    ctx.diagnostics.push({
      message: `Unknown color "${color}" on group "${decl.name}"`,
      line: decl.nameSpan.line,
      column: decl.nameSpan.col,
      length: decl.nameSpan.length,
      severity: 'warning',
    });
  }

  const group: IRGroup = {
    id: gid,
    name: decl.name,
    parentId,
    color: isColorName(color) ? color : null,
    icon: asString(p.get('icon')),
    label: asString(p.get('label')),
    collapsed: p.get('collapsed') === true || p.get('collapsed') === 'true',
    direction:
      (asString(p.get('direction'))?.toUpperCase() as IRGroup['direction']) ?? null,
    padding: asNumber(p.get('padding')) ?? 24,
    children: [],
    note: asString(p.get('note')),
  };
  ctx.groups.push(group);

  for (const stmt of decl.body) {
    compileStatement(stmt, gid, ctx, group);
  }

  // Warn about unknown props (keep parsing)
  if (decl.props) {
    for (const entry of decl.props.entries) {
      if (!KNOWN_GROUP_PROPS.has(entry.key)) {
        ctx.diagnostics.push({
          message: `Unknown group property "${entry.key}"`,
          line: entry.span.line,
          column: entry.span.col,
          length: entry.span.length,
          severity: 'info',
        });
      }
    }
  }

  return group;
}

function compileNode(decl: NodeDecl, parentId: string | null, ctx: Ctx): IRNode {
  const p = propMap(decl.props);
  const explicitId = p.get('id');
  const baseId = explicitId ? slugify(String(explicitId)) : slugify(decl.name);
  const nid = ensureUniqueId(ctx, baseId);
  ctx.byName.set(decl.name, nid);

  const color = p.get('color');
  if (color !== undefined && !isColorName(color)) {
    ctx.diagnostics.push({
      message: `Unknown color "${color}" on node "${decl.name}"`,
      line: decl.nameSpan.line,
      column: decl.nameSpan.col,
      length: decl.nameSpan.length,
      severity: 'warning',
    });
  }

  const node: IRNode = {
    id: nid,
    name: decl.name,
    parentId,
    color: isColorName(color) ? color : null,
    icon: asString(p.get('icon')),
    label: asString(p.get('label')),
    width: asNumber(p.get('width')),
    height: asNumber(p.get('height')),
    shape: (asString(p.get('shape')) as IRNode['shape']) ?? null,
    note: asString(p.get('note')),
  };
  ctx.nodes.push(node);

  if (decl.props) {
    for (const entry of decl.props.entries) {
      if (!KNOWN_NODE_PROPS.has(entry.key)) {
        ctx.diagnostics.push({
          message: `Unknown node property "${entry.key}"`,
          line: entry.span.line,
          column: entry.span.col,
          length: entry.span.length,
          severity: 'info',
        });
      }
    }
  }

  return node;
}

function edgeKind(op: EdgeDecl['op']): EdgeKind {
  switch (op) {
    case '>':
      return 'fwd';
    case '<':
      return 'bwd';
    case '<>':
      return 'bi';
    case '--':
      return 'dashed';
    case '=>':
      return 'thick';
  }
}

function compileEdge(decl: EdgeDecl, ctx: Ctx): void {
  const sid = ctx.byName.get(decl.source);
  const tid = ctx.byName.get(decl.target);

  if (!sid) {
    ctx.diagnostics.push({
      message: `Unknown edge source "${decl.source}"`,
      line: decl.sourceSpan.line,
      column: decl.sourceSpan.col,
      length: decl.sourceSpan.length,
      severity: 'warning',
    });
  }
  if (!tid) {
    ctx.diagnostics.push({
      message: `Unknown edge target "${decl.target}"`,
      line: decl.targetSpan.line,
      column: decl.targetSpan.col,
      length: decl.targetSpan.length,
      severity: 'warning',
    });
  }
  if (!sid || !tid) return;

  const p = propMap(decl.props);
  const color = p.get('color');
  if (color !== undefined && !isColorName(color)) {
    ctx.diagnostics.push({
      message: `Unknown edge color "${color}"`,
      line: decl.opSpan.line,
      column: decl.opSpan.col,
      length: decl.opSpan.length,
      severity: 'warning',
    });
  }

  ctx.edgeCounter++;
  const edge: IREdge = {
    id: `e${ctx.edgeCounter}`,
    source: sid,
    target: tid,
    kind: edgeKind(decl.op),
    label: decl.label ?? asString(p.get('label')) ?? null,
    color: isColorName(color) ? color : null,
    style: (asString(p.get('style')) as IREdge['style']) ?? null,
  };
  ctx.edges.push(edge);

  if (decl.props) {
    for (const entry of decl.props.entries) {
      if (!KNOWN_EDGE_PROPS.has(entry.key)) {
        ctx.diagnostics.push({
          message: `Unknown edge property "${entry.key}"`,
          line: entry.span.line,
          column: entry.span.col,
          length: entry.span.length,
          severity: 'info',
        });
      }
    }
  }
}

function compileStatement(
  stmt: Statement,
  parentId: string | null,
  ctx: Ctx,
  parentGroup: IRGroup | null = null,
): void {
  switch (stmt.type) {
    case 'group': {
      const g = compileGroup(stmt, parentId, ctx);
      if (parentGroup) parentGroup.children.push(g.id);
      return;
    }
    case 'node': {
      const n = compileNode(stmt, parentId, ctx);
      if (parentGroup) parentGroup.children.push(n.id);
      return;
    }
    case 'edge':
      compileEdge(stmt, ctx);
      return;
    case 'comment':
      return;
  }
}

export function compile(source: string, sourceText?: string): Diagram {
  const { program, diagnostics: parseDiags } = parse(source);
  const ctx: Ctx = {
    groups: [],
    nodes: [],
    edges: [],
    diagnostics: [...parseDiags],
    byName: new Map(),
    byId: new Set(),
    edgeCounter: 0,
  };

  // Two passes: first, register all declarations (so edges can reference
  // forward declarations within groups); then resolve edges.
  function registerPass(stmts: Statement[], parentId: string | null, parentGroup: IRGroup | null) {
    for (const stmt of stmts) {
      if (stmt.type === 'group') {
        const g = compileGroup(stmt, parentId, ctx);
        if (parentGroup) parentGroup.children.push(g.id);
      } else if (stmt.type === 'node') {
        const n = compileNode(stmt, parentId, ctx);
        if (parentGroup) parentGroup.children.push(n.id);
      }
    }
  }

  // Single-pass compile preserving order; do declarations only first
  // by walking the tree.
  function declPass(stmts: Statement[], parentId: string | null, parentGroup: IRGroup | null) {
    for (const stmt of stmts) {
      if (stmt.type === 'group') {
        const p = propMap(stmt.props);
        const explicitId = p.get('id');
        const baseId = explicitId ? slugify(String(explicitId)) : slugify(stmt.name);
        const gid = ensureUniqueId(ctx, baseId);
        ctx.byName.set(stmt.name, gid);

        const color = p.get('color');
        const group: IRGroup = {
          id: gid,
          name: stmt.name,
          parentId,
          color: isColorName(color) ? color : null,
          icon: asString(p.get('icon')),
          label: asString(p.get('label')),
          collapsed: p.get('collapsed') === true || p.get('collapsed') === 'true',
          direction:
            (asString(p.get('direction'))?.toUpperCase() as IRGroup['direction']) ?? null,
          padding: asNumber(p.get('padding')) ?? 24,
          children: [],
          note: asString(p.get('note')),
        };
        ctx.groups.push(group);
        if (parentGroup) parentGroup.children.push(gid);

        if (color !== undefined && !isColorName(color)) {
          ctx.diagnostics.push({
            message: `Unknown color "${color}" on group "${stmt.name}"`,
            line: stmt.nameSpan.line,
            column: stmt.nameSpan.col,
            length: stmt.nameSpan.length,
            severity: 'warning',
          });
        }
        declPass(stmt.body, gid, group);
      } else if (stmt.type === 'node') {
        const p = propMap(stmt.props);
        const explicitId = p.get('id');
        const baseId = explicitId ? slugify(String(explicitId)) : slugify(stmt.name);
        const nid = ensureUniqueId(ctx, baseId);
        ctx.byName.set(stmt.name, nid);

        const color = p.get('color');
        const node: IRNode = {
          id: nid,
          name: stmt.name,
          parentId,
          color: isColorName(color) ? color : null,
          icon: asString(p.get('icon')),
          label: asString(p.get('label')),
          width: asNumber(p.get('width')),
          height: asNumber(p.get('height')),
          shape: (asString(p.get('shape')) as IRNode['shape']) ?? null,
          note: asString(p.get('note')),
        };
        ctx.nodes.push(node);
        if (parentGroup) parentGroup.children.push(nid);

        if (color !== undefined && !isColorName(color)) {
          ctx.diagnostics.push({
            message: `Unknown color "${color}" on node "${stmt.name}"`,
            line: stmt.nameSpan.line,
            column: stmt.nameSpan.col,
            length: stmt.nameSpan.length,
            severity: 'warning',
          });
        }
      }
    }
  }

  // Reset and run the proper two-pass compile
  ctx.groups = [];
  ctx.nodes = [];
  ctx.edges = [];
  ctx.byName.clear();
  ctx.byId.clear();
  declPass(program.statements, null, null);

  function edgePass(stmts: Statement[]) {
    for (const stmt of stmts) {
      if (stmt.type === 'edge') {
        compileEdge(stmt, ctx);
      } else if (stmt.type === 'group') {
        edgePass(stmt.body);
      }
    }
  }
  edgePass(program.statements);

  // Compute roots: things with no parent
  const roots: string[] = [];
  for (const g of ctx.groups) if (!g.parentId) roots.push(g.id);
  for (const n of ctx.nodes) if (!n.parentId) roots.push(n.id);

  // Re-introduce intentionally unused references for ESLint
  void registerPass;
  void compileStatement;

  const meta: Meta = {
    kind: 'flow',
    source: sourceText ?? source,
    generatedAt: Date.now(),
  };

  return {
    meta,
    groups: ctx.groups,
    nodes: ctx.nodes,
    edges: ctx.edges,
    roots,
    diagnostics: ctx.diagnostics,
  };
}
