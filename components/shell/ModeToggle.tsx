'use client';

import { Bot, Code2, GalleryVerticalEnd, Layers3, Sparkles } from 'lucide-react';
import { useDiagramStore, type Mode } from '@/lib/state/store';

const MODES: Array<{ id: Mode; label: string; hint: string; icon: typeof Code2 }> = [
  { id: 'editor', label: 'Diagram Editor', hint: 'DSL → diagram', icon: Code2 },
  { id: 'code-space', label: 'Code Space', hint: 'Agentic coding workspace', icon: GalleryVerticalEnd },
  { id: 'agent', label: 'Single Layer', hint: 'Repo → single layer diagram', icon: Bot },
  { id: 'multi-layer', label: 'Multi Layer', hint: 'Repo → layered diagrams', icon: Layers3 },
  { id: 'custom-prompt', label: 'App Planner', hint: 'Describe → ask → diagram', icon: Sparkles },
];

export function ModeToggle() {
  const mode = useDiagramStore((s) => s.mode);
  const setMode = useDiagramStore((s) => s.setMode);
  const activeIdx = MODES.findIndex((m) => m.id === mode);
  const segmentWidth = 132;
  const offset = activeIdx * segmentWidth;

  return (
    <div className="relative inline-flex rounded-xl border border-ink-700 bg-ink-850 p-1 shadow-glow">
      <div
        className="pointer-events-none absolute bottom-1 top-1 rounded-lg bg-gradient-to-r from-accent/25 via-accent-cool/20 to-accent/25 transition-transform duration-300 ease-out"
        style={{ width: segmentWidth, transform: `translateX(${offset}px)`, boxShadow: '0 0 18px rgba(124,156,255,0.25)' }}
      />
      {MODES.map((m) => {
        const active = mode === m.id;
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`surface-transition relative z-10 flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap ${
              active ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200'
            }`}
            style={{ width: segmentWidth }}
            aria-pressed={active}
            title={m.hint}
          >
            <Icon size={15} />
            <span className={active ? 'font-semibold' : ''}>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
