'use client';

import { useDiagramStore } from '@/lib/state/store';
import flowExample from '../../examples/flow.txt';
import tinyExample from '../../examples/tiny-flow.txt';
import sequenceExample from '../../examples/sequence.txt';
import umlExample from '../../examples/uml.txt';

const EXAMPLES = [
  { label: 'SaaS Platform', value: flowExample as unknown as string, kind: 'architecture' },
  { label: 'Tiny Flow', value: tinyExample as unknown as string, kind: 'architecture' },
  { label: 'Sequence', value: sequenceExample as unknown as string, kind: 'sequence' },
  { label: 'UML', value: umlExample as unknown as string, kind: 'class' },
];

export function ExampleLoader() {
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clear = useDiagramStore((s) => s.clearOverrides);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="mr-1 text-[10px] uppercase tracking-[0.18em] text-ink-400">Examples</span>
      {EXAMPLES.map((ex) => (
        <button
          key={ex.label}
          onClick={() => {
            clear();
            setDsl(ex.value);
          }}
          className="surface-transition rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[11px] text-ink-200 hover:-translate-y-0.5 hover:border-accent/50 hover:text-ink-100"
          type="button"
        >
          {ex.label}
        </button>
      ))}
    </div>
  );
}
