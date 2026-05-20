import type { Token } from './lexer';

export interface SrcSpan {
  line: number;
  col: number;
  length: number;
}

export type PropValue = string | number | boolean;

export interface PropList {
  span: SrcSpan;
  /** Preserved in source order */
  entries: Array<{ key: string; value: PropValue; span: SrcSpan }>;
}

export interface NodeDecl {
  type: 'node';
  name: string;
  nameSpan: SrcSpan;
  props: PropList | null;
}

export interface GroupDecl {
  type: 'group';
  name: string;
  nameSpan: SrcSpan;
  props: PropList | null;
  body: Statement[];
}

export interface EdgeDecl {
  type: 'edge';
  source: string;
  target: string;
  sourceSpan: SrcSpan;
  targetSpan: SrcSpan;
  op: '>' | '<' | '<>' | '--' | '=>';
  opSpan: SrcSpan;
  label: string | null;
  props: PropList | null;
}

export interface CommentNode {
  type: 'comment';
  text: string;
  span: SrcSpan;
}

export type Statement = NodeDecl | GroupDecl | EdgeDecl | CommentNode;

export interface Program {
  statements: Statement[];
}

export function spanOf(t: Token): SrcSpan {
  return { line: t.line, col: t.col, length: t.length };
}
