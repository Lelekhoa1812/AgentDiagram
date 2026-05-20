'use client';

import { useDiagramStore } from '@/lib/state/store';
import type { IRNode } from '@/lib/ir/types';
import { hex } from '@/lib/ir/colors';
import { COLORS, ICONS, rewriteDeclProp } from './shared';

export function NodeInspector({ node }: { node: IRNode }) {
  const dsl = useDiagramStore((s) => s.dslText);
  const setDsl = useDiagramStore((s) => s.setDsl);

  const update = (key: string, value: string) => {
    setDsl(rewriteDeclProp(dsl, node.name, key, value));
  };

  return (
    <div className="space-y-4 p-4 text-xs">
      <header>
        <div className="text-[10px] uppercase tracking-widest text-ink-400">Node</div>
        <div className="font-mono text-sm text-ink-100">{node.name}</div>
      </header>

      <Field label="Color">
        <div className="grid grid-cols-8 gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => update('color', c)}
              className={`h-6 w-6 rounded border ${node.color === c ? 'ring-2 ring-accent' : 'border-ink-700'}`}
              style={{ background: hex(c) }}
              title={c}
            >
              <div
                className="h-full w-full rounded"
                style={{ boxShadow: `inset 0 0 0 12px ${hex(c)}` }}
              />
            </button>
          ))}
        </div>
      </Field>

      <Field label="Icon">
        <select
          value={node.icon ?? ''}
          onChange={(e) => update('icon', e.target.value)}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs"
        >
          <option value="">(none)</option>
          {ICONS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Label">
        <input
          defaultValue={node.label ?? ''}
          onBlur={(e) => update('label', e.target.value)}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1"
          placeholder="(uses name)"
        />
      </Field>

      <Field label="Shape">
        <select
          value={node.shape ?? 'rect'}
          onChange={(e) => update('shape', e.target.value)}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs"
        >
          <option value="rect">rect</option>
          <option value="class">class</option>
          <option value="participant">participant</option>
        </select>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">{label}</div>
      {children}
    </div>
  );
}
