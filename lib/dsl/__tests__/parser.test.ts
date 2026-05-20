import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from '../lexer';
import { parse } from '../parser';
import { compile } from '../compiler';

const FLOW = readFileSync(join(__dirname, '../../../examples/flow.txt'), 'utf8');

describe('lexer', () => {
  it('keeps identifiers with spaces and pipes intact', () => {
    const tokens = lex('Tables from DOCX | PDF [icon: table]');
    const idents = tokens.filter((t) => t.kind === 'IDENT');
    expect(idents[0]?.value).toBe('Tables from DOCX | PDF');
  });

  it('treats edge operators only when surrounded by whitespace', () => {
    const tokens = lex('A > B');
    expect(tokens.map((t) => t.kind)).toEqual(['IDENT', 'ARROW_FWD', 'IDENT', 'NEWLINE', 'EOF']);
  });

  it('recognises <>, --, => as edge operators', () => {
    const tokens = lex('A <> B\nC -- D\nE => F');
    const ops = tokens.filter((t) => ['ARROW_BI', 'EDGE_DASH', 'EDGE_FAT'].includes(t.kind));
    expect(ops.map((t) => t.value)).toEqual(['<>', '--', '=>']);
  });

  it('captures comments', () => {
    const tokens = lex('// hello\nA [color: blue]');
    expect(tokens[0]?.kind).toBe('COMMENT');
    expect(tokens[0]?.value).toBe('// hello');
  });
});

describe('parser', () => {
  it('parses a simple group with nested nodes', () => {
    const src = `Data Sources [color: orange, icon: file] {\n  PDF [icon: file]\n  DOCX [icon: file]\n}`;
    const { program, diagnostics } = parse(src);
    expect(diagnostics).toHaveLength(0);
    expect(program.statements).toHaveLength(1);
    const stmt = program.statements[0];
    expect(stmt?.type).toBe('group');
    if (stmt?.type === 'group') {
      expect(stmt.name).toBe('Data Sources');
      expect(stmt.body).toHaveLength(2);
    }
  });

  it('parses edges with labels', () => {
    const src = 'Schedule Merge > XLSX Patch: write';
    const { program, diagnostics } = parse(src);
    expect(diagnostics).toHaveLength(0);
    const edge = program.statements[0];
    expect(edge?.type).toBe('edge');
    if (edge?.type === 'edge') {
      expect(edge.source).toBe('Schedule Merge');
      expect(edge.target).toBe('XLSX Patch');
      expect(edge.op).toBe('>');
      expect(edge.label).toBe('write');
    }
  });

  it('parses bidirectional edges', () => {
    const { program } = parse('Progress <> Frontend');
    const edge = program.statements[0];
    expect(edge?.type).toBe('edge');
    if (edge?.type === 'edge') expect(edge.op).toBe('<>');
  });
});

describe('compiler', () => {
  it('compiles flow.txt without errors', () => {
    const diagram = compile(FLOW);
    const errors = diagram.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('produces expected counts for flow.txt', () => {
    const diagram = compile(FLOW);
    expect(diagram.groups.length).toBeGreaterThanOrEqual(13);
    expect(diagram.nodes.length).toBeGreaterThan(50);
    expect(diagram.edges.length).toBeGreaterThan(60);
  });

  it('preserves group hierarchy', () => {
    const diagram = compile(FLOW);
    const async = diagram.groups.find((g) => g.name === 'Async');
    expect(async).toBeDefined();
    expect(async?.parentId).toBeNull();
    expect(async?.children.length).toBeGreaterThan(0);

    const workers = diagram.groups.find((g) => g.name === 'Workers');
    expect(workers).toBeDefined();
    expect(workers?.parentId).toBe(async?.id);
  });

  it('resolves edges between groups and nodes', () => {
    const diagram = compile(FLOW);
    const stripe = diagram.edges.find((e) => {
      const s = diagram.nodes.find((n) => n.id === e.source) ?? diagram.groups.find((g) => g.id === e.source);
      const t = diagram.nodes.find((n) => n.id === e.target) ?? diagram.groups.find((g) => g.id === e.target);
      return s?.name === 'Stripe' && t?.name === 'Subscriptions';
    });
    expect(stripe).toBeDefined();
    expect(stripe?.kind).toBe('bi');
  });

  it('handles identifiers with | and &', () => {
    const src = `Tables from DOCX | PDF [icon: table] {\n  OCR Service [icon: scan]\n}\nQuality & Sanitize [icon: check-circle]\nFilled XLSX | CSV [icon: file-spreadsheet]`;
    const diagram = compile(src);
    const names = [
      ...diagram.groups.map((g) => g.name),
      ...diagram.nodes.map((n) => n.name),
    ];
    expect(names).toContain('Tables from DOCX | PDF');
    expect(names).toContain('Quality & Sanitize');
    expect(names).toContain('Filled XLSX | CSV');
  });
});
