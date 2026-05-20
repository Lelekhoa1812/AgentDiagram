'use client';

import type { ReactNode } from 'react';
import { useDiagramStore } from '@/lib/state/store';
import { NodeInspector } from './NodeInspector';
import { GroupInspector } from './GroupInspector';
import { EdgeInspector } from './EdgeInspector';

export function InspectorPanel() {
  const selection = useDiagramStore((s) => s.selection);
  const diagram = useDiagramStore((s) => s.diagram);

  if (!selection.id || !diagram) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader />
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-ink-400">
          No selection
        </div>
      </div>
    );
  }

  if (selection.kind === 'node') {
    const node = diagram.nodes.find((n) => n.id === selection.id);
    if (node) return <InspectorShell><NodeInspector node={node} /></InspectorShell>;
  }
  if (selection.kind === 'group') {
    const group = diagram.groups.find((g) => g.id === selection.id);
    if (group) return <InspectorShell><GroupInspector group={group} /></InspectorShell>;
  }
  if (selection.kind === 'edge') {
    const edge = diagram.edges.find((e) => e.id === selection.id);
    if (edge) return <InspectorShell><EdgeInspector edge={edge} /></InspectorShell>;
  }

  return null;
}

function InspectorShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <PanelHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function PanelHeader() {
  return (
    <div className="flex h-12 items-center border-b border-ink-700 bg-ink-850 px-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400">Inspector</div>
        <div className="text-xs text-ink-300">Properties</div>
      </div>
    </div>
  );
}
