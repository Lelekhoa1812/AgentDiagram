import { describe, expect, it } from 'vitest';
import { compile } from '../../dsl/compiler';
import { overviewDslFromCatalog } from '../planning/multilayer';
import type { LayerCatalog } from '../planning/planner';

describe('overviewDslFromCatalog', () => {
  it('produces parseable overview DSL with stable sanitized names', () => {
    const catalog: LayerCatalog = {
      layers: [
        {
          name: 'API: Gateway',
          description: 'Routes and request boundaries',
          color: 'sky',
          icon: 'server',
          member_files: ['app/api/users/route.ts', 'app/api/admin/route.ts'],
          representative_files: ['app/api/users/route.ts', 'app/api/admin/route.ts'],
          external_deps: [],
          boundary_deps: ['Services'],
        },
        {
          name: 'Services',
          description: 'Domain logic',
          color: 'green',
          icon: 'workflow',
          member_files: ['lib/service/user.ts', 'lib/service/user.tsx'],
          representative_files: ['lib/service/user.ts', 'lib/service/user.tsx'],
          external_deps: [],
          boundary_deps: ['Data'],
        },
        {
          name: 'Data',
          description: 'Persistence',
          color: 'purple',
          icon: 'database',
          member_files: ['lib/data/db.ts'],
          representative_files: ['lib/data/db.ts'],
          external_deps: [],
          boundary_deps: [],
        },
      ],
      cross_layer_edges: [
        { source: 'API: Gateway', target: 'Services', kind: 'fwd', label: 'HTTP: request' },
        { source: 'Services', target: 'Data', kind: 'fwd', label: 'read/write' },
        { source: 'Unknown', target: 'Data', kind: 'dashed', label: 'ignored' },
      ],
    };

    const dsl = overviewDslFromCatalog(catalog);
    const compiled = compile(dsl);

    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compiled.groups.map((g) => g.name)).toContain('API Gateway');
    expect(compiled.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['User', 'User 2']));
    expect(compiled.edges).toHaveLength(2);
  });
});
