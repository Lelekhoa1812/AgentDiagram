import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Diagram } from '@/lib/ir/types';
import type { LayoutResult } from '../elk';

const diagram: Diagram = {
  meta: { kind: 'flow', source: 'deadline-test' },
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
  ],
  edges: [],
  roots: ['a'],
  diagnostics: [],
};

const result: LayoutResult = {
  nodes: new Map([['a', { x: 0, y: 0, width: 100, height: 40 }]]),
  groups: new Map(),
  edges: new Map(),
  bbox: { x: 0, y: 0, width: 100, height: 40 },
};

describe('runLayout deadline propagation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../elk');
    vi.doUnmock('../graphviz');
    vi.resetModules();
  });

  it('passes remaining render budget to Graphviz fallback after ELK fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const graphviz = vi.fn().mockResolvedValue(result);

    vi.doMock('../elk', () => ({
      layout: vi.fn().mockRejectedValue(new Error('elk failed')),
      terminateElkWorker: vi.fn(),
    }));
    vi.doMock('../graphviz', () => ({
      layoutWithGraphviz: graphviz,
      prewarmGraphvizWasm: vi.fn(),
      terminateGraphvizWorker: vi.fn(),
    }));

    const { runLayout } = await import('../strategies');
    await expect(
      runLayout(diagram, 'auto', undefined, { deadlineMs: Date.now() + 1_234 }),
    ).resolves.toEqual(result);

    expect(graphviz).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1_234);
  });
});
