'use client';

import { useDiagramStore } from '@/lib/state/store';
import type { IREdge } from '@/lib/ir/types';

export function EdgeInspector({ edge }: { edge: IREdge }) {
  const diagram = useDiagramStore((s) => s.diagram);
  const setOverride = useDiagramStore((s) => s.setOverride);
  const overrides = useDiagramStore((s) => s.overrides);

  const sourceName = diagram?.nodes.find((n) => n.id === edge.source)?.name ?? diagram?.groups.find((g) => g.id === edge.source)?.name ?? edge.source;
  const targetName = diagram?.nodes.find((n) => n.id === edge.target)?.name ?? diagram?.groups.find((g) => g.id === edge.target)?.name ?? edge.target;

  const hasOverride = !!overrides.edges[edge.id]?.bends?.length;

  return (
    <div className="space-y-4 p-4 text-xs">
      <header>
        <div className="text-[10px] uppercase tracking-widest text-ink-400">Edge</div>
        <div className="font-mono text-sm text-ink-100">
          {sourceName} <span className="text-accent">{edgeSymbol(edge.kind)}</span> {targetName}
        </div>
      </header>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Kind</div>
        <div className="text-ink-300">{edge.kind}</div>
      </div>

      {edge.label && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Label</div>
          <div className="text-ink-300">{edge.label}</div>
        </div>
      )}

      <button
        className="rounded border border-ink-700 bg-ink-900 px-2 py-1 hover:bg-ink-800"
        disabled={!hasOverride}
        onClick={() => setOverride('edges', edge.id, { bends: [] })}
      >
        Clear bend points
      </button>

      <div className="rounded border border-ink-700 bg-ink-900 p-2 text-[11px] text-ink-400">
        Tip: edit edge source / target by changing the DSL line directly.
      </div>
    </div>
  );
}

function edgeSymbol(kind: IREdge['kind']): string {
  switch (kind) {
    case 'fwd':
      return '→';
    case 'bwd':
      return '←';
    case 'bi':
      return '↔';
    case 'dashed':
      return '⇢';
    case 'thick':
      return '⇒';
  }
}
