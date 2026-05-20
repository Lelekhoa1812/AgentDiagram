import { describe, it, expect } from 'vitest';
import { planToDsl } from '../dslCompiler';
import { compile } from '../../dsl/compiler';

describe('planToDsl', () => {
  it('produces parseable DSL from a minimal plan', () => {
    const dsl = planToDsl({
      title: 'tiny',
      groups: [
        { name: 'Frontend', color: 'sky', icon: 'monitor', children: ['UI'], parent: null },
      ],
      nodes: [{ name: 'UI', color: 'sky', icon: 'layout', parent: 'Frontend' }],
      edges: [],
      uncertainties: [],
      omitted: [],
    });
    const compiled = compile(dsl);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(compiled.groups.map((g) => g.name)).toContain('Frontend');
    expect(compiled.nodes.map((n) => n.name)).toContain('UI');
  });

  it('emits nested groups correctly', () => {
    const dsl = planToDsl({
      title: 'nested',
      groups: [
        { name: 'Outer', color: 'green', icon: 'folder', children: ['Inner', 'OrphanNode'], parent: null },
        { name: 'Inner', color: 'green', icon: 'folder', children: ['Child'], parent: 'Outer' },
      ],
      nodes: [
        { name: 'Child', color: 'green', icon: 'file', parent: 'Inner' },
        { name: 'OrphanNode', color: 'green', icon: 'file', parent: 'Outer' },
      ],
      edges: [{ source: 'Child', target: 'OrphanNode', kind: 'fwd' }],
      uncertainties: [],
      omitted: [],
    });
    const compiled = compile(dsl);
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const outer = compiled.groups.find((g) => g.name === 'Outer');
    const inner = compiled.groups.find((g) => g.name === 'Inner');
    expect(inner?.parentId).toBe(outer?.id);
    expect(compiled.edges).toHaveLength(1);
  });
});
