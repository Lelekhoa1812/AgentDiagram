import { describe, expect, it } from 'vitest';
import { normalizeFileSummary } from '../analysis/summarizer';

describe('normalizeFileSummary', () => {
  it('clamps oversized provider arrays before strict validation', () => {
    const summary = normalizeFileSummary({
      role: 'Large route module',
      category: 'api',
      layer: 'service',
      exports: Array.from({ length: 25 }, (_, i) => `export${i}`),
      imports: Array.from({ length: 40 }, (_, i) => `import${i}`),
      surface: Array.from({ length: 35 }, (_, i) => `surface${i}`),
      external_deps: Array.from({ length: 25 }, (_, i) => `dep${i}`),
      side_effects: Array.from({ length: 20 }, (_, i) => `effect${i}`),
      notes: null,
    });

    expect(summary.exports).toHaveLength(20);
    expect(summary.imports).toHaveLength(30);
    expect(summary.surface).toHaveLength(25);
    expect(summary.external_deps).toHaveLength(20);
    expect(summary.side_effects).toHaveLength(15);
  });
});
