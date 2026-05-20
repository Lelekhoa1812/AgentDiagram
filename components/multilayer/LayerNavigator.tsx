'use client';

import { useDiagramStore } from '@/lib/state/store';

export function LayerNavigator() {
  const ml = useDiagramStore((s) => s.multiLayer);
  const active = useDiagramStore((s) => s.activeLayer);
  const setActive = useDiagramStore((s) => s.setActiveLayer);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);

  if (!ml) return null;

  const select = (name: string, dsl: string) => {
    setActive(name);
    clearOverrides();
    setDsl(dsl);
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-ink-700 bg-ink-900 px-3 py-2">
      <span className="mr-2 shrink-0 text-[10px] uppercase tracking-widest text-ink-400">Layers</span>
      <button
        onClick={() => select('overview', ml.overview.dsl)}
        className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
          active === 'overview'
            ? 'border-accent/60 bg-accent/15 text-ink-100'
            : 'border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
        }`}
      >
        Overview
      </button>
      {ml.layers.map((l) => (
        <button
          key={l.name}
          onClick={() => select(l.name, l.dsl)}
          className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
            active === l.name
              ? 'border-accent/60 bg-accent/15 text-ink-100'
              : 'border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
          }`}
          title={l.description}
        >
          {l.name}
        </button>
      ))}
    </div>
  );
}
