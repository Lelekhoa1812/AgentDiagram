import React from 'react';
import { describe, expect, it } from 'vitest';
import type { Diagram } from '@/lib/ir/types';
import type { LayoutResult } from '@/lib/layout/elk';
import { buildScene } from '../svgScene';

const diagram: Diagram = {
  meta: { kind: 'flow', source: '' },
  groups: [],
  nodes: [
    {
      id: 'a',
      name: 'A',
      parentId: null,
      color: null,
      icon: null,
      label: null,
      width: null,
      height: null,
      shape: null,
      note: null,
    },
    {
      id: 'b',
      name: 'B',
      parentId: null,
      color: null,
      icon: null,
      label: null,
      width: null,
      height: null,
      shape: null,
      note: null,
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'fwd',
      label: null,
      color: null,
      style: null,
    },
  ],
  roots: ['a', 'b'],
  diagnostics: [],
};

const layout: LayoutResult = {
  nodes: new Map([
    ['a', { x: 0, y: 0, width: 100, height: 40 }],
    ['b', { x: 200, y: 0, width: 100, height: 40 }],
  ]),
  groups: new Map(),
  edges: new Map(),
  bbox: { x: 0, y: 0, width: 300, height: 40 },
};

function countDataKind(value: unknown, kind: string): number {
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countDataKind(child, kind), 0);
  if (!React.isValidElement(value)) return 0;

  const props = value.props as { children?: unknown; 'data-kind'?: string };
  const own = props['data-kind'] === kind ? 1 : 0;
  return own + countDataKind(props.children, kind);
}

describe('buildScene progressive routing', () => {
  it('skips missing pre-routed edges in progressive mode', () => {
    const scene = buildScene(diagram, layout, {
      preRoutedEdges: new Map(),
      missingPreRoutedEdge: 'skip',
    });

    expect(countDataKind(scene.layers, 'edge')).toBe(0);
  });

  it('keeps synchronous edge routing as the default for exports', () => {
    const scene = buildScene(diagram, layout, { preRoutedEdges: new Map() });

    expect(countDataKind(scene.layers, 'edge')).toBe(1);
  });
});
