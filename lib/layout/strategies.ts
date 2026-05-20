import type { Diagram } from '../ir/types';
import { layout, type LayoutOptions, type LayoutResult } from './elk';

export type LayoutStrategy = 'auto' | 'layered' | 'force-lite' | 'grid-cluster' | 'manual';

export async function runLayout(
  diagram: Diagram,
  strategy: LayoutStrategy,
  opts?: LayoutOptions,
): Promise<LayoutResult> {
  switch (strategy) {
    case 'auto':
      return diagram.nodes.length <= 50
        ? layout(diagram, { direction: 'DOWN', ...opts })
        : layout(diagram, { direction: 'DOWN', layerSpacing: 64, nodeNodeSpacing: 36, ...opts });
    case 'layered':
      return layout(diagram, { direction: 'DOWN', ...opts });
    case 'grid-cluster':
      return layout(diagram, { direction: 'DOWN', layerSpacing: 80, nodeNodeSpacing: 32, ...opts });
    case 'force-lite':
      // Fallback: still uses ELK but with looser layered settings
      return layout(diagram, { direction: 'DOWN', layerSpacing: 96, nodeNodeSpacing: 48, ...opts });
    case 'manual':
      // Manual: still run a layered pass to seed positions; overrides win later.
      return layout(diagram, { direction: 'DOWN', ...opts });
  }
}
